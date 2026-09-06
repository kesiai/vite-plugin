# /__editor REST API 参考（完整版）

> Vite dev server 开发期注入的 HTTP API，仅本地使用、不鉴权。Base URL：`http://localhost:<port>/__editor`

## 通用约定

- 除特别说明外请求/响应均为 JSON（`Content-Type: application/json`）。
- 成功：`{ "success": true, "data": <结果> }`
- 失败：`{ "success": false, "error": { "code", "message", "detail? } }`
  错误码：`PARSE_ERROR / FILE_READ_ERROR / FILE_WRITE_ERROR / FILE_DELETE_ERROR / PAGE_NOT_FOUND /
  PAGE_EXISTS / COMPONENT_NOT_FOUND / NODE_NOT_FOUND / INVALID_NODE_ID / INVALID_PAGE /
  INVALID_PROPS / INVALID_EXPRESSION / INVALID_CHILDREN / NOT_A_COMPONENT / CHILDREN_HAS_ELEMENTS /
  IMPORT_CONFLICT / NO_CLIPBOARD / NO_HISTORY / REMOVE_ROOT / MISSING_FIELDS / METHOD_NOT_ALLOWED /
  INTERNAL_ERROR`
- HTTP 状态：200 成功；400 参数/语义；404 资源不存在；405 方法不允许；409 冲突（覆盖/导入冲突/含元素子节点）；422 语法/解析失败；500 内部。
- 风格：**查询 GET / 新增与修改 POST / 删除 DELETE**；动作型（撤销/粘贴/构建/安装）用 POST。
  **不使用 PUT**：为兼容只放行 GET/POST 的服务器/代理，所有“修改”都以 POST 表达，
  并通过子路径区分动作（如 `POST /node/{id}/props`、`POST /node/{id}/children/source`、
  `POST /pages/{page}/content`）；DELETE 保留，若部署环境同样限制，可改用动作 POST（见文末说明）。
- `{pagePath}` 为页面相对路径，如 `dashboard/Dashboard`（可含 `/` 与扩展名）；
  `{nodeId}` 为编译期注入的 `data-node-id`（`node-` + base64url，内部已含文件与行列，服务端据此定位到节点所在页面，多数接口可不传 page）。

---

## Pages（页面资源）

### 页面列表 / 新建 / 读取 / 覆盖 / 删除

| Method | Path | Body | 说明 |
|---|---|---|---|
| GET | `/__editor/pages` | – | 页面文件列表 `{ pages: [{name,path}] }`（递归 pages/） |
| POST | `/__editor/pages` | `{ "path": "pages/dashboard/New", "template"? }` | 新建页面（默认生成 React 模板），返回 `{ page }` |
| GET | `/__editor/pages/{pagePath}` | – | 读取页面源码 `{ file, content }` |
| POST | `/__editor/pages/{pagePath}/content` | `{ "content": "<完整源码>" }` | 覆盖写整页（自动进撤销历史） |
| DELETE | `/__editor/pages/{pagePath}` | – | 删除页面文件 |

### 页面结构 / 历史

| Method | Path | 说明 |
|---|---|---|
| GET | `/__editor/pages/{pagePath}/tree` | 页面 JSX 元素树（元素带 nodeId/组件信息；文本带内容）`{ file, tree }` |
| GET | `/__editor/pages/{pagePath}/history` | `{ canUndo, canRedo, undoCount, redoCount }` |
| POST | `/__editor/pages/{pagePath}/undo` | 撤销最近一次写操作（返回最新源码与历史统计；无历史 `NO_HISTORY`） |
| POST | `/__editor/pages/{pagePath}/redo` | 重做 |

### 页面根插入组件

| Method | Path | Body |
|---|---|---|
| POST | `/__editor/pages/{pagePath}/children` | `{ "nodeName": "Badge", "nodeFile": "src/components/ui/badge.tsx", "props"? , "childrenText"? }` |

向页面根容器末尾插入组件并自动补 import，返回 `{ updatedSource, nodeId }`。

## Node（页面节点 / 组件资源）

`nodeId` 从页面元素 DOM 的 `data-node-id` 获取（或 `/pages/{page}/tree`、`GET /node/{id}` 返回）。

### 节点信息与源码

```
GET /__editor/node/{nodeId}
```

返回该组件块的**完整源码、全部属性、children、AST**：

```json
{
  "nodeId": "node-…", "file": "pages/…", "tag": "Button",
  "componentName": "Button", "componentFile": "src/components/ui/button.tsx",
  "source": "<Button size=\"sm\">点我</Button>",
  "startLine": 6, "startCol": 6,
  "props": [
    { "name": "size", "type": "literal", "value": "sm", "valueText": "\"sm\"" },
    { "name": "disabled", "type": "boolean" },
    { "name": "onClick", "type": "expression", "ast": { "type": "ArrowFunctionExpression", "…": "…" } },
    { "name": "children", "type": "children", "childrenValue": "Hello <b>bold</b>{n}" }
  ],
  "childrenValue": "Hello <b>bold</b>{n}",
  "elementChildren": [ { "kind": "element", "nodeId": "node-…", "tag": "span", "componentFile": "…" } ],
  "schema": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { … }, "required": [ … ] },
  "ast": { "type": "JSXElement", "…": "…" }
}
```

### 组件属性 schema

```
GET /__editor/node/{nodeId}/schema
```

返回该组件节点的属性 schema（函数参数默认值 / 本文件及跨文件 interface·type / cva 变体枚举），
用于生成属性编辑表单；非自定义组件返回 `NOT_A_COMPONENT`。

```json
{ "version": 1,
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "title": "Button props",
  "properties": {
    "variant": { "x-type": "enum", "enum": ["default", "destructive", "secondary", "outline", "ghost", "link"], "default": "default" },
    "size": { "x-type": "enum", "enum": ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] },
    "className": { "x-type": "any" }
  },
  "x-component": { "name": "Button", "file": "src/components/ui/button.tsx", "exportKind": "named" },
  "x-order": ["variant", "size", "className"] }
```

### 修改属性（批量）

```
POST /__editor/node/{nodeId}/props
Body: { "props": [ { "name": "size", "value": "lg" },
                   { "name": "onClick", "type": "expression", "value": "() => save()" },   // 表达式字符串
                   { "name": "style", "type": "expression", "value": { "type": "ObjectExpression", "…": "…" } }, // AST JSON
                   { "name": "disabled", "remove": true } ] }
```

- 读取端 props 项用 `type` 表示值类型：`literal` / `boolean` / `expression` / `children` / `spread`。
- **表达式属性**：保存时属性项带 `"type": "expression"`（兼容旧值 `expr`），value 支持两种：
  - **表达式字符串**（如 `() => save()`、`count > 0 ? 'a' : 'b'`）：先用 yuku 解析成 AST，
    再包进 `{<expr>}` 作为 JSX 属性表达式写回（先解析校验，非法返回 `INVALID_EXPRESSION` 且不落盘）；
  - **AST JSON**（ESTree 表达式节点对象）：直接克隆并包成表达式写回；
  - 也可用 `expression` / `expr` 字段直接传表达式字符串（不带 type 的旧写法）。
- 不带 `type` 时：`value` 原始值 / `expression`·`expr` 表达式文本 / `ast` AST JSON。
- `remove: true`（或三者皆无）删除该属性。
- 写盘后返回 `{ updatedSource, nodeId, applied }`，可撤销。
- 组件节点（`GET /node/{id}`）响应已**内嵌 `schema`（JSON Schema Draft-07）**：properties 为对象映射、
  required、单属性 default/enum/type/description，扩展关键字 `x-component`（组件元信息）与 `x-order`（顺序）。
  不再需要为属性编辑单独请求 schema（`GET /node/{id}/schema` 与 `GET /component-schemas?nodeName=&nodeFile=`
  返回同一 JSON Schema）。

### 编辑 children（源码级）

```
POST /__editor/node/{nodeId}/children/source
Body: { "source": "Hello <b>bold</b>{count > 0 ? 'x' : 'y'}" }   // 空字符串 = 清空 children
```

- children 是**特殊属性**：`GET /node/{id}` 的 props 中有一项 `{ name:'children', type:'children', childrenValue }`，
  顶层 `childrenValue` 与该项一致，直接返回 children 在源码中的**原样文本**
  （含文本 / JSX 表达式 / ReactNode / JSX 注释，不做过滤）；`elementChildren` 仅列出直接子 JSX 元素
  （带 node-id，供下钻/删除）。
- 保存时把编辑后的 children 源码片段整体写回（可含任意 JSX children），先解析校验，
  非法返回 `PARSE_ERROR`；不再需要 canEditText 之类的限制。
- 兼容旧写法：`POST /node/{id}/children/text`，body `{ text }` 等价于 source。
- 写盘后返回 `{ updatedSource, nodeId, childrenValue }`，可撤销。

### 插入子组件

```
POST /__editor/node/{nodeId}/children
Body: { "nodeName": "CardHeader", "nodeFile": "src/components/ui/card.tsx", "props"? }
```

把组件插入为该节点的**最后一个子节点**，自动补 import（去重），返回 `{ updatedSource, nodeId }`，可撤销。

### 删除节点

```
DELETE /__editor/node/{nodeId}
```

删除页面中该节点（组件/元素）。页面根节点禁止删除（`REMOVE_ROOT`）。返回 `{ updatedSource }`，可撤销。

## Component Schemas（按名称+文件查询）

```
GET /__editor/component-schemas?nodeName=Button&nodeFile=src%2Fcomponents%2Fui%2Fbutton.tsx
```

响应同 `GET /node/{nodeId}/schema`（供“新增组件/组件库”在尚未实例化时预览属性）。

## Clipboard（服务端剪贴板）

| Method | Path | Body | 说明 |
|---|---|---|---|
| GET | `/__editor/clipboard` | – | `{ has, file?, tag? }` |
| POST | `/__editor/clipboard` | `{ "nodeId" }` | 深拷贝 JSX 子树入剪贴板（剥离 data-node-*/临时标记），返回 `{ nodeId, file, tag, source }` |
| POST | `/__editor/clipboard/apply` | `{ "page"?, "parentNodeId"? }` | 粘贴：按来源页 import 绑定为目标页补 import（跨页面可用；冲突 `IMPORT_CONFLICT`）。剪贴板空 `NO_CLIPBOARD`。返回 `{ updatedSource, nodeId }` |

## Components（扫描 / 只读）

| Method | Path | 说明 |
|---|---|---|
| GET | `/__editor/components` | 扫描到的组件列表（name / dataCode / filePath / lineNumber） |
| GET | `/__editor/ui` | 页面组件及展示路由 |
| GET | `/__editor/status` | dev server 运行状态 |
| GET | `/__editor/package-json` | 宿主依赖信息（含 hasKesiClient） |
| GET | `/__editor/plugin-check` | 插件自检 |

## 工具 / 动作类（POST，SSE 流式输出）

| Method | Path | Body | 说明 |
|---|---|---|---|
| POST | `/__editor/routers` | 数组 | 更新路由配置（GET `/__editor/routers` 读取；遗留接口，语义见 /ui） |
| POST | `/__editor/modify-code` | `{ componentName, modifications[] }` | 按组件名改代码（append/prepend/insert/replace） |
| POST | `/__editor/install-package` | `{ packageName }` | npm 安装（SSE 输出） |
| POST | `/__editor/install-shadcn` | `{ componentName }` | shadcn/ui 组件安装（SSE） |
| POST | `/__editor/install-client` | – | 安装 `@kesi/client`（SSE） |
| POST | `/__editor/init-config` | `{ projectId }` | 生成 `kesi.config.ts` |
| POST | `/__editor/build` | – | 执行 `npm run build`（SSE） |

## import 自动补齐与写前校验

参考 `ensure-kesi-imports`（表达式 hook 落串后自动合并 import）的做法，编辑器内所有**会改动代码的写操作**
（`POST /node/{id}/props`、`POST /node/{id}/children/source`、`POST /node/{id}/children`、
`POST /pages/{page}/children`、`POST /clipboard/apply`）在写盘前统一执行：

1. 只扫描**本次修改影响范围**内实际出现的自定义标识符（AST 级，天然排除字符串/注释/TS 类型/成员属性名）；
2. 页面内已 import、本文件已声明（含组件内参数/局部变量）的标识符跳过，避免误报；
2. **@kesi/client 成员（移植自 ensure-kesi-imports）**：`Page/Subscribe` 与全部 hooks
   （useUser/useEvents/useTag/useTableData/useModel*/usePageVar*/…）及 `getSettings` 为可自动导入面。
   代码中出现而页面未导入/未本地声明的成员：
   - 已有 `import { … } from '@kesi/client'` → 合并进该语句（保留原有成员，幂等）；
   - 无该 import → 在 import 区新增一条；
   - 页面已本地声明同名（如自定义 `usePageVar`）→ 不重复导入（避免重名冲突）。
3. 其它缺失的自定义标识符/组件从项目组件目录自动解析（`src/components`、`components`，按命名惯例
   探测 + 导出扫描，带缓存），支持 named/default：
   - 能解析 → 自动合并/新增 import（幂等；同源不重复、异源同名抛 `IMPORT_CONFLICT`）；
   - 无法解析 → 返回 `MISSING_IMPORT`（409，message 中列出缺失标识符），**本次修改不写盘**。

新增 import 会让文件行号前移，因此这类写入统一用“哨兵属性 + 重生成”精确定位返回新的 node-id。

## 撤销/重做与写操作注意事项

- 写操作（页面 PUT、节点 PUT/POST/DELETE、粘贴）都会先记录快照；
  历史按页面分开、内存上限 50 条，dev server 重启即清空。
- undo/redo 写回前会重新 parse 校验，解析失败的快照不会落盘（返回 `PARSE_ERROR`）。

## curl 速查

```bash
# 页面树（GET 查询）
curl http://localhost:5173/__editor/pages/dashboard/Dashboard/tree
# 节点信息
curl http://localhost:5173/__editor/node/node-...
# 组件 schema（GET 查询）
curl "http://localhost:5173/__editor/component-schemas?nodeName=Button&nodeFile=src%2Fcomponents%2Fui%2Fbutton.tsx"
# 修改属性（POST，兼容无 PUT 的服务器）
curl -X POST http://localhost:5173/__editor/node/node-.../props \
  -H 'Content-Type: application/json' \
  -d '{ "props": [{ "name": "size", "value": "lg" }] }'
# 删除节点（DELETE）
curl -X DELETE http://localhost:5173/__editor/node/node-...
# 撤销（POST 动作）
curl -X POST http://localhost:5173/__editor/pages/dashboard/Dashboard/undo
```

## 关于方法兼容（为什么不用 PUT）

部分内网/代理/网关只允许 GET 与 POST，PUT 请求可能被直接拦截。因此本 API 的修改类操作全部以
POST + 子路径表达（`…/props`、`…/children/text`、`…/content`）。若你的环境连 DELETE 也不放行，
删除类可统一改用动作式 POST（后续可提供 `POST /__editor/node/{id}/delete` 等别名，当前实现保留 DELETE 语义）。
