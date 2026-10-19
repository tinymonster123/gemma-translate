# gemma-translate

本地 Gemma 4 整页翻译 Chrome 扩展：WXT + React + TypeScript。点工具栏图标，页面内出现 Shadow DOM 悬浮面板，由 offscreen document 里的 transformers.js 加载模型并逐段翻译。

## 常用命令

- `npm run compile` — TypeScript 类型检查
- `npm test` — Vitest 纯逻辑单测
- `npm run build` — 构建到 `.output/chrome-mv3`
- `npm run probe` — 端到端验证（34 项，需要本机 Chrome + 3.2GB 模型）
- `npm run perf` — 分阶段性能基线（cold / cache / warm，同上的环境要求）
- `npm run lint` / `npm run format` — Biome

## 硬约束

- 模型不能进扩展包：`chrome-extension://` 读 ≥1 GiB 会让 Chrome 主进程崩。
- 推理只能在 offscreen document：MV3 service worker 禁止动态 `import()`。
- wasm 走 `public/ort/` 稳定路径，不从 CDN 拉。
- 面板样式走 constructable stylesheet，不往页面里插 `<style>`。
- 面板预热只在 `modelCached` 为 true 后触发；首次使用不得因打开面板就下载 3GB。

架构与实测数据见 `README.md`；端到端判读见 `.claude/skills/verify-translate-flow/SKILL.md`。

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo (use `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
