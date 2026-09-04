# @kesi/vite-plugin

一个面向 React 项目的 Vite 开发插件：在开发模式下为 JSX 注入**可溯源定位的 `data-node-id`**，并提供组件扫描、文件读写、依赖安装等 HTTP API（挂载于 `/__editor/*`），配合 Canvas 预览实现"可视化点选 → 源码精确定位 → AI 修改"的开发闭环。

> ⚠️ 仅在开发模式（`vite serve`）下生效，不影响生产构建。

## 功能特性

### 1. data-node-id 源码定位标记（编译期注入）

开发模式下，插件用 Babel AST 转换，为每个 JSX 元素的开标签自动注入 `data-node-id`。它不是随机的自增 id，而是**可解码的源码位置信息**：

```
data-node-id = "node-" + base64url( JSON )
```

解码后的 JSON（`NodeSourceSpan`）包含元素在源码中的精确跨度：

| 字段 | 含义 |
|---|---|
| `file` | 相对项目根目录的源码路径（POSIX 分隔符，无前导 `/`） |
| `startLine` / `startCol` | 起始标签 `<tag` 的行号（1 起）与列号（0 起） |
| `endLine` / `endCol` | 结束标签 `</tag>` 的起始行列（自闭合元素取标签自身结束位置） |

**示例**

转换前：

```tsx
export function Dashboard() {
  return (
    <div className="p-4">Dashboard</div>
  );
}
```

转换后（`id` 为示意，实际是 base64url）：

```tsx
export function Dashboard() {
  return (
    <div className="p-4" data-node-id="node-eyJmaWxlIjoicGFnZXMvZGFzaGJvYXJkL0Rhc2hib2FyZC50c3giLCJzdGFydExpbmUiOjMsInN0YXJ0Q29sIjo0LCJlbmRMaW5lIjo1LCJlbmRDb2wiOjN9">Dashboard</div>
  );
}
```

**解码**（插件导出 `decodeNodeId`）：

```js
import { decodeNodeId } from '@kesi/vite-plugin';

const id = el.dataset.nodeId;          // 从 DOM 上取到
const span = decodeNodeId(id);
// => { file: 'pages/dashboard/Dashboard.tsx', startLine: 3, startCol: 4, endLine: 5, endCol: 3 }
// 拿到后即可在源码中打开 file，按 start~end 的跨度修改代码/属性
```

**设计目的**：编辑器 / AI 工具拿到任意 DOM 节点后，解码即可定位到源码中该组件/元素的起止标签，从而精确修改代码与属性。注意列号遵循 Babel AST 约定（0 起、按 UTF-16 码元计数），行号 1 起。

### 2. 组件扫描

- 启动时扫描项目根目录下的 `.tsx/.jsx`，识别 React 组件定义（函数声明 / 箭头函数 / 函数表达式 / `React.forwardRef`）
- 页面组件限定在 `pages/` 目录（相对于项目根目录，不在 `src` 内）
- 文件变化（HMR / 文件 API 写入）时自动重扫，保证 API 数据与磁盘一致

### 3. HTTP API（开发服务器内嵌）

以 `/__editor/*` 提供 REST 接口，完整端点见下方 [API 参考](#api-参考)。

### 4. 可视化预览

宿主项目提供 `/Canvas.tsx` 入口时，访问 `__editor_canvas` / `__editor_preview` 路径可进入画布模式：iframe 点选高亮、`postMessage` 通知选中/拖拽、`NODE_DRAG_END` 上报位移

## 安装

```bash
npm install @kesi/vite-plugin -D
```

## 使用

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import kesi from '@kesi/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    kesi({
      enableNodeIds: true,        // 启用 data-node-id 注入（默认：true）
      rootDir: undefined,         // 项目根目录（默认：vite root）
      pagesDir: 'pages',          // 页面目录（默认：'pages'）
      componentsDir: 'components' // 组件目录（默认：'components'）
    })
  ]
})
```

### 项目结构要求

```
project-root/
├── pages/              # 页面组件目录（必须位于项目根目录，不在 src 内）
│   ├── dashboard/
│   │   └── Dashboard.tsx
│   └── users/
│       └── Users.tsx
├── blocks/             # （可选）其他组件目录
├── src/
│   └── App.tsx
├── vite.config.ts
└── package.json
```

## API 参考

| API 路径 | 方法 | 功能 |
|---|---|---|
| `/__editor/components` | GET | 获取所有组件的扫描信息（名称/dataCode/文件/行号） |
| `/__editor/ui` | GET | 获取页面组件及展示路由列表 |
| `/__editor/routers` | GET / POST | 获取 / 更新路由配置文件状态 |
| `/__editor/status` | GET | 获取 dev server 运行状态 |
| `/__editor/file` | GET | 页面文件列表（递归 `pages/`） |
| `/__editor/file` | POST | 文件操作，`action` 为 `read` / `save` / `create` |
| `/__editor/file` | DELETE | 删除页面文件（body: `{pageName}`） |
| `/__editor/plugin-check` | GET | 插件状态自检 |
| `/__editor/package-json` | GET | 读取宿主 package.json 依赖信息（含 `hasKesiClient`） |
| `/__editor/install-package` | POST | 安装 npm 包（SSE 流式输出） |
| `/__editor/install-shadcn` | POST | 安装 shadcn/ui 组件（SSE 流式输出） |
| `/__editor/install-client` | POST | 安装 `@kesi/client`（SSE 流式输出） |
| `/__editor/init-config` | POST | 生成 `kesi.config.ts`（写入 projectId） |
| `/__editor/modify-code` | POST | 按组件名找到文件并应用修改 |
| `/__editor/build` | POST | 执行 `npm run build`（SSE 流式输出） |

### 文件 API 约定

`pageName` 为相对 `pages/` 目录的路径（可含子目录，如 `dashboard/Dashboard`，可带或不带扩展名）：

```bash
# 读取
curl http://localhost:5173/__editor/file \
  -H "Content-Type: application/json" \
  -d '{"action":"read","pageName":"dashboard/Dashboard"}'

# 保存（覆盖）
curl http://localhost:5173/__editor/file \
  -H "Content-Type: application/json" \
  -d '{"action":"save","pageName":"dashboard/Dashboard","content":"..."}'

# 创建
curl http://localhost:5173/__editor/file \
  -H "Content-Type: application/json" \
  -d '{"action":"create","pageName":"dashboard/NewPage"}'

# 删除
curl -X DELETE http://localhost:5173/__editor/file \
  -H "Content-Type: application/json" \
  -d '{"pageName":"dashboard/OldPage"}'
```

### modify-code 修改类型

- `append`: 文件末尾追加
- `prepend`: 文件开头插入
- `insert`: 在指定 `line`（1 起）插入 `content`
- `replace`: 用正则 `search` 全局替换为 `replace`

## 工作原理

### 代码转换（data-node-id）

1. Vite `transform` 钩子命中开发模式 + `pages/` 下的 `.tsx/.jsx`
2. `@babel/parser` 解析为 AST
3. 遍历每个 `JSXElement`，取开标签起始位置与结束标签起始位置（自闭合元素取自身结束位置）
4. `encodeNodeId()` 序列化为 base64url 字符串注入 `data-node-id`
5. `@babel/generator` 重新生成代码（保留行列与注释）

**优点**：编译时完成零运行时开销；真实 DOM 属性，`querySelector('[data-node-id^="node-"]')` / `element.dataset.nodeId` 均可访问。

### 组件扫描

正则逐行识别组件定义（组件名须大写开头），维护内存缓存并在文件变化时重扫。

## 注意事项

1. **仅开发模式**：`command === 'serve'` 时才转换 / 挂载 API，不影响生产构建
2. **仅限本地开发**：API 未做鉴权且可写文件、执行构建，请勿将 dev server 暴露到公网
3. **目录要求**：`pages/` 目录位于项目根目录
4. **Canvas 宿主**：画布模式需要宿主项目提供 `/Canvas.tsx`（通常从 `@kesi/vite-plugin/canvas` 引入再按需包装）
5. **id 有效期**：`data-node-id` 编码的是注入时的源码位置；文件被编辑后 DOM 会随 HMR 重新渲染并携带新 id

## 开发

```bash
# 安装依赖
npm install

# 构建（tsup 产出 JS + tsc 产出 .d.ts）
npm run build

# 监听模式（仅 JS，d.ts 需完整 build 或单独跑 tsc --watch）
npm run dev

# 类型检查
npm run typecheck
```

## 导出

| 导出 | 说明 |
|---|---|
| `kesiPlugin` / 默认导出 / `kesi()` | Vite 插件入口 |
| `PluginOptions` | 插件配置类型 |
| `ComponentScanner` / `ComponentData` / `ScanResult` | 组件扫描器 |
| `encodeNodeId` / `decodeNodeId` / `nodeIdToSpan` / `isNodeId` / `NodeSourceSpan` | data-node-id 编解码 |
| `@kesi/vite-plugin/canvas` | 浏览器端预览画布组件 |

## 许可证

MIT
