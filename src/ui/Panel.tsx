import { useEffect, useState } from 'react';
import type { PageTranslationSession } from '../page/session';
import { baseLangCode, defaultTargetCode } from '../shared/language';
import { type SessionState, TARGET_LANGUAGES, targetByCode } from '../shared/protocol';
import { getSettings, setSetting } from '../shared/settings';

export interface PanelProps {
  session: PageTranslationSession;
  visible: boolean;
  onClose: () => void;
}

/** 页面内悬浮面板。和 PageTranslationSession 同处一个上下文，直接订阅状态。 */
export function Panel({ session, visible, onClose }: PanelProps) {
  const [state, setState] = useState<SessionState>(() => session.getState());
  const [probe, setProbe] = useState(() => session.probe());
  const [targetCode, setTargetCode] = useState(() => defaultTargetCode(probe.language));
  const [touched, setTouched] = useState(false);
  const [savedTarget, setSavedTarget] = useState<string | null>(null);

  useEffect(() => session.subscribe(setState), [session]);

  // 面板一打开就后台预热；订阅已经建立，preloading 状态能正常渲染。
  useEffect(() => {
    if (!visible) return;
    void session.preload();
  }, [visible, session]);

  useEffect(() => {
    void getSettings()
      .then((s) => setSavedTarget(s.targetLanguage))
      .catch(() => {});
  }, []);

  // 面板每次打开都重新探测：页面可能滚动、路由切换、DOM 变了。
  useEffect(() => {
    if (!visible) return;
    setProbe(session.probe());
  }, [visible, session]);

  useEffect(() => {
    if (!visible || touched) return;
    const saved =
      savedTarget && baseLangCode(savedTarget) !== probe.language.code ? savedTarget : null;
    setTargetCode(saved ?? defaultTargetCode(probe.language));
  }, [visible, touched, savedTarget, probe]);

  // 会话已经在跑时，目标语言以会话为准。
  useEffect(() => {
    if (state.target) setTargetCode(state.target.code);
  }, [state.target]);

  if (!visible) return null;

  const target = targetByCode(targetCode);
  const phase = state.phase;
  const busy = phase === 'loading' || phase === 'translating';
  const progress = state.total ? `${state.done}/${state.total}` : '';
  // 会话一旦开始，段数以会话为准：重开面板时 probe 会跳过已翻段落，
  // 直接用 probe.blockCount 会显示 0。
  const detectedCount = phase !== 'idle' && state.total ? state.total : probe.blockCount;

  const statusText = (() => {
    if (phase === 'idle' && state.preloading) return '模型预热中…';
    if (phase === 'loading') {
      return state.enginePercent != null
        ? `下载模型 ${Math.round(state.enginePercent)}%`
        : '加载模型…';
    }
    if (phase === 'translating') return `${progress} 段 · 正在翻译`;
    if (phase === 'done') return state.total ? `已翻译 ${state.total} 段` : '没有可翻的段落';
    if (phase === 'stopped') return '已停止';
    if (phase === 'error') return state.message ?? '翻译失败';
    return `检测到 ${detectedCount} 个可翻段落`;
  })();

  const ctaLabel = busy
    ? `停止翻译${progress ? ` ${progress}` : ''}`
    : phase === 'done'
      ? '还原原文'
      : phase === 'stopped'
        ? '继续翻译'
        : '翻译';

  const onCta = () => {
    if (busy) return session.stop();
    if (phase === 'done') return session.restore();
    void session.start(target);
  };

  const onTargetChange = (code: string) => {
    setTargetCode(code);
    setTouched(true);
    void setSetting('targetLanguage', code).catch(() => {});
  };

  return (
    <div className="gt-panel">
      <div className="gt-panel-head">
        <div>
          <div className="gt-panel-title">Gemma 翻译</div>
          <div className="gt-panel-subtitle">本地推理 · 页面内容不上传</div>
        </div>
        <button type="button" className="gt-panel-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="gt-pills">
        <div className="gt-pill gt-source">
          <div className="gt-pill-main">{probe.language.label}</div>
          <div className="gt-pill-sub">自动检测 · {detectedCount} 段</div>
        </div>

        <span className="gt-to">→</span>

        <label className="gt-pill gt-target">
          <select
            value={targetCode}
            disabled={busy}
            onChange={(e) => onTargetChange(e.target.value)}
            aria-label="目标语言"
          >
            {TARGET_LANGUAGES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="gt-chev">▾</span>
        </label>
      </div>

      <div className="gt-service">
        <div className="gt-service-row">
          <span className="gt-label">翻译服务</span>
          <span className="gt-value">
            <span className="gt-gem" /> 本地 Gemma 4
          </span>
          <span className="gt-chev">▾</span>
        </div>
        <div className="gt-hint">当前固定为本地模型；多服务路由下一版接</div>
      </div>

      <div className="gt-status">
        <span>{statusText}</span>
        {phase === 'stopped' && (
          <button type="button" className="gt-link" onClick={() => session.restore()}>
            还原原文
          </button>
        )}
        {phase === 'error' && <span className="gt-error-dot" />}
      </div>

      <button type="button" className="gt-cta" onClick={onCta}>
        <span>{ctaLabel}</span>
        {!busy && phase !== 'done' && <kbd>⌥⇧U</kbd>}
      </button>
    </div>
  );
}
