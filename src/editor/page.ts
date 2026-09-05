import { EditorError, parseTsx, generateSource, AnyNode, cloneJson } from './common';
import { ResolveContext, resolveLocalModule, readProjectFile, writeProjectFile, pageImportSpecifier, absFromRoot } from './paths';
import {
  offsetToPoint,
  pointToOffset,
  elementEndOffset,
  unwrapExpr,
  walk,
  findNodes,
  findNode,
  NodePathInfo,
  collectBindings,
  analyzeExports,
  getAttr,
  hasAttr,
  removeAttr,
  setAttrValue,
  buildAttrValue,
  describeAttrValue,
  jsxIdentifier,
} from './common';
import { decodeNodeId, encodeNodeId } from '../nodeId';
import { PageHistory } from './history';

// ============================== 定位 / id ==============================

/** 生成与编译期注入一致的 data-node-id（file + 起止标签行列） */
export function elementNodeId(fileRel: string, text: string, el: AnyNode): string {
  const open = el.openingElement;
  const start = offsetToPoint(text, open.start);
  const end = offsetToPoint(text, elementEndOffset(el));
  return encodeNodeId(fileRel, { line: start.line, column: start.column }, { line: end.line, column: end.column });
}

export function isPageFile(fileRel: string, pagesDir: string): boolean {
  return fileRel.startsWith(pagesDir + '/') && /\.(tsx|jsx)$/.test(fileRel);
}

/** 通过 data-node-id 在文件中定位 JSX 元素 */
export function findElementById(fileRel: string, text: string, program: AnyNode, nodeId: string): AnyNode {
  const span = decodeNodeId(nodeId);
  if (!span) throw new EditorError('INVALID_NODE_ID', `data-node-id 无法解码：${nodeId}`, 400);
  if (span.file !== fileRel) {
    throw new EditorError(
      'NODE_ID_FILE_MISMATCH',
      `该 data-node-id 属于 ${span.file}，不属于当前页面 ${fileRel}`,
      400,
      { expected: fileRel, actual: span.file }
    );
  }
  const startOffset = pointToOffset(text, { line: span.startLine, column: span.startCol });
  const endOffset = pointToOffset(text, { line: span.endLine, column: span.endCol });
  if (startOffset < 0 || endOffset < 0) {
    throw new EditorError('NODE_NOT_FOUND', `节点位置超出文件范围：${nodeId}`, 404);
  }

  const hits = findNodes(program, (n) => n.type === 'JSXElement' && !!n.openingElement);
  for (const { node } of hits) {
    if (node.openingElement.start === startOffset && elementEndOffset(node) === endOffset) {
      return node;
    }
  }
  // 兜底：仅匹配起始位置（如版本/格式化差异导致 end 变化）
  for (const { node } of hits) {
    if (node.openingElement.start === startOffset) return node;
  }
  throw new EditorError(
    'NODE_NOT_FOUND',
    `在 ${fileRel} 中找不到该节点（可能文件已被修改，请刷新页面树）`,
    404,
    { nodeId, startLine: span.startLine, startCol: span.startCol }
  );
}

// ============================== 组件解析 ==============================

/** 解析自定义组件用法（页面 AST）-> 展示名 + 组件文件 */
export function usageComponentName(
  program: AnyNode,
  el: AnyNode,
  context: ResolveContext,
  fileRel: string
): { name?: string; file?: string } {
  const tag = el?.openingElement?.name;
  if (!tag) return {};
  if (tag.type === 'JSXIdentifier') {
    if (/^[a-z]/.test(tag.name)) return {};
    const bindings = collectBindings(program);
    const binding = bindings.get(tag.name);
    if (!binding) return {};
    const compFile = resolveLocalModule(binding.source, fileRel, context);
    if (!compFile) return {};
    if (binding.kind === 'named') return { name: binding.imported ?? tag.name, file: compFile };
    if (binding.kind === 'default') {
      const info = componentExportsInfo(context, compFile);
      return { name: info.defaultName ?? tag.name, file: compFile };
    }
    return { file: compFile };
  }
  if (tag.type === 'JSXMemberExpression') {
    // 命名空间 <ui.Button>
    let obj: AnyNode = tag;
    while (obj.type === 'JSXMemberExpression') obj = obj.object;
    if (obj.type === 'JSXIdentifier') {
      const bindings = collectBindings(program);
      const binding = bindings.get(obj.name);
      if (binding?.kind === 'namespace') {
        const compFile = resolveLocalModule(binding.source, fileRel, context);
        if (compFile && tag.property?.name) return { name: tag.property.name, file: compFile };
      }
    }
  }
  return {};
}

export function componentExportsInfo(context: ResolveContext, compRel: string): { named: Set<string>; defaultName: string | null } {
  const text = readProjectFile(context, compRel);
  const program = parseTsx(text, compRel);
  return analyzeExports(program);
}

/** 默认导出组件的真实名字（解析定义文件） */
export function defaultExportName(context: ResolveContext, compRel: string): string | null {
  return componentExportsInfo(context, compRel).defaultName;
}

// ============================== 根元素 ==============================

function unwrapRootElement(n: AnyNode): AnyNode {
  let node = unwrapExpr(n);
  return node;
}

/** 找出页面默认导出（或第一个组件）返回的 JSX 根 */
export function findPageRoots(program: AnyNode): AnyNode[] {
  const roots: AnyNode[] = [];

  const collectFromFn = (fn: AnyNode) => {
    if (!fn) return;
    // 只在页面组件函数自身作用域收集 return 的顶层 JSX；
    // 遇到嵌套函数（map 回调等）不进入。
    const pushRoot = (arg: AnyNode) => {
      const node = unwrapRootElement(arg);
      if (node && (node.type === 'JSXElement' || node.type === 'JSXFragment') && !roots.includes(node)) {
        roots.push(node);
      }
    };
    const visit = (n: AnyNode) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.type === 'string') {
        if (
          n !== fn &&
          (n.type === 'FunctionDeclaration' ||
            n.type === 'FunctionExpression' ||
            n.type === 'ArrowFunctionExpression')
        ) {
          return; // 不进入嵌套函数
        }
        if (n.type === 'ReturnStatement') {
          pushRoot(n.argument);
          return; // return 子树只取顶层 JSX
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'parent' || k === 'loc') continue;
        const v = n[k];
        if (Array.isArray(v)) {
          for (const item of v) visit(item);
        } else if (v && typeof v === 'object') {
          visit(v);
        }
      }
    };
    visit(fn);
  };

  for (const stmt of program.body ?? []) {
    if (stmt?.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d?.type === 'FunctionDeclaration') collectFromFn(d);
      else if (d?.type === 'ArrowFunctionExpression' || d?.type === 'FunctionExpression') collectFromFn(d);
      else if (d?.type === 'Identifier') {
        const target = findNode(
          program,
          (n) =>
            (n?.type === 'FunctionDeclaration' || n?.type === 'VariableDeclarator') &&
            n.id?.name === d.name
        );
        if (target) {
          const fn = target.node.type === 'VariableDeclarator' ? target.node.init : target.node;
          collectFromFn(fn);
        }
      }
    }
  }
  if (roots.length > 0) return roots;

  // 兜底：任何大写组件函数的首个 JSX 返回根
  const fns = findNodes(
    program,
    (n) =>
      (n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression') &&
      /^[A-Z]/.test(n?.id?.name ?? '')
  );
  for (const { node } of fns) {
    if (roots.length > 0) break;
    collectFromFn(node);
  }
  return roots;
}

/** 可插入子节点的容器（元素或 Fragment） */
function containerOf(el: AnyNode): AnyNode {
  if (el.type === 'JSXFragment') return el;
  return el;
}

// ============================== 页面树 / 源码 ==============================

function tagText(name: AnyNode): string {
  if (!name) return '#unknown';
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const parts: string[] = [];
    let n: AnyNode = name;
    const walkMember = (m: AnyNode) => {
      if (m.type === 'JSXMemberExpression') {
        walkMember(m.object);
        parts.push(m.property?.name ?? '');
      } else if (m.type === 'JSXIdentifier') {
        parts.push(m.name);
      }
    };
    walkMember(n);
    return parts.join('.');
  }
  return '#unknown';
}

interface TreeElement {
  kind: 'element';
  tag: string;
  id?: string;
  componentName?: string;
  componentFile?: string;
  attrs: Array<{ name: string; kind: string }>;
  children: TreeNode[];
  text?: undefined;
}
interface TreeText {
  kind: 'text';
  text: string;
}
type TreeNode = TreeElement | TreeText;

function buildTreeNodes(
  nodes: AnyNode[],
  fileRel: string,
  text: string,
  program: AnyNode,
  context: ResolveContext
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (!node) continue;
    if (node.type === 'JSXText' || node.type === 'JSXText') {
      const t = node.value ?? node.text ?? '';
      if (t.trim()) out.push({ kind: 'text', text: t.trim().slice(0, 60) });
      continue;
    }
    if (node.type === 'JSXExpressionContainer') {
      const inner = unwrapExpr(node.expression);
      if (inner?.type === 'Literal' && inner.value != null && inner.value !== '') {
        out.push({ kind: 'text', text: String(inner.value).slice(0, 60) });
      }
      continue;
    }
    if (node.type === 'JSXFragment') {
      out.push(...buildTreeNodes(node.children ?? [], fileRel, text, program, context));
      continue;
    }
    if (node.type !== 'JSXElement') continue;
    const usage = usageComponentName(program, node, context, fileRel);
    const attrs = (node.openingElement?.attributes ?? []).map((a: AnyNode) => {
      if (a.type === 'JSXSpreadAttribute') return { name: '...', kind: 'spread' };
      return { name: a.name?.name ?? '?', kind: describeAttrValue(a).kind };
    });
    out.push({
      kind: 'element',
      tag: tagText(node.openingElement?.name),
      id: elementNodeId(fileRel, text, node),
      componentName: usage.name,
      componentFile: usage.file,
      attrs,
      children: buildTreeNodes(node.children ?? [], fileRel, text, program, context),
    });
  }
  return out;
}

export function getPageTree(fileRel: string, text: string, context: ResolveContext): TreeNode[] {
  const program = parseTsx(text, fileRel);
  const roots = findPageRoots(program);
  if (roots.length === 0) {
    throw new EditorError('NO_ROOT_JSX', `页面 ${fileRel} 没有找到可编辑的 JSX 根`, 404);
  }
  return buildTreeNodes(roots, fileRel, text, program, context);
}

export interface NodeChildSummary {
  kind: 'element' | 'text';
  nodeId?: string;
  tag?: string;
  componentName?: string;
  componentFile?: string;
  text?: string;
}

export interface NodeSourceResult {
  nodeId: string;
  file: string;
  tag: string;
  componentName?: string;
  componentFile?: string;
  source: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  props: Array<{
    name: string;
    kind: string;
    value?: unknown;
    valueText?: string;
    ast?: AnyNode;
  }>;
  /** 子节点摘要（元素带 node-id 可继续下钻；纯文本时可用于编辑 children 文本） */
  children: NodeChildSummary[];
  /** 是否允许把 children 当作纯文本编辑（不含 JSX 元素子节点时） */
  canEditText: boolean;
  ast: AnyNode;
}

export function getNodeSource(fileRel: string, text: string, nodeId: string, context: ResolveContext): NodeSourceResult {
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  const usage = usageComponentName(program, el, context, fileRel);
  const start = offsetToPoint(text, el.start);
  const end = offsetToPoint(text, el.end);

  const props = (el.openingElement?.attributes ?? []).map((attr: AnyNode) => {
    const name = attr.type === 'JSXSpreadAttribute' ? '...' : attr.name?.name ?? '?';
    if (attr.type === 'JSXSpreadAttribute') {
      const arg = attr.argument;
      return {
        name,
        kind: 'spread',
        valueText: arg ? text.slice(arg.start ?? el.start, arg.end ?? el.start) : undefined,
        ast: arg ? cloneJson(arg) : undefined,
      };
    }
    const desc = describeAttrValue(attr);
    const result: any = { name, kind: desc.kind };
    if (attr.value) {
      result.valueText = text.slice(attr.value.start, attr.value.end);
      if (attr.value.type === 'Literal') result.value = attr.value.value;
      if (attr.value.type === 'JSXExpressionContainer') {
        result.ast = cloneJson(unwrapExpr(attr.value.expression));
      }
    }
    return result;
  });

  const childEls = (el.children ?? []).filter((c: AnyNode) => c?.type === 'JSXElement');
  const childTexts = (el.children ?? []).filter((c: AnyNode) => c?.type === 'JSXText');
  const hasOther = (el.children ?? []).some(
    (c: AnyNode) => c?.type === 'JSXElement' || c?.type === 'JSXFragment' || c?.type === 'JSXExpressionContainer'
  );
  const children: NodeChildSummary[] = [
    ...childEls.map((c: AnyNode) => {
      const u = usageComponentName(program, c, context, fileRel);
      return {
        kind: 'element' as const,
        nodeId: elementNodeId(fileRel, text, c),
        tag: tagText(c.openingElement?.name),
        componentName: u.name,
        componentFile: u.file,
      };
    }),
    ...childTexts.map((c: AnyNode) => ({ kind: 'text' as const, text: c.value ?? '' })),
  ];

  return {
    nodeId,
    file: fileRel,
    tag: tagText(el.openingElement?.name),
    componentName: usage.name,
    componentFile: usage.file,
    source: text.slice(el.start, el.end),
    startLine: start.line,
    startCol: start.column,
    endLine: end.line,
    endCol: end.column,
    props,
    children,
    canEditText: !hasOther,
    ast: cloneJson(el),
  };
}

// ============================== 修改属性 ==============================

export interface PropChange {
  name: string;
  value?: unknown;
  expr?: string;
  ast?: AnyNode;
  remove?: boolean;
}

export function setPageProps(
  fileRel: string,
  text: string,
  nodeId: string,
  changes: PropChange[],
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; applied: Array<{ name: string; action: string }>; nodeId: string } {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new EditorError('INVALID_PROPS', 'props 不能为空（至少提供一对 name/value）', 400);
  }
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  if (el.type !== 'JSXElement' || !el.openingElement) {
    throw new EditorError('TARGET_NOT_ELEMENT', '目标节点不是可编辑的 JSX 元素', 400);
  }

  const applied: Array<{ name: string; action: string }> = [];
  for (const change of changes) {
    if (!change || typeof change.name !== 'string' || change.name === '') {
      throw new EditorError('INVALID_PROPS', `属性名非法：${JSON.stringify(change?.name)}`, 400);
    }
    const valueNode = buildAttrValue(change);
    const action = setAttrValue(el, change.name, valueNode);
    if (action !== 'none') applied.push({ name: change.name, action });
  }

  const updatedSource = generateSource(program);
  history?.push(fileRel, text); // 撤销快照：修改前文本
  writeProjectFile(context, fileRel, updatedSource);
  // 格式化后尽力重算该节点的 id（失败则保留旧 id，客户端重新拉页面树）
  let newId = nodeId;
  try {
    const newProgram = parseTsx(updatedSource, fileRel);
    const again = findElementById(fileRel, updatedSource, newProgram, nodeId);
    newId = elementNodeId(fileRel, updatedSource, again);
  } catch {
    /* ignore */
  }
  return { updatedSource, applied, nodeId: newId };
}

// ============================== 编辑 children ==============================

export interface SetChildrenInput {
  /** 新的纯文本 children（空字符串=清空所有子节点）。仅在 canEditText 场景允许 */
  text: string;
}

export function setPageChildren(
  fileRel: string,
  text: string,
  nodeId: string,
  input: SetChildrenInput,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; nodeId: string } {
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  if (el.type !== 'JSXElement') {
    throw new EditorError('TARGET_NOT_ELEMENT', '目标节点不是 JSX 元素，无法编辑 children', 400);
  }
  const hasElementChild = (el.children ?? []).some(
    (c: AnyNode) =>
      c?.type === 'JSXElement' || c?.type === 'JSXFragment' || c?.type === 'JSXExpressionContainer'
  );
  if (hasElementChild) {
    throw new EditorError(
      'CHILDREN_HAS_ELEMENTS',
      '该节点包含 JSX 元素/表达式子节点，不能按纯文本整体替换；请先用“删除组件/下钻”逐个处理',
      409,
      { nodeId }
    );
  }

  const newChildren: AnyNode[] =
    typeof input.text === 'string' && input.text.length > 0
      ? [{ type: 'JSXText', value: input.text }]
      : [];

  el.children = newChildren;
  if (el.closingElement) {
    // 有结束标签：清空或保留标签结构
    if (newChildren.length === 0 && el.openingElement) {
      el.openingElement.selfClosing = true;
      el.closingElement = null;
    }
  } else {
    // 原本是自闭合：需要文本/结束标签时才转成成对标签
    if (newChildren.length > 0 && el.openingElement) {
      el.openingElement.selfClosing = false;
      el.closingElement = {
        type: 'JSXClosingElement',
        name: el.openingElement.name,
      };
    }
  }

  const updatedSource = generateSource(program);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  let newId = nodeId;
  try {
    const p2 = parseTsx(updatedSource, fileRel);
    newId = elementNodeId(fileRel, updatedSource, findElementById(fileRel, updatedSource, p2, nodeId));
  } catch {
    /* 保留旧 id */
  }
  return { updatedSource, nodeId: newId };
}

// ============================== 添加 / 删除组件 ==============================

export interface AddComponentInput {
  parentNodeId?: string;
  nodeName: string;
  nodeFile: string;
  props?: PropChange[];
  /** 展示文本子节点（可选） */
  childrenText?: string;
}

export function addPageComponent(
  fileRel: string,
  text: string,
  input: AddComponentInput,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; nodeId: string } {
  if (!input || typeof input.nodeName !== 'string' || !input.nodeName) {
    throw new EditorError('INVALID_COMPONENT', '缺少 nodeName（组件名）', 400);
  }
  if (!input.nodeFile || typeof input.nodeFile !== 'string') {
    throw new EditorError('INVALID_COMPONENT', '缺少 nodeFile（组件文件路径）', 400);
  }
  const program = parseTsx(text, fileRel);

  // 1) 校验组件文件与导出形态
  const compRel = input.nodeFile.replace(/^\.?\//, '');
  const exportsInfo = componentExportsInfo(context, compRel);
  const useNamed = exportsInfo.named.has(input.nodeName);
  const useDefault = !useNamed && exportsInfo.defaultName !== null;

  // 2) 定位目标容器（父节点，默认页面根）
  let container: AnyNode | null = null;
  if (input.parentNodeId) {
    const parent = findElementById(fileRel, text, program, input.parentNodeId);
    const p = containerOf(parent);
    if (!(p.type === 'JSXElement' || p.type === 'JSXFragment')) {
      throw new EditorError('TARGET_NOT_CONTAINER', `目标节点不支持添加子组件（tag: ${tagText(parent.openingElement?.name)}）`, 400);
    }
    container = p;
  } else {
    const roots = findPageRoots(program);
    if (roots.length === 0) throw new EditorError('NO_ROOT_JSX', '页面没有可插入的根节点', 404);
    container = roots[0];
    if (container.type === 'JSXElement' && container.selfClosing) {
      throw new EditorError('ROOT_SELF_CLOSING', '页面根元素是自闭合的，无法插入子组件', 400);
    }
  }

  // 3) 保证 import
  ensureImportForComponent(program, fileRel, input.nodeName, compRel, useNamed, context);

  // 4) 构造 JSX 元素
  const usageName = input.nodeName;
  const attrs: AnyNode[] = [
    {
      type: 'JSXAttribute',
      name: jsxIdentifier('data-__editor_new'),
      value: { type: 'Literal', value: '1', raw: '"1"' },
    },
  ];
  for (const p of input.props ?? []) {
    if (!p || typeof p.name !== 'string') continue;
    const v = buildAttrValue(p);
    if (v === null) continue;
    attrs.push({ type: 'JSXAttribute', name: jsxIdentifier(p.name), value: v });
  }
  const children: AnyNode[] = [];
  if (typeof input.childrenText === 'string' && input.childrenText) {
    children.push({ type: 'JSXText', value: input.childrenText });
  }
  const newEl: AnyNode = {
    type: 'JSXElement',
    openingElement: {
      type: 'JSXOpeningElement',
      name: { type: 'JSXIdentifier', name: usageName },
      attributes: attrs,
      selfClosing: children.length === 0,
    },
    children,
    ...(children.length === 0
      ? {}
      : {
          closingElement: {
            type: 'JSXClosingElement',
            name: { type: 'JSXIdentifier', name: usageName },
          },
        }),
  };

  if (container.type === 'JSXFragment') {
    container.children.push(newEl);
  } else {
    // 元素：加在子节点末尾（若元素自闭合会先转成非自闭合）
    if (!container.closingElement) {
      if (container.openingElement) container.openingElement.selfClosing = false;
      container.closingElement = {
        type: 'JSXClosingElement',
        name: container.openingElement.name,
      };
    }
    if (!Array.isArray(container.children)) container.children = [];
    container.children.push(newEl);
  }

  // 5) 生成 -> 找回新节点 id（借助临时标记） -> 去掉标记再生成
  let first = generateSource(program);
  const firstProgram = parseTsx(first, fileRel);
  const marker = findNode(firstProgram, (n) => n.type === 'JSXElement' && hasAttr(n, 'data-__editor_new'));
  if (!marker) {
    throw new EditorError('ADD_FAILED', '插入组件失败：无法定位新增节点', 500);
  }
  const nodeId = elementNodeId(fileRel, first, marker.node);
  removeAttr(marker.node, 'data-__editor_new');
  const updatedSource = generateSource(firstProgram);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  return { updatedSource, nodeId };
}

export function removePageComponent(
  fileRel: string,
  text: string,
  nodeId: string,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string } {
  const program = parseTsx(text, fileRel);
  const hit = findNodeWithId(program, fileRel, text, nodeId);
  const node = hit.node;
  const isRoot = findPageRoots(program).some((r) => r === node);
  if (isRoot) {
    throw new EditorError('REMOVE_ROOT', '不能删除页面的根节点', 400);
  }
  if (hit.parent && (hit.parent.type === 'JSXElement' || hit.parent.type === 'JSXFragment')) {
    // children 数组中移除
    const children = hit.parent.children ?? [];
    const idx = children.indexOf(node);
    if (idx >= 0) children.splice(idx, 1);
    else throw new EditorError('REMOVE_FAILED', '无法在父节点子列表中定位该节点', 500);
  } else {
    throw new EditorError('REMOVE_FAILED', '该节点没有可移除的父容器（不支持的删除位置）', 400);
  }
  const updatedSource = generateSource(program);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  return { updatedSource };
}

function findNodeWithId(program: AnyNode, fileRel: string, text: string, nodeId: string): NodePathInfo {
  const span = decodeNodeId(nodeId);
  if (!span) throw new EditorError('INVALID_NODE_ID', `data-node-id 无法解码：${nodeId}`, 400);
  const startOffset = pointToOffset(text, { line: span.startLine, column: span.startCol });
  const endOffset = pointToOffset(text, { line: span.endLine, column: span.endCol });
  const hits = findNodes(program, (n) => n.type === 'JSXElement' && !!n.openingElement);
  for (const h of hits) {
    if (h.node.openingElement.start === startOffset && elementEndOffset(h.node) === endOffset) return h;
  }
  for (const h of hits) {
    if (h.node.openingElement.start === startOffset) return h;
  }
  throw new EditorError('NODE_NOT_FOUND', `在 ${fileRel} 中找不到该节点（可能文件已被修改）`, 404, { nodeId });
}

/** 确保页面文件已 import 该组件（named 或 default），否则插入 import 语句 */
function ensureImportForComponent(
  program: AnyNode,
  pageRel: string,
  nodeName: string,
  compRel: string,
  useNamed: boolean,
  context: ResolveContext
): void {
  const bindings = collectBindings(program);
  const existing = bindings.get(nodeName);
  const moduleSpec = pageImportSpecifier(pageRel, compRel);

  // 已有同名绑定：若来自同一模块即可复用（不重复 import）
  if (existing) {
    const existingRel = resolveLocalModule(existing.source, pageRel, context);
    if (existingRel === compRel) return;
    throw new EditorError(
      'IMPORT_CONFLICT',
      `页面中已存在名为 ${nodeName} 的绑定，且来自 ${existing.source}，与目标组件 ${compRel} 冲突`,
      409,
      { nodeName, existingSource: existing.source, target: compRel }
    );
  }

  let specifier: AnyNode;
  if (useNamed) {
    specifier = {
      type: 'ImportSpecifier',
      imported: { type: 'Identifier', name: nodeName },
      local: { type: 'Identifier', name: nodeName },
    };
  } else {
    specifier = {
      type: 'ImportDefaultSpecifier',
      local: { type: 'Identifier', name: nodeName },
    };
  }

  const importDecl: AnyNode = {
    type: 'ImportDeclaration',
    specifiers: [specifier],
    source: { type: 'Literal', value: moduleSpec, raw: JSON.stringify(moduleSpec) },
  };
  // 插到首个 import 之后（保持 import 聚合）
  let insertAt = 0;
  for (let i = 0; i < (program.body?.length ?? 0); i++) {
    if (program.body[i]?.type === 'ImportDeclaration') insertAt = i + 1;
  }
  program.body.splice(insertAt, 0, importDecl);
}

// ============================== 复制 / 粘贴 ==============================

export interface CopyResult {
  nodeId: string;
  file: string;
  tag: string;
  source: string;
  /** 克隆的 JSX 子树（已剔除 data-node-* / data-__editor_* 标记） */
  element: AnyNode;
}

export function copyNodeSubtree(fileRel: string, text: string, nodeId: string, context: ResolveContext): CopyResult {
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  const clone = cloneJson(el);
  stripEditorMarkers(clone);
  return {
    nodeId,
    file: fileRel,
    tag: tagText(el.openingElement?.name),
    source: text.slice(el.start, el.end),
    element: clone,
  };
}

function stripEditorMarkers(node: AnyNode): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'JSXOpeningElement' && Array.isArray(node.attributes)) {
    node.attributes = node.attributes.filter((a: AnyNode) => {
      if (a.type !== 'JSXAttribute') return true;
      const n = a.name?.name ?? '';
      return !(n === 'data-__editor_new' || n.startsWith('data-node-'));
    });
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => stripEditorMarkers(c));
    else if (v && typeof v === 'object') stripEditorMarkers(v);
  }
}

/** 把克隆的 JSX 子树插入目标页面；自动为目标页补 import（以来源页的绑定为准） */
export function pasteNodeSubtree(
  targetRel: string,
  targetText: string,
  parentNodeId: string | undefined,
  element: AnyNode,
  originFile: string,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; nodeId: string } {
  const program = parseTsx(targetText, targetRel);
  let container: AnyNode | null = null;
  if (parentNodeId) {
    const parent = findElementById(targetRel, targetText, program, parentNodeId);
    container = containerOf(parent);
    if (!(container.type === 'JSXElement' || container.type === 'JSXFragment')) {
      throw new EditorError('TARGET_NOT_CONTAINER', '目标节点不支持粘贴子内容', 400);
    }
  } else {
    const roots = findPageRoots(program);
    if (roots.length === 0) throw new EditorError('NO_ROOT_JSX', '目标页面没有可插入的根节点', 404);
    container = roots[0];
    if (container.type === 'JSXElement' && container.selfClosing) {
      throw new EditorError('ROOT_SELF_CLOSING', '目标页面根节点为自闭合元素', 400);
    }
  }

  // 来源页绑定 -> 目标页 import 补齐
  const clone = cloneJson(element);
  const originText = readProjectFile(context, originFile);
  const originProgram = parseTsx(originText, originFile);
  ensureImportsFromOrigin(program, targetRel, clone, originProgram, originFile, context);

  // 标记插入
  if (clone.type !== 'JSXElement') throw new EditorError('CLIPBOARD_INVALID', '剪贴板内容不是 JSX 元素', 400);
  const attrs = clone.openingElement?.attributes ?? [];
  attrs.unshift({
    type: 'JSXAttribute',
    name: jsxIdentifier('data-__editor_new'),
    value: { type: 'Literal', value: '1', raw: '"1"' },
  });

  if (container.type === 'JSXFragment') {
    container.children.push(clone);
  } else {
    // yuku：selfClosing 在 openingElement 上，closingElement 缺失代表自闭合
    if (!container.closingElement) {
      if (container.openingElement) container.openingElement.selfClosing = false;
      container.closingElement = { type: 'JSXClosingElement', name: container.openingElement.name };
    }
    if (!Array.isArray(container.children)) container.children = [];
    container.children.push(clone);
  }

  let first = generateSource(program);
  const firstProgram = parseTsx(first, targetRel);
  const marker = findNode(firstProgram, (n) => n.type === 'JSXElement' && hasAttr(n, 'data-__editor_new'));
  if (!marker) throw new EditorError('PASTE_FAILED', '粘贴失败：无法定位新节点', 500);
  const nodeId = elementNodeId(targetRel, first, marker.node);
  removeAttr(marker.node, 'data-__editor_new');
  const updatedSource = generateSource(firstProgram);
  history?.push(targetRel, targetText);
  writeProjectFile(context, targetRel, updatedSource);
  return { updatedSource, nodeId };
}

/** 依据来源页 import 绑定，为目标页补齐所需的组件 import */
function ensureImportsFromOrigin(
  targetProgram: AnyNode,
  targetRel: string,
  clone: AnyNode,
  originProgram: AnyNode,
  originFile: string,
  context: ResolveContext
): void {
  const targetBindings = collectBindings(targetProgram);
  const originBindings = collectBindings(originProgram);
  const needed = new Map<string, { imported?: string; kind: string; source: string }>(); // local -> binding

  walk(clone, (n) => {
    if (!n) return undefined;
    if (n.type !== 'JSXElement') return undefined;
    const tag = n.openingElement?.name;
    if (!tag) return undefined;
    if (tag.type === 'JSXIdentifier' && /^[a-z]/.test(tag.name)) return undefined;
    const root = tag.type === 'JSXIdentifier' ? tag.name : memberRootOf(tag);
    if (!root) return undefined;
    const b = originBindings.get(root);
    if (!b) return undefined;
    const compFile = resolveLocalModule(b.source, originFile, context);
    if (!compFile) return undefined; // 外部包/不可解析：跳过
    if (tag.type === 'JSXMemberExpression') {
      needed.set(root, { kind: 'namespace', source: compFile });
      return undefined;
    }
    if (!needed.has(root)) needed.set(root, { ...b, source: compFile });
    return undefined;
  });

  for (const [localName, b] of needed) {
    const existing = targetBindings.get(localName);
    if (existing) {
      const existingRel = resolveLocalModule(existing.source, targetRel, context);
      if (existingRel === b.source) continue; // 已存在同源
      throw new EditorError('IMPORT_CONFLICT', `粘贴内容需要本地名 ${localName}（来自 ${b.source}），但与目标页现有绑定冲突`, 409);
    }
    let spec: AnyNode;
    const moduleSpec = pageImportSpecifier(targetRel, b.source);
    if (b.kind === 'namespace') {
      spec = { type: 'ImportNamespaceSpecifier', local: { type: 'Identifier', name: localName } };
    } else if (b.kind === 'default') {
      spec = { type: 'ImportDefaultSpecifier', local: { type: 'Identifier', name: localName } };
    } else {
      spec = {
        type: 'ImportSpecifier',
        imported: { type: 'Identifier', name: b.imported ?? localName },
        local: { type: 'Identifier', name: localName },
      };
    }
    const decl: AnyNode = {
      type: 'ImportDeclaration',
      specifiers: [spec],
      source: { type: 'Literal', value: moduleSpec, raw: JSON.stringify(moduleSpec) },
    };
    let insertAt = 0;
    for (let i = 0; i < (targetProgram.body?.length ?? 0); i++) {
      if (targetProgram.body[i]?.type === 'ImportDeclaration') insertAt = i + 1;
    }
    targetProgram.body.splice(insertAt, 0, decl);
  }
}

function memberRootOf(tag: AnyNode): string | null {
  let obj: AnyNode = tag;
  while (obj.type === 'JSXMemberExpression') obj = obj.object;
  return obj.type === 'JSXIdentifier' ? obj.name : null;
}

/** 历史应用（undo/redo）：写回并返回结果 */
export function applyHistory(
  context: ResolveContext,
  history: PageHistory,
  rel: string,
  currentText: string,
  mode: 'undo' | 'redo'
): { updatedSource: string; history: { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number } } {
  const prev = mode === 'undo' ? history.undo(rel, currentText) : history.redo(rel, currentText);
  if (prev === null) {
    throw new EditorError('NO_HISTORY', mode === 'undo' ? '没有可撤销的历史' : '没有可重做的历史', 404);
  }
  // 校验回退内容可解析，避免把坏内容写盘
  parseTsx(prev, rel);
  writeProjectFile(context, rel, prev);
  return { updatedSource: prev, history: history.stats(rel) };
}

// 便捷导出
export { absFromRoot };
