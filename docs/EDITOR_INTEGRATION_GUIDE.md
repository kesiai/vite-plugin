# 基于 @kesi/vite-plugin 的完整 React 组件编辑器 —— 集成实现指南

> 目标读者：在独立 Web 服务（编辑器宿主）上实现“可视化 React 组件编辑器”的 AI agent / 工程师。
> 编辑器不直接修改用户源码，而是：
> ① 通过 **iframe 嵌入** 目标项目的页面（该页面由 vite dev server 运行并已启用本插件）；
> ② 向 iframe 文档 **注入一段客户端脚本**（点击捕获、高亮、坐标上报）；
> ③ 直接调用插件的 **/__editor REST API** 做读写（页面/节点/schema/属性/children/增删/撤销…）。

---

## 0. 总览与关键前提

### 0.1 架构

```
┌───────────────────────────────────────────────────────────────────┐
│ 编辑器宿主（单独 web server，端口如 3000）                            │
│   - 左侧面板：页面列表 / 元素树 / 属性编辑 / 组件库 / 历史 / 源码视图     │
│   - 通过 fetch 调用目标 vite dev server 的 /__editor/* API（跨源 OK）  │
│   - 右侧：<iframe src="/rest/apps/dev/<page>">（经代理同源）        │
└──────────────┬──────────────────────────────┬──────────────────────┘
               │ postMessage（双向）           │ HTTP（CORS: *）
               ▼                              ▼
┌────────────────────────────────────┐   ┌─────────────────────────────┐
│ iframe 内页面（vite dev 5173）       │   │ 目标 dev server 5173          │
│ 编辑器直接向 iframe 注入 editor-client │   │ · 编译期给 pages JSX 注入       │
│   · 点选上报 nodeId + 元素矩形        │   │   data-node-id               │
│   · 自绘高亮外框                     │   │ · /__editor/* REST API        │
│   · HMR 后自动重建事件                │   │ · 写文件 -> Vite HMR 热更新     │
└────────────────────────────────────┘   └─────────────────────────────┘
```

### 0.2 前提
- 目标项目已安装并启用 `@kesi/vite-plugin`（`vite.config.ts`），`pages/` 位于项目根；
- 目标 dev server 已启动（本文示例端口 5173），`/__editor/*` 可用且返回 CORS `*`；
- **推荐同源化**：外层 vite 把页面代理到 `/rest/apps/dev/*`、API 代理到 `/rest/apps/editor/*`
  （见 §0.5），编辑器与 iframe 同源 → 编辑器可直接向 iframe 注入脚本、无跨域限制；
  仅在无法代理时才退回跨域 + 目标端注入（§2 兜底）。
- 概念：每个可编辑单元是一个 **node**，DOM 上以 `data-node-id`（`node-` + base64url，内含文件与行列）标记。
  **不再注入 name/file**：节点组件名、组件文件一律通过 `GET /__editor/node/{nodeId}` 获取。

### 0.3 一份最小可用的目标页面
```tsx
// 目标项目 pages/dashboard/Dashboard.tsx（示例）
import { Button } from '../src/components/ui/button';

export default function Dashboard() {
  return (
    <div className="p-8">
      <h1>设备总览</h1>
      <Button variant="primary">添加设备</Button>
    </div>
  );
}
```
启动目标 vite dev 后：
```bash
curl http://localhost:5173/__editor/status                      # 插件就绪
curl "http://localhost:5173/__editor/pages/dashboard/Dashboard/tree"
```

---

### 0.5 连接模式与「vite 同源代理」（推荐给外层编辑器）

如果编辑器与目标 dev server 分开启动（不同源），有两个选择：

1. **直连 + CORS（跨域）**：/__editor API 自带 `Access-Control-Allow-Origin:*`；iframe 内交互靠 postMessage。
   简单但某些环境限制多。
2. **vite proxy 同源化（推荐，解决跨域）**：外层编辑器把两类流量都代理到自己源上：

| 外层请求 | 代理动作 | 语义 |
|---|---|---|
| `/rest/apps/dev/{pageRouter}` | → 目标页面 `/` 前缀（见下） | 页面 iframe 与页面资源 |
| `/rest/apps/editor/{path}` | → `/__editor/{path}` | 插件 REST API（去掉 `__editor`） |

示例：
- iframe src：`http://localhost:3000/rest/apps/dev/dashboard/Dashboard`（**不需要任何编辑模式查询参数**）
- API 调用：`fetch('/rest/apps/editor/node/node-...')` → 实际打到 `/__editor/node/node-...`
- 编辑器与 iframe、API 完全同源（3000），无 CORS、无跨源 postMessage 限制。

**页面资源前缀的关键约束（务必读）**
目标 vite 页面 HTML 内部的资源引用是**绝对路径**（`/src/main.tsx`、`/@vite/client`…），
仅把页面入口 rewrite 过去是不够的。让这些资源也同源化，最省事的是：
**目标 dev server 用与代理一致的前缀作为 vite `base` 启动**：

```ts
// 目标项目 vite.config.ts（由编辑器使用者约定）
export default defineConfig({
  base: process.env.EDITOR_PROXY_BASE || '/',
  // ...plugins 不变
});
```
```bash
# 启动目标（vite 会以该 base 生成页面内所有资源与 HMR ws 前缀）
EDITOR_PROXY_BASE=/rest/apps/dev/ npm run dev
```
此时外层代理对 `/rest/apps/dev` 采取**透传（不 rewrite）**，页面、`/src/*`、`/@vite/*`、
HMR WebSocket（`ws:true`）全部自洽。配置文件示例见
[`docs/examples/editor-host.vite.config.ts`](./examples/editor-host.vite.config.ts)；
若目标不方便改 base，示例内也给了“入口 rewrite”的兜底写法，但此时 HMR 不可用，
编辑器每次写盘后需主动 `iframe.reload()`。

**编辑器代码的适配（同源代理下）**
```ts
const API_BASE = '/rest/apps/editor';            // 同源相对路径
async function api<T>(path: string, ...) {
  const res = await fetch(`${API_BASE}${path}`, ...);
}
// iframe 使用代理前缀
const pageUrl = `${location.origin}/rest/apps/dev/${pageName}`; // 同源页面，无特殊查询参数
```

## 1. 页面加载与 iframe 嵌入

### 1.1 取页面列表
```js
// 编辑器侧
const { pages } = await fetch(`${API_BASE}/pages`).then(r => r.json());
// pages = [{ name: 'dashboard/Dashboard', path: '/abs/.../pages/dashboard/Dashboard.tsx' }, ...]
```
注意：`name` 里可能带子目录。嵌入时用 `/pages/{name}` 拼页面地址（无需扩展名）：
```js
const pageName = 'dashboard/Dashboard';
const url = `${location.origin}/rest/apps/dev/${pageName}`; // 同源代理页面
```

### 1.2 iframe 宿主（React 示例）
```tsx
function Canvas({ pageName }: { pageName: string }) {
  return (
    <iframe
      src={`/rest/apps/dev/${pageName}`}
      onLoad={handleReady}
      className="h-full w-full border-0 bg-white"
      style={{ pointerEvents: 'auto' }}
    />
  );
}
```
要点：
- 同源代理模式下**不需要任何编辑模式查询参数**：编辑器在 `load` 后直接向 iframe 注入客户端脚本（见 §2）。
- 切换页面 = 换 iframe `src`（保留同一个 iframe），每次 `load` 后重新注入并等 `EDITOR_READY`。
- 切换页面 = 换 iframe `src`（保留同一个 iframe 便于注入脚本只加载一次也可，但每次 `src` 变更后要等 `load` 事件重发 READY）。

---

## 2. 向 iframe 注入编辑器客户端脚本（同源：编辑器直接注入）

在同源代理模式下（iframe 页面走 `/rest/apps/dev/*`），iframe 文档与编辑器**同源**，
编辑器可以直接操作 iframe 的 `contentDocument` / `contentWindow`：把 editor-client 作为
一段 `<script>` 插入 iframe 文档即可完成“注入”

### 2.1 注入方式（React 示例）

```tsx
function Canvas({ pageName }: { pageName: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const injectClient = () => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!win || !doc) return;

    // 每个 iframe 重新 load（含整页 reload）后重新注入
    if (doc.getElementById('__kesi_editor_client')) return;
    const script = doc.createElement('script');
    script.id = '__kesi_editor_client';
    script.textContent = EDITOR_CLIENT_SOURCE; // 字符串形式的客户端代码（见 2.3）
    (doc.head || doc.documentElement).appendChild(script);
  };

  return (
    <iframe
      ref={iframeRef}
      src={`/rest/apps/dev/${pageName}`}
      onLoad={injectClient}
      className="h-full w-full border-0 bg-white"
    />
  );
}
```

要点：
- 只要 iframe 与编辑器同源，`contentDocument` 可直接访问；`<script>` 插入后即为 iframe 文档内执行的代码。
- 每个 `load`（含写盘后 HMR 整页 reload）都要重新注入：要么用上面 id 去重，要么每次都重建。
- 也可以用 `win.eval(EDITOR_CLIENT_SOURCE)` 之类的等价方式，但 `<script>` 更规范。
- 若整个编辑器不依赖 HMR（写盘后 `iframe.reload()`），则每次 reload 都会触发 `load` → 重新注入，最简单可靠。

### 2.2 直接把客户端代码放到编辑器工程里

```ts
// editorHost/iframeClient.ts（编辑器侧导出“注入用源码字符串”）
export const EDITOR_CLIENT_SOURCE = `
(function () {
  const PARENT = window.parent;
  const post = (payload) => PARENT.postMessage(payload, location.origin);

  // ……点选 / 高亮 / MutationObserver 逻辑，见下……

  post({ type: 'EDITOR_READY', url: location.href, title: document.title });
})();
`;
```
发布构建时该字符串会打进编辑器 bundle，注入零网络请求。

### 2.3 editor-client 参考实现（插到 iframe 里的代码）

职责：捕获点击 → 上报 `nodeId` + 元素矩形；自绘高亮；MutationObserver / 重绘；接收父窗口指令。

```js
(function () {
  const PARENT = window.parent;
  const post = (payload) => PARENT.postMessage(payload, location.origin);

  let selectedId = null;
  let boxEl = null;

  function ensureOverlay() {
    if (boxEl && boxEl.isConnected) return boxEl;
    boxEl = document.createElement('div');
    Object.assign(boxEl.style, {
      position: 'absolute', zIndex: 2147483000, pointerEvents: 'none',
      border: '2px solid #3b82f6', background: 'rgba(59,130,246,.08)',
      display: 'none', borderRadius: '6px', left: '0', top: '0',
    });
    document.body.appendChild(boxEl);
    return boxEl;
  }

  function place(box) {
    ensureOverlay();
    Object.assign(boxEl.style, {
      left: box.x + 'px', top: box.y + 'px',
      width: box.width + 'px', height: box.height + 'px',
      display: 'block',
    });
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    return {
      x: r.left - body.left + window.scrollX,
      y: r.top - body.top + window.scrollY,
      width: r.width, height: r.height,
    };
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-node-id]');
    if (!el) return;
    selectedId = el.dataset.nodeId;
    place(rectOf(el));
    post({ type: 'NODE_CLICKED', nodeId: selectedId, rect: rectOf(el) });
  }, true);

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'EDITOR_CLEAR') { selectedId = null; if (boxEl) boxEl.style.display = 'none'; }
    if (m.type === 'EDITOR_HIGHLIGHT') {
      const el = document.querySelector('[data-node-id="' + CSS.escape(m.nodeId) + '"]');
      if (el) { place(rectOf(el)); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  });

  // 写盘/HMR 导致 DOM 被替换时自动重绘
  let raf = false;
  const redraw = () => {
    raf = false;
    if (!selectedId) return;
    const el = document.querySelector('[data-node-id="' + CSS.escape(selectedId) + '"]');
    if (el) place(rectOf(el));
  };
  new MutationObserver(() => {
    if (!raf) { raf = true; requestAnimationFrame(redraw); }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-node-id'] });

  post({ type: 'EDITOR_READY', url: location.href, title: document.title });
})();
```

### 2.4 跨域直连模式（不推荐，仅兜底）

当目标 dev server 无法代理、必须跨域直连 iframe 时，父页面无法直接操作 iframe DOM，
只能由“目标端”注入同源脚本（如 URL 带 `?kesi_editor=1` 时插件在 HTML 注入客户端脚本）。
功能一致但依赖目标端插件扩展与查询参数，**代理同源化后不再需要**；此文档不再展开。

### 2.5 消息协议总表（与注入方式无关，两种模式通用）

iframe → 父窗口（client 内 `parent.postMessage`）：

| type | payload | 说明 |
|---|---|---|
| `EDITOR_READY` | `{url,title}` | iframe 加载/重载完成（同源模式下可在此时重拉页面树） |
| `NODE_CLICKED` | `{nodeId, rect}` | 用户点选元素 |
| `NODE_HOVERED`(可选) | `{nodeId, rect}` | 拖拽落点 / 悬停高亮 |

父窗口 → iframe（`iframe.contentWindow.postMessage`）：

| type | payload | 说明 |
|---|---|---|
| `EDITOR_CLEAR` | – | 清除高亮 |
| `EDITOR_HIGHLIGHT` | `{nodeId}` | 程序化选中：高亮并滚动到节点 |

> 同源模式下也可以不依赖消息：直接调用 client 暴露到 `iframe.contentWindow.__kesiEditor` 的
> `select(nodeId)` / `clear()` 等函数。保留 postMessage 协议的好处是：将来若退回跨域模式，编辑器代码不用改。

## 3. API 客户端封装

建议编辑器内维护一个带 base 的 fetch 封装。**默认使用 vite 同源代理**（§0.5），
此时 API 与编辑器同源，无 CORS：

```ts
// lib/editorApi.ts（编辑器侧）
// 模式1（推荐）：同源代理 —— /rest/apps/editor/{path} 由 vite proxy 转发为 /__editor/{path}
const BASE = '/rest/apps/editor';
// 模式2（跨域直连兜底，需 /__editor 允许跨源）：把上面一行换成
// const BASE = 'http://127.0.0.1:5173/__editor';

async function api<T>(path: string, body?: unknown, method: 'GET'|'POST'|'DELETE' = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success || json.error) {
    const e = json.error || {};
    throw new Error(`[${e.code || 'ERROR'}] ${e.message || res.status}`);
  }
  return json.data;
}

export const Pages = {
  list: () => api('/pages'),
  content: (p: string) => api(`/pages/${p}`),
  saveContent: (p: string, content: string) => api(`/pages/${p}/content`, { content }, 'POST'),
  tree: (p: string) => api(`/pages/${p}/tree`),
  history: (p: string) => api(`/pages/${p}/history`),
  undo: (p: string) => api(`/pages/${p}/undo`, {}, 'POST'),
  redo: (p: string) => api(`/pages/${p}/redo`, {}, 'POST'),
  create: (path: string, template?: string) => api('/pages', { path, template }, 'POST'),
  remove: (p: string) => api(`/pages/${p}`, undefined, 'DELETE'),
};

export const NodeApi = {
  get: (id: string) => api(`/node/${id}`),
  schema: (id: string) => api(`/node/${id}/schema`),
  setProps: (id: string, props: PropChange[]) => api(`/node/${id}/props`, { props }, 'POST'),
  setTextChildren: (id: string, text: string) => api(`/node/${id}/children/text`, { text }, 'POST'),
  addChild: (id: string, comp: { nodeName: string; nodeFile: string; props?: PropChange[] }) =>
    api(`/node/${id}/children`, comp, 'POST'),
  remove: (id: string) => api(`/node/${id}`, undefined, 'DELETE'),
};
export type PropChange = { name: string; type?: 'expr'; value?: unknown; expr?: string; ast?: unknown; remove?: boolean };
```

### 错误约定
- 失败响应 `{ success:false, error:{ code, message, detail? } }`；UI 应展示 `code: message`。
- 常见：`NODE_NOT_FOUND`（文件被改动，请重新点选）、`CHILDREN_HAS_ELEMENTS`（该节点含 JSX 子元素，不能整段替换文本）、`INVALID_EXPRESSION`（表达式解析失败）、`IMPORT_CONFLICT`、`NO_HISTORY` 等。

---

## 4. 编辑流程的分模块实现

### 4.1 选择与高亮
1. iframe 内点击 → 客户端发 `NODE_CLICKED {nodeId,rect}`；
2. 父窗口保存 `selected = { nodeId }` → 立即拉取 `NodeApi.get(nodeId)`（含 tag、componentName、componentFile、props、children、source、ast、canEditText）；
3. 右侧属性面板渲染；需要 schema 的组件再 `NodeApi.schema(nodeId)`；
4. 父窗口可随时 `postMessage(EDITOR_HIGHLIGHT)` 让 iframe 内高亮跟随（比如面板中选择 children 时）。

```tsx
// 父窗口监听
useEffect(() => {
  const onMsg = (e: MessageEvent) => {
    const m = e.data || {};
    if (m.type === 'NODE_CLICKED') select(m.nodeId);
    if (m.type === 'EDITOR_READY') refreshTree();
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}, []);

async function select(nodeId: string) {
  try { setNode(await NodeApi.get(nodeId)); } catch (err) { toast(err.message, 'error'); }
}
```

### 4.2 属性编辑（含表达式）
- 读取：`NodeApi.get(id).props` 返回 `[{name, kind:'literal'|'boolean'|'expression'|'spread', value?, valueText?, ast?}]`；
- schema（若组件）：`NodeApi.schema(id).properties` 提供 `type`、`enum options`、`defaultValue`、`required` 等，用于生成表单；
- 保存：整批 `POST /node/{id}/props`，每次写盘前自动进撤销历史。

```tsx
// 保存（值模式：值 / 表达式）
const changes: PropChange[] = [];
for (const [name, val] of Object.entries(form)) {
  if (mode[name] === 'expr') {
    changes.push(val === '' ? { name, remove: true } : { name, type: 'expr', value: val });
  } else {
    changes.push({ name, value: coerce(val, schema[name]) });
  }
}
await NodeApi.setProps(nodeId, changes);
```

表达式属性写入语义（服务端已实现）：
- `{ name, type:'expr', value:'() => save()' }` → 解析成 AST 再包 `{<expr>}` 写回；
- `{ name, type:'expr', value: {type:'ObjectExpression', ...} }` → AST JSON 直插；
- 服务端会先解析校验，非法表达式返回 `INVALID_EXPRESSION` 且不改文件。

### 4.3 children 编辑
- `NodeApi.get(id).children`：元素子节点 `{kind:'element', nodeId, tag, componentName, componentFile}`；文本 `{kind:'text', text}`；
- `canEditText=true` 时允许把 children 当纯文本编辑 → `POST /node/{id}/children/text`，body `{text}`（空串=清空并转自闭合）；
- 含元素子节点时列表展示，支持：
  - 下钻：选中 `child.nodeId` 继续编辑；
  - 删除：`DELETE /node/{childNodeId}`；
  - 插入：见 §4.4。

### 4.4 添加组件（组件库 + 两种插入方式）
1. 组件目录：`GET /__editor/components`（返回 name/filePath/…），过滤本地 `src/components|components/` 下的；
2. 插入到**选中节点**：`POST /__editor/node/{selectedNodeId}/children`；
3. 插入到**页面根**：`POST /__editor/pages/{page}/children`；
4. 两个接口都会自动补齐 import（named/default 判断 + 去重），返回新节点 `nodeId`。

```ts
const comp = { nodeName: 'Badge', nodeFile: 'src/components/ui/badge.tsx', props: [{ name:'variant', value:'success' }] };
const data = selectedId
  ? await NodeApi.addChild(selectedId, comp)
  : await fetch(`${BASE}/__editor/pages/${page}/children`, { method:'POST', ... });
select(data.nodeId);   // 选中新插入的节点
```

**拖拽插入**建议两种实现任选：
- 简单：先点选目标容器 → 组件库卡片点击“添加”（零拖拽代码）；
- 进阶（跨 iframe 拖放）：编辑器用 HTML5 drag 设置 `dataTransfer` 文本；iframe 容器上 `onDragOver` 期间由客户端监听 `dragover`（客户端内部 `document.elementFromPoint` 找 `data-node-id`）并通过 `NODE_HOVERED` 高频上报落点；`drop` 时父窗口以最后上报的 nodeId 作为 parent 调用插入 API。

### 4.5 复制 / 粘贴 / 撤销 / 重做
```ts
await fetch(`${BASE}/__editor/clipboard`, { method:'POST', body: JSON.stringify({ nodeId: selectedId }) });   // 复制
const pasted = await fetch(`${BASE}/__editor/clipboard/apply`, { method:'POST', body: JSON.stringify({ parentNodeId: selectedId }) }).then(r=>r.json()); // 粘贴（可跨页，自动补 import）
await fetch(`${BASE}/__editor/pages/${page}/undo`, { method:'POST' }); // 撤销
await fetch(`${BASE}/__editor/pages/${page}/redo`, { method:'POST' });
// 历史状态：GET /__editor/pages/{page}/history -> {canUndo,canRedo,...}
```
写盘操作全部入历史（上限 50/页，dev server 重启清空）。

### 4.6 查看代码 / AST / 直接编辑页面源码
- 选中节点源码：`GET /node/{id}` 的 `source`（精确到该 JSX 块），`ast` 为整棵 AST JSON；
- 表达式属性内部 AST：`props[].ast`；
- 查看/编辑整页：`GET /__editor/pages/{page}` 与 `POST /__editor/pages/{page}/content`（保存整页源码，支持历史）。
- 视图建议三个 tab：属性 / 源码 / AST（AST 可只读折叠树或 JSON 高亮）。

### 4.7 HMR 与状态保持
- 每次写文件 → Vite HMR 会让页面模块热更新（若页面组件内部用 fast-refresh 边界则保留其状态；否则页面子树重挂载）；
- 编辑器策略：写成功后**重新拉取**页面树/节点信息，并 `postMessage(EDITOR_HIGHLIGHT)` 让 iframe 重新高亮；点击选中的同 id 多实例（列表渲染）问题参考 demo 里的“按序号回退”方案：客户端记录该节点在 `querySelectorAll` 中的序号，HMR 后用序号定位；
- iframe 每次 `load`（含整页 reload）都会重发 `EDITOR_READY`，编辑器应据此清掉过期状态并重拉。

### 4.8 页面元素树（可选导航）
```ts
const { tree } = await fetch(`http://localhost:5173/__editor/pages/${page}/tree`).then(r=>r.json());
// tree: [{kind:'element', tag:'div', id:'node-...', attrs:[...], children:[...]}, {kind:'text', text:'...'}]
```
渲染为左侧树；点击树节点等价于“程序化选中”：`setSelected(id)` + `postMessage(EDITOR_HIGHLIGHT)`。

---

## 5. 完整“外壳 + iframe”最小骨架（供 agent 直接起步）

```tsx
// EditorShell.tsx —— 假想编辑器的骨架
export default function EditorShell() {
  const [page, setPage] = useState('dashboard/Dashboard');
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [node, setNode] = useState<NodeInfo|null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const send = (msg: unknown) =>
    iframeRef.current?.contentWindow?.postMessage(msg, '*');

  async function onNodeClicked(nodeId: string) {
    setSelectedId(nodeId);
    const info = await NodeApi.get(nodeId);        // 组件名/文件/属性/children
    setNode(info);
    const schema = info.componentFile ? await NodeApi.schema(nodeId).catch(()=>null) : null;
    setSchema(schema);
  }

  function selectNode(nodeId: string) { onNodeClicked(nodeId); send({ type:'EDITOR_HIGHLIGHT', nodeId }); }

  async function saveProps(changes: PropChange[]) {
    if (!selectedId) return;
    await NodeApi.setProps(selectedId, changes);
    const again = await NodeApi.get(selectedId).catch(()=>null);
    if (again) { setNode(again); send({ type:'EDITOR_HIGHLIGHT', nodeId: selectedId }); }
    refreshHistory();
  }

  return (
    <div className="flex h-screen">
      <aside className="w-96 overflow-auto border-r p-3">
        <PagePicker onChange={setPage} />          {/* §1.1 */}
        <HistoryBar page={page} />                  {/* §4.5 */}
        {selectedId && <PropsPanel node={node} schema={schema} onSave={saveProps} />}  {/* §4.2/4.3 */}
        <Catalog onInsert={addComponent} />         {/* §4.4 */}
      </aside>
      <main className="flex-1">
        <iframe
          ref={iframeRef}
          src={`/rest/apps/dev/${page}`}   // 同源代理页面
          className="h-full w-full border-0"
        />
      </main>
    </div>
  );
}
```

### 5.1 状态恢复建议
- 维护 `selectedId` + 服务端 node 缓存；写操作后对同一 id 重取，失败则清空（文件可能已被改动位置）。
- 切换页面时：清空选择、高亮、历史刷新。

---

## 6. 细节清单（照做即可完整覆盖编辑器功能）

| # | 功能 | 涉及 | 实现要点 |
|---|---|---|---|
| 1 | 页面列表/打开/新建/删除 | Pages API | iframe src 更新；删除后列表刷新 |
| 2 | 点选与高亮 | iframe client + message | 捕获阶段 click；rect 上报；MutationObserver 重绘 |
| 3 | 元素树导航 | `GET pages/{p}/tree` | 与 iframe 点选互相同步 |
| 4 | 节点信息 | `GET node/{id}` | 选中/下钻后加载 |
| 5 | 属性表单 | schema + `POST node/{id}/props` | enum/布尔/文本；支持表达式(§4.2) |
| 6 | children | `GET node/{id}` + `POST …/children/text` | 纯文本编辑；元素子节点列表/下钻/删除 |
| 7 | 组件库与插入 | components + `POST …/children` | 目标=选中节点或页面根；拖拽落点上报 |
| 8 | 复制粘贴 | clipboard API | 跨页面粘贴自动 import |
| 9 | 撤销重做 | pages history | 按钮可用态来自 history |
| 10 | 源码/AST 视图 | node.get | 只读查看 + 可编辑整页(content) |
| 11 | 删除组件 | `DELETE node/{id}` | 根节点保护由服务端完成 |
| 12 | 错误提示 | error.code/message | 面板内 Toast/横幅展示 |

## 7. 安全与部署
- 接口无鉴权，仅本地开发使用；不要将目标 dev server 暴露公网。
- 编辑器与目标 dev server 建议绑定 `127.0.0.1`；如果走局域网，注意 CORS 已放行任意源 + 无鉴权意味着同网段可写文件，务必仅限开发环境。
- iframe 通信可用 `targetOrigin` 收紧（插件注入脚本时通过 query 传入白名单 origin）。
- 编辑器部署形态：任意静态托管（React/Vue/vanilla 均可），把 `BASE`（目标 dev server）与默认页面做成配置项。

## 8. 依赖插件的扩展清单（如需要更完整能力）
- [ ] （仅跨域直连兜底时需要）插件侧 `kesi_editor=1` 注入；同源代理模式无需此项；
- [ ] 若需要组件级 fast refresh 保真，宿主目标工程接入与 vite5 兼容的 `@vitejs/plugin-react`；
- [ ] 拖拽落点高亮跟随（客户端 hover 消息）为可选增强；
- [ ] 多页面多 iframe 同时编辑（每页一个 canvas）属编辑器侧状态管理，与插件无关。

---

## 附录：完整 REST API 一览
> 详细规格见 [EDITOR_API.md](./EDITOR_API.md)。风格：查询 GET、新增/修改 POST（不用 PUT）、删除 DELETE。

| 资源 | 方法与路径 |
|---|---|
| Pages | `GET /pages`、`POST /pages`、`GET|DELETE /pages/{pagePath}`、`POST /pages/{pagePath}/content` |
| Pages 子资源 | `GET …/tree`、`GET …/history`、`POST …/undo`、`POST …/redo`、`POST …/children` |
| Node | `GET /node/{id}`、`GET /node/{id}/schema`、`POST /node/{id}/props`、`POST /node/{id}/children`、`POST /node/{id}/children/text`、`DELETE /node/{id}` |
| Component schemas | `GET /component-schemas?nodeName=&nodeFile=` |
| Clipboard | `GET /clipboard`、`POST /clipboard`、`POST /clipboard/apply` |
| 只读/工具 | `GET /components`、`/ui`、`/status`、`/package-json`、`/plugin-check`；动作类 `POST /build`、`/install-*`、`/init-config` 等 |
