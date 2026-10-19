import type { Plugin } from 'vite';
import { defineConfig } from 'wxt';

/**
 * onnxruntime-web 会把 wasm 作为打包资源再 emit 一份；我们已经从
 * public/ort/ 提供稳定路径，所以把这份重复的 26MB 删掉。
 */
function dropBundledOrtWasm(): Plugin {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_options, bundle) {
      for (const key of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(key)) delete bundle[key];
      }
    },
  };
}

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [dropBundledOrtWasm()],
  }),
  manifest: {
    name: 'Gemma Translate',
    description:
      '本地 Gemma 整页翻译：点插件图标，在每段底部插入译文。首次使用下载模型到本机缓存，之后推理全程离线。',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'offscreen', 'storage', 'unlimitedStorage'],
    host_permissions: ['https://hf-mirror.com/*', 'https://huggingface.co/*', 'https://*.hf.co/*'],
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+U', mac: 'Alt+Shift+U' },
        description: '翻译当前页面',
      },
    },
    action: {
      default_title: '整页翻译（本地 Gemma）',
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
