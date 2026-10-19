import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { PageTranslationSession } from '../src/page/session';
import {
  type EngineEnsureResult,
  type EngineRequest,
  isEngineEvent,
  isPageRequest,
} from '../src/shared/protocol';
import { Panel } from '../src/ui/Panel';
import panelCss from '../src/ui/panel.css?inline';

const KEY = '__gemmaTranslateV2';

export default defineUnlistedScript(() => {
  // 重复注入 = 同一个页面会话；监听器只挂一次。
  if ((window as any)[KEY]) return;

  // ── 悬浮面板：Shadow DOM 隔离页面样式 ──
  const host = document.createElement('div');
  host.id = 'gemma-translate-panel-host';
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '18px', 'important');
  host.style.setProperty('right', '18px', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('display', 'block', 'important');
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  // 用 constructable stylesheet，避免往页面里插 <style> 被页面 CSP 拦掉。
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(panelCss);
  shadow.adoptedStyleSheets = [sheet];

  const mount = document.createElement('div');
  shadow.appendChild(mount);
  const root = createRoot(mount);

  let visible = false;
  let session!: PageTranslationSession;

  const render = () => {
    session.setFloatHidden(visible);
    root.render(
      <Panel
        session={session}
        visible={visible}
        onClose={() => {
          visible = false;
          render();
        }}
      />,
    );
  };

  session = new PageTranslationSession({
    doc: document,

    async ensureEngine(): Promise<EngineEnsureResult> {
      const r = (await browser.runtime.sendMessage({ to: 'bg', type: 'engine:ensure' })) as any;
      return r?.data ?? { ok: false, error: r?.error ?? '引擎不可用' };
    },

    sendEngine(msg: EngineRequest) {
      return browser.runtime.sendMessage(msg);
    },

    onFloatClick() {
      visible = true;
      render();
    },
  });

  const toggle = () => {
    visible = !visible;
    render();
  };

  // 测试缝：下一个 agent 可以用它直接开关面板，不必点工具栏。
  (window as any)[KEY] = {
    session,
    toggle,
    show: () => {
      visible = true;
      render();
    },
    hide: () => {
      visible = false;
      render();
    },
  };

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isEngineEvent(msg)) {
      session.handleEngineEvent(msg);
      return;
    }
    if (isPageRequest(msg) && msg.type === 'panel:toggle') {
      toggle();
      sendResponse({ ok: true });
    }
  });

  render(); // 初始隐藏，等图标点击
});
