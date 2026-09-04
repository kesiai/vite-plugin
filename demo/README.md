# @kesi/vite-plugin demo

一个用于本地验证插件效果的 React 19 + Vite 5 最小项目。

## 目录约定（与插件要求一致）

```
demo/
├── pages/            # 页面组件（必须位于项目根目录 = demo/，不在 src/ 内）
│   ├── dashboard/Dashboard.tsx
│   └── users/Users.tsx
├── components/       # 可复用组件（不在 pages/ 下，不会被注入 data-node-id）
├── src/              # 应用壳（main.tsx / App.tsx / 浏览器端解码器）
├── index.html
└── vite.config.ts    # 引入 kesi() 插件
```

## 运行

```bash
cd demo
npm install        # 若离线环境，见下方“离线运行”
npm run dev        # http://localhost:5199
```

插件会随 dev server 启动（日志前缀 `[@kesi/vite-plugin]`）：
- 对 `pages/` 下的 `.tsx/.jsx` 编译期注入 `data-node-id`
- 在 `http://localhost:5199/__editor/*` 提供 API

## 可以验证什么

1. **data-node-id 注入**：页面元素悬停出现虚线框（CSS 里按 `[data-node-id]` 高亮），点击后在左侧面板看到该 DOM 节点对应的源码定位（文件 + 起止标签行列）。
2. **组件目录差异**：`pages/` 下元素有 id，`components/` 下（如 Clock）没有 —— 插件只转换 pages 目录。
3. **HTTP API**：左侧按钮可调 `/__editor/components`（扫描结果）、`/__editor/ui`（展示路由）、`/__editor/status`、`/__editor/file`（pages 文件列表）、`/__editor/package-json`、`/__editor/plugin-check`。

或命令行直接验证：

```bash
curl http://localhost:5199/__editor/status
curl http://localhost:5199/__editor/components
# 页面模块经过 transform 后应包含 node- 开头的 data-node-id：
curl http://localhost:5199/pages/dashboard/Dashboard.tsx | grep -o 'data-node-id="node-[^"]*"' | head
```

## 离线运行（无网络时）

demo 的 node_modules 未提交；在断网环境可用 pnpm store 符号链接补齐（react / react-dom / vite 及
`@kesi/vite-plugin -> ../..` 软链），再执行 `npm run dev`。本仓库根目录的 pnpm store 已含所需版本。
