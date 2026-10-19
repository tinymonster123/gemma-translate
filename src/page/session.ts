import { baseLangCode, defaultTarget, pageLanguage } from '../shared/language';
import type {
  EngineEnsureResult,
  EngineEvent,
  EngineRequest,
  PageProbeResult,
  SessionState,
  TargetLanguage,
} from '../shared/protocol';
import { isModelCached, markModelCached } from '../shared/settings';
import { type Block, collectBlocks, shouldInsertInside, themeOf } from './blocks';
import { FloatView } from './float';

export interface SessionDeps {
  doc: Document;
  /** 让 background 确保 offscreen 存在并把配置转发进去；不等待模型加载 */
  ensureEngine: () => Promise<EngineEnsureResult>;
  /** 页面直接和 offscreen 说话（ensure / translate） */
  sendEngine: (msg: EngineRequest) => Promise<any>;
  /** 浮标点击：打开悬浮面板（面板和会话在同一个上下文） */
  onFloatClick: () => void;
}

const IDLE: SessionState = { phase: 'idle', done: 0, total: 0 };

export class PageTranslationSession {
  private state: SessionState = { ...IDLE };
  private pending = new Map<number, { el: HTMLElement; buf: string }>();
  private seq = 0;
  private cancelled = false;
  private reqId = `gt-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  private target: TargetLanguage | null = null;
  private float: FloatView | null = null;
  private floatHidden = false;
  private listeners = new Set<(state: SessionState) => void>();
  private preloadInFlight: Promise<void> | null = null;

  constructor(private deps: SessionDeps) {}

  getState(): SessionState {
    return { ...this.state };
  }

  /** 面板直接订阅会话状态；不需要跨上下文消息。 */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 面板打开时后台预热。
   *
   * 只有成功加载过模型（modelCached）才做，避免第一次打开面板就无提示下 3GB。
   * 预热包含模型加载 + 一次 1-token 推理，把模型加载和首段 session/着色器
   * 初始化都移出「点击翻译」这条路径。
   */
  preload(): Promise<void> | null {
    if (this.preloadInFlight) return this.preloadInFlight;
    if (this.state.phase !== 'idle') return null;

    let p: Promise<void>;
    p = this.doPreload().finally(() => {
      if (this.preloadInFlight === p) this.preloadInFlight = null;
    });
    this.preloadInFlight = p;
    return p;
  }

  private async doPreload(): Promise<void> {
    try {
      if (!(await isModelCached())) return;

      const ready = await this.deps
        .sendEngine({ to: 'engine', type: 'ping' })
        .then((r) => !!r?.ready)
        .catch(() => false);
      if (ready) return;

      this.setState({ ...this.state, preloading: true });

      const ens = await this.deps.ensureEngine().catch((e) => ({
        ok: false,
        error: String(e),
      }));
      if (!ens?.ok) return;

      const loaded = await this.deps
        .sendEngine({ to: 'engine', type: 'ensure' })
        .catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }));
      if (!loaded?.ok) return;

      await markModelCached().catch(() => {});
      await this.deps.sendEngine({ to: 'engine', type: 'warmup' }).catch(() => {});
    } catch (e) {
      console.warn('[gemma-translate] 预热失败:', e);
    } finally {
      if (this.state.preloading) this.setState({ ...this.state, preloading: false });
    }
  }

  /** 面板打开时隐藏浮标，关闭后恢复。 */
  setFloatHidden(hidden: boolean): void {
    this.floatHidden = hidden;
    this.float?.setHidden(hidden);
  }

  /** 只读探测：popup 打开时用，不会插节点、不会开跑。 */
  probe(): PageProbeResult {
    const language = pageLanguage(this.deps.doc);
    const target = defaultTarget(language);
    const blocks = collectBlocks(this.deps.doc, baseLangCode(target.code));
    return {
      url: location.href,
      title: this.deps.doc.title,
      language,
      blockCount: blocks.length,
      session: this.getState(),
    };
  }

  async start(target: TargetLanguage): Promise<SessionState> {
    if (this.state.phase === 'loading' || this.state.phase === 'translating') {
      return this.getState();
    }

    this.target = target;
    this.cancelled = false;
    this.pending.clear();
    this.ensureFloat();
    this.setState({
      phase: 'loading',
      done: 0,
      total: 0,
      target,
      enginePercent: null,
      message: undefined,
    });
    this.float?.set('准备引擎…', true);

    // 面板打开时可能已经在后台预热；等它结束，避免 warmup 和第一段推理并发。
    if (this.preloadInFlight) await this.preloadInFlight;
    if (this.cancelled) return this.stop();

    // 1) background 确保 offscreen 存在，并把 modelHost 转发进去
    const ens = await this.deps.ensureEngine().catch((e) => ({ ok: false, error: String(e) }));
    if (!ens?.ok) return this.fail(ens?.error ?? '引擎不可用');
    if (this.cancelled) return this.stop();

    // 2) 页面直接请求 offscreen 加载模型（长任务，不占 SW 的生命周期）
    this.float?.set('加载模型…', true);
    const loaded = (await this.deps.sendEngine({ to: 'engine', type: 'ensure' }).catch((e) => ({
      ok: false,
      error: String((e as Error)?.message ?? e),
    }))) as EngineEnsureResult;
    if (!loaded?.ok) return this.fail(loaded?.error ?? '模型加载失败');
    void markModelCached().catch(() => {});
    if (this.cancelled) return this.stop();

    // 3) 逐段串行翻译；chunk 只是提前显示
    const blocks = collectBlocks(this.deps.doc, baseLangCode(target.code));
    this.setState({
      phase: 'translating',
      done: 0,
      total: blocks.length,
      target,
      enginePercent: null,
    });
    this.float?.set(blocks.length ? `0/${blocks.length}` : '没有可翻的段落', true);

    if (!blocks.length) {
      this.setState({ phase: 'done', done: 0, total: 0, target, message: '没有可翻的段落' });
      this.float?.set('没有可翻的段落');
      return this.getState();
    }

    for (let i = 0; i < blocks.length; i++) {
      if (this.cancelled) return this.stop();

      const block = blocks[i]!;
      const holder = this.mountHolder(block);
      const seq = ++this.seq;
      const pending = { el: holder, buf: '' };
      this.pending.set(seq, pending);
      this.float?.set(`${i + 1}/${blocks.length}`, true);

      let result: any;
      try {
        result = await this.deps.sendEngine({
          to: 'engine',
          type: 'translate',
          reqId: this.reqId,
          seq,
          text: block.text,
          target: target.prompt,
        });
      } catch (e) {
        result = { ok: false, error: String((e as Error)?.message ?? e) };
      }
      this.pending.delete(seq);

      if (result?.ok) {
        holder.textContent = result.text;
        holder.dataset.gtState = 'done';
        holder.title = `${result.chunks} 块 · ${result.ms}ms`;
      } else {
        holder.textContent = `（翻译失败：${result?.error ?? '未知错误'}）`;
        holder.dataset.gtState = 'error';
      }

      this.setState({ ...this.state, done: i + 1, total: blocks.length });
    }

    this.setState({ phase: 'done', done: blocks.length, total: blocks.length, target });
    this.float?.set('已翻译 · 点此还原');
    return this.getState();
  }

  stop(): SessionState {
    this.cancelled = true;
    this.pending.clear();
    this.setState({ phase: 'stopped', target: this.target, message: '已停止' });
    this.float?.set('已停止 · 点此继续');
    return this.getState();
  }

  restore(): SessionState {
    this.cancelled = true;
    this.pending.clear();
    for (const node of this.deps.doc.querySelectorAll('[data-gt]')) node.remove();
    this.target = null;
    this.setState({
      phase: 'idle',
      done: 0,
      total: 0,
      target: null,
      enginePercent: null,
      preloading: false,
      message: undefined,
    });
    this.float?.set('译');
    return this.getState();
  }

  /** 由页面入口把 from:'engine' 广播转进来。 */
  handleEngineEvent(msg: EngineEvent): void {
    if (msg.type === 'status' && msg.state === 'loading' && this.state.phase === 'loading') {
      const text =
        msg.percent != null && msg.file ? `下载 ${Math.round(msg.percent)}%` : '加载模型…';
      this.float?.set(text, true);
      this.setState({ ...this.state, enginePercent: msg.percent ?? null });
      return;
    }

    if (msg.type === 'chunk' && msg.reqId === this.reqId) {
      const pending = this.pending.get(msg.seq);
      if (!pending) return;
      pending.buf += msg.delta;
      pending.el.textContent = pending.buf;
      pending.el.dataset.gtState = 'streaming';
    }
  }

  private fail(message: string): SessionState {
    this.setState({ phase: 'error', target: this.target, message: String(message).slice(0, 400) });
    this.float?.set('引擎异常 · 点此重试');
    return this.getState();
  }

  private setState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private ensureFloat(): void {
    if (this.float || !this.deps.doc.documentElement) return;
    this.float = new FloatView(this.deps.doc, () => this.deps.onFloatClick());
    this.float.setHidden(this.floatHidden);
  }

  private mountHolder(block: Block): HTMLElement {
    const holder = this.deps.doc.createElement('div');
    holder.className = `gt-block ${themeOf(block.el)}`;
    holder.setAttribute('data-gt', '1');
    holder.dataset.gtState = 'pending';
    if (shouldInsertInside(block.el)) block.el.appendChild(holder);
    else block.el.insertAdjacentElement('afterend', holder);
    return holder;
  }
}
