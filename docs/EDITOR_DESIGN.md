# React 组件编辑器 —— 设计与实现记录

> 目标：把 `@kesi/vite-plugin` 升级为一个功能完整的 React 组件编辑器基础设施：
> 编译期注入源码定位/组件元信息（yuku 实现），服务端提供可编程的页面/组件编辑 API，
> demo 实现可用的编辑器界面。
> 本文按实施步骤持续记录（需求 / 决策 / 结果），对应代码在 `packages/vite-plugin/src/editor/*`。

---

## 步骤 0 · 需求整理（任务总览）

1. **替换编译器**：用 yuku-codegen / yuku-parser 替代 babel。
2. **新增 API**（见 [EDITOR_API.md](./EDITOR_API.md)）：
   - 组件参数 schema（node-name + node-file）→ 用于生成属性编辑表单
   - 组件源码块 + 全部属性（含 AST JSON）（node-id）
   - 修改属性值（node-id + 属性名 + 新值，支持多对、支持 AST JSON）
   - 页面上组件的添加 / 删除（node-id）
   - 所有接口错误需完整返回
3. **demo 升级**：用这些 API 做出“编辑组件属性的编辑器”。
4. **目标**：功能强大的 React 组件编辑器；规划更细接口，demo 覆盖编辑器全部能力。

## 步骤 1 · yuku 选型与落地（babel → yuku）

### 调研结论（依据官方文档 `docs/yuku-llms-full.txt`）
- JS API：`parse(source, { lang, sourceType, preserveParens, attachComments, ... })`
  → `{ program, comments, diagnostics }`；AST 为 **ESTree/TS-ESTree 兼容** JSON（与 Babel 的 loc
  体系不同：节点用 `start/end` 字符偏移，无 parent、无 loc）。
- `generate(program, { format, indent, quotes, comments })` → 源码。
- 包形态：native（`yuku-parser`/`yuku-codegen`）与 wasm（`@yuku-parser/wasm`/`@yuku-codegen/wasm`），
  API 一致；wasm 版 `generate` 直接返回字符串，native 返回 `{ code }`。
- 已实测：TSX 往返 `parse → 改 AST → generate` 保真（保留注释需 `attachComments: true`）。

### 决策
- 选用 **wasm 包**（`@yuku-parser/wasm`、`@yuku-codegen/wasm` ^0.9.3）：
  单文件 WebAssembly、无平台二进制、Node/浏览器通用；`generate` 返回字符串更贴合工具链。
  依赖声明已写入 `package.json`，删除 babel 相关依赖与 `@types/babel__*`。
- 统一封装：`src/editor/common.ts` 提供 `parseTsx / generateSource / walk / findNode(s) /
  offset↔line:col / AST 构建（attr、value）/ import 绑定 / 导出分析`，并把解析诊断转成带
  code/status/detail 的 `EditorError`，保证“错误信息完整”。
- 位置约定：`data-node-id` 仍沿用 **行 1 起、列 0 起**（Babel 时代约定），由字符偏移换算，
  与现有 nodeId 载荷格式（`node-` + base64url JSON）完全兼容。

### 结果
- `src/jsxTransform.ts` 改为 yuku 实现（pages-only 注入 data-node-id + 组件 usage 的
  name/file），回归测试：Dashboard 70 个元素 id、Users 51 个，组件名与文件解析正确；
  转换失败时返回原代码，不阻断构建。

## 步骤 2 · 页面编辑内核（服务端能力）

新增目录 `src/editor/`：
- `common.ts`：yuku 封装 / AST 工具 / 错误类型（EditorError）
- `paths.ts`：项目根内文件读写、别名解析（兼容 Vite resolve.alias）、页面路径解析（防穿越）
- `page.ts`：页面树、节点源码（含属性与 AST）、改属性、增删组件
- `schema.ts`：组件属性 schema（TS 类型 / 默认值 / cva 变体）

### 关键设计
- **node-id 双向定位**：服务端读磁盘文件 → parse → 用 id 里的行列（转偏移）精确定位 JSX
  元素；与编译期注入使用同一套编码，保证 id 一致。
- **修改属性**：parse → 在 openingElement.attributes 上增/改/删 → codegen 写回磁盘。
  值支持三种输入：`value`(原始值)、`expr`(JS 表达式文本)、`ast`(ESTree JSON)，可一次传多对；
  传 `remove:true` 删除属性。
- **添加组件**：解析组件文件的导出形态（named/default）→ 页面 import 去重/补 import（相对或
  别名）→ 构造 `<X ...props/>` 插入父容器 → 用临时标记属性找回新节点 id 后移除标记并落盘。
- **删除组件**：按 node-id 定位并从父容器 children 移除（页面根节点禁止删除）。
- **Schema**：
  1) 函数参数 ObjectPattern 解构（默认值）；
  2) 参数类型/interface/type 本文件引用（string/number/boolean/enum(字面量联合)/array/object）；
  3) shadcn `cva()` 的 variants/defaultVariants → variant/size 等 enum 选项与默认值
  （注意：yuku AST 的对象成员类型是 ESTree 的 `Property`，不是 TS-ESTree 的 `ObjectProperty`，
  初版踩坑后已兼容两者）。

### 测试（函数级集成测试，scratch 页面）
tree / node-source / schema（Button variant 6 选项）/ set-props（多对 + 表达式 + 删除）/
add-component（import 去重：页面已有 `@/components/ui/button` 别名导入时不会重复 import）/
remove-component 全部通过（见运行记录末尾）。

## 步骤 3 · /__editor 页面编辑 API

见 [EDITOR_API.md](./EDITOR_API.md)。统一行为：
- 请求/响应 JSON；成功 `{ success, data }`；失败 `{ success:false, error:{ code, message, detail } }`，
  HTTP 状态 400/404/409/422/500 分别对应参数错误/未找到/冲突/解析失败/内部错误。
- 写文件后触发组件扫描（scanner.scanAll），保证 `/__editor/components` 等数据与磁盘一致。

## 步骤 4 · demo 编辑器（Editor UI）

`demo/src/Editor.tsx`（App 新增「编辑器」Tab 全屏进入）：
- **页面结构树**：/__editor/page-tree，嵌套展示元素/组件（含组件文件 badge），点击选中
- **属性编辑**：/__editor/node-source 读取当前 props；组件再拉 /__editor/component-schema，
  按 schema 生成表单（enum 下拉、布尔开关、字符串/数字输入、默认值提示），支持新增/删除属性、
  一次保存多对（/__editor/set-props）
- **源码 / AST 视图**：展示节点源码块与节点 AST JSON，便于理解“可编程修改”对象
- **添加 / 删除组件**：从扫描到的 src/components 组件目录里选择组件，插入选中节点；删除走
  AlertDialog 二次确认（/__editor/remove-component）
- 所有操作结果 Toast 反馈；错误信息（code+message）完整展示

## 步骤 5 · Demo v2：内嵌式选中编辑（按反馈重构）

- 取消“独立编辑器页”形态。三个 Tab：总览 / 用户 / API（API 调试台替代原编辑器 Tab）。
- 选中体验：点击右侧预览元素 → 蓝色外框（带组件名/文件徽标）→ 左侧栏下方出现
  **属性编辑面板（PropPanel）**：schema 表单（enum/布尔/文本/数字）、自由增删属性、事件模板、
  查看代码（Dialog）、删除（AlertDialog 确认）、复制/粘贴、撤销/重做、插入组件。
- **组件库拖拽插入**：左侧组件库卡片（扫描 src/components 生成）可拖拽；拖到预览中某元素上，
  服务端以该元素为父容器插入组件（无目标时插到页面根）。
- API 调试台独立于 `ApiConsole.tsx`：GET/POST、请求体编辑、错误信息完整展示。

## 步骤 5b · 保存不整页刷新（HMR 边界）

现象：编辑写回页面文件 → Vite 默认对该模块做 full-reload，预览整页刷新、选中/面板丢失。
方案：新增 `demo/src/PageView.tsx` —— 渲染 Dashboard/Users 的宿主组件，并对
`../pages/dashboard/Dashboard` 与 `../pages/users/Users` 注册 `import.meta.hot.accept(...)` 边界：
页面文件更新时只在此边界热替换页面组件子树（重渲染页面内容），App/左侧 PropPanel/选中状态
不销毁、不整页 reload；选中框通过定时重测自动跟随新 DOM。
说明：页面组件内部状态（如打开中的弹窗）在热替换时会被重置；若需组件级保真，可后续为
demo 接入与 vite5 兼容的 @vitejs/plugin-react（fast refresh）。

> 后续修订（接入 fast refresh）：手动 accept（无论局部还是全局重建）体验均不佳，
> 且没有插件时 Vite 对 .tsx 变更默认整页 reload。demo 最终接入与 vite5/React19 兼容的
> `@vitejs/plugin-react@^4.7.0`：自动 JSX + fast refresh，任意组件变更按组件热更并保留
> 状态，无整页刷新；main/PageView 保持纯净渲染，不注册任何手动 accept。

## 步骤 6 · 继续完成的规划项（服务端能力）

- [x] **撤销 / 重做**：`src/editor/history.ts` 内存 ring（每页各自 past/future，上限 50）；
      所有写盘接口（set-props / add / remove / paste）修改前推快照；
      `/__editor/undo | redo | history`
- [x] **复制 / 粘贴**：`copy-node` 深拷贝 JSX 子树（剔除 data-node-*/临时标记）入服务端剪贴板；
      `paste` 支持跨页面：按来源页 import 绑定为目标页自动补 import（命名/默认/命名空间，
      相对路径重算；与目标页同名冲突时报 IMPORT_CONFLICT）。踩坑：yuku 自闭合由
      `openingElement.selfClosing` 控制（不在元素上），给自闭合元素加子节点需同时补 closingElement
      与 children。
- [x] **schema 跨文件**：组件 props 类型不在本文件时，通过 import 绑定解析到本地文件接口/类型
      （`component-schema` 入参增加 resolve 上下文）
- [x] **属性编辑安全**：表达式一律经 `parseExpressionText` 先解析再入 AST，非法表达式返回
      `INVALID_EXPRESSION`（不写盘）；写回前对整体重新 parse 校验，失败不落盘
- [x] **组件库面板（拖拽插入）**：见步骤 5
- [ ] 后续候选：children/事件占位模板的 schema 级描述、Canvas 点选与属性面板联动、
      多页面 Tab 编辑、undo 磁盘持久化、schema 白名单（Base UI Props 枚举）等

## 步骤 7 · 下一步规划（更细接口 / 能力，长期）

- [ ] 撤销/重做：编辑前记录 page 源码快照（服务端内存 ring），`/__editor/undo`
- [ ] 复制/粘贴组件（node-id 级 clone 子树的 AST 直插）
- [ ] schema 增强：跨文件类型解析（`@/types`、base-ui `ButtonPrimitive.Props` 白名单）、
      JSDoc 描述、children/事件函数占位模板
- [ ] 属性编辑安全：className 等字符串 + 表达式编辑（codegen 前先 parse 校验）
- [ ] Canvas 联动：iframe 点选（现有 NODE_SELECTED）直接打开 Editor 对应属性面板
- [ ] 组件库面板：扫描 → 组件卡片（schema 概览）+ 拖拽插入
- [ ] 多页面 tab 编辑、页面级 JSON 视图、formatter 选项暴露

---

## 运行记录

```
[通过] 历史与粘贴链路：set-props 后 undo 精确还原原文本；copy(跨文件)→paste 自动补相对 import，
      粘贴元素存在且返回新 node-id
[通过] component-schema 跨文件与 cva 变体；修复 yuku 自闭合容器插入
[通过] transform 回归（yuku 版）：pages/dashboard 70 ids / 22 names；pages/users 51 ids / 21 names
[通过] component-schema(Button)：variant=enum[default|outline|secondary|ghost|destructive|link] default
[通过] node-source：<Button size="sm" disabled>点我</Button> + props(size literal, disabled boolean)
[通过] set-props：size=lg / variant=destructive / aria-label=表达式 / 删除 disabled
[通过] add-component：插入 <Button variant="secondary"/>，import 去重（别名已存在时复用）
[通过] remove-component：移除新增节点
[通过] tsc --noEmit / tsup + tsc 声明构建
[待办] demo node_modules 由 kesi 根 pnpm workspace 提供后，`pnpm dev` 浏览器内跑通编辑器 UI
```
