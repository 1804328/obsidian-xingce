# 参与贡献

欢迎提 Issue、PR，或分享你的真题笔记整理经验。

## 开发环境

```bash
npm install
npm run dev        # 监听模式，改完自动重新打包到 main.js
npm run build      # 生产构建（tsc 类型检查 + esbuild 打包）
```

把仓库里的 `main.js` / `manifest.json` / `styles.css` 复制到你的 Obsidian 仓库
`.obsidian/plugins/obsidian-xingce/` 即可本地调试。

## 测试

```bash
npm test           # 逻辑层：索引/筛选/抽题单元/正文回填
npm run test:ui    # 视图层：jsdom 上真实挂载视图走完作答流程
npm run test:all   # 上面两个一起跑
npm run verify     # 全量解析校验（对你的真题笔记跑）
npm run shoot      # 真实 Chromium 渲染截图，确认 UI 没问题
```

## 代码约定

- `src/parser.ts` 刻意**不依赖任何 Obsidian API**，方便在 Node 端直接校验，改动后务必跑测试。
- 题库笔记的解析结果里**不得包含任何受版权保护的真题原文**，仓库示例均为原创。
- 提交前请确保 `npm run test:all` 全绿。

## 提 PR

1. fork 后开分支，分支名随意（如 `fix/xxx`、`feat/xxx`）。
2. 填好 PR 模板里的自查清单。
3. 我们会在 CI 通过后 review。
