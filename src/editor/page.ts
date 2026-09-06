import { EditorError, parseTsx, generateSource, AnyNode, cloneJson, collectBindings, analyzeExports, jsxIdentifier, unwrapExpr, walk, findNodes, parseExpressionText, NodePathInfo } from './common';
import { offsetToPoint, pointToOffset, elementEndOffset } from './common';
import { ResolveContext, resolveLocalModule, readProjectFile, writeProjectFile, pageImportSpecifier } from './paths';
import { decodeNodeId, encodeNodeId } from '../nodeId';
import { PageHistory } from './history';
import { ensureSubtreeImports } from './importGuard';

/** 可下钻的直接子 JSX 元素 */
export interface ElementChild {
  kind: 'element';
  nodeId: string;
  tag: string;
  componentName?: string;
  componentFile?: string;
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
    /** 属性名；children 是特殊属性（type='children'，childrenValue=完整源码） */
    name: string;
    /** 值类型：literal | boolean | expression | children | spread */
    type: string;
    value?: unknown;
    valueText?: string;
    ast?: AnyNode;
    childrenValue?: string;
  }>;
  /** children 完整源码（顶层快捷字段；含文本/表达式/ReactNode/JSX 注释，原样保留） */
  childrenValue?: string;
  /** 直接子 JSX 元素摘要（供下钻/删除；不做内容过滤） */
  elementChildren?: ElementChild[];
  /** 组件节点的 JSON Schema（服务端 GET /node/{id} 内嵌） */
  schema?: unknown;
  ast: AnyNode;
}

// ============================== 定位 / id ==============================

export function elementNodeId(fileRel: string, text: string, el: AnyNode): string {
  const start = offsetToPoint(text, el.openingElement.start);
  const end = offsetToPoint(text, elementEndOffset(el));
  return encodeNodeId(
    fileRel,
    { line: start.line, column: start.column },
    { line: end.line, column: end.column }
  );
}

export function isPageFile(fileRel: string, pagesDir: string): boolean {
  return fileRel.startsWith(pagesDir + '/') && /\.(tsx|jsx)$/.test(fileRel);
}

function decodeNodeSpan(nodeId: string): { file: string; startLine: number; startCol: number; endLine: number; endCol: number } {
  const span = decodeNodeId(nodeId);
  if (!span) throw new EditorError('INVALID_NODE_ID', `data-node-id 无法解码：${nodeId}`, 400);
  return span;
}

export function findElementById(fileRel: string, text: string, program: AnyNode, nodeId: string): AnyNode {
  const span = decodeNodeSpan(nodeId);
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
    if (node.openingElement.start === startOffset && elementEndOffset(node) === endOffset) return node;
  }
  for (const { node } of hits) {
    if (node.openingElement.start === startOffset) return node;
  }
  throw new EditorError('NODE_NOT_FOUND', `在 ${fileRel} 中找不到该节点（可能文件已被修改，请刷新页面树）`, 404, { nodeId, startLine: span.startLine, startCol: span.startCol });
}

// ============================== 组件解析 ==============================

export function usageComponentName(
  program: AnyNode,
  el: AnyNode,
  context: ResolveContext,
  fileRel: string
): { name?: string; file?: string } {
  const tag = el?.openingElement?.name;
  if (!tag) return {};
  const bindings = collectBindings(program);

  const resolveLocal = (source: string): string | null =>
    resolveLocalModule(source, fileRel, context);

  if (tag.type === 'JSXIdentifier') {
    if (/^[a-z]/.test(tag.name)) return {};
    const binding = bindings.get(tag.name);
    if (!binding) return {};
    const compFile = resolveLocal(binding.source);
    if (!compFile) return {};
    if (binding.kind === 'named') return { name: binding.imported ?? tag.name, file: compFile };
    if (binding.kind === 'default') {
      const info = componentExportsInfo(context, compFile);
      return { name: info.defaultName ?? tag.name, file: compFile };
    }
    return { file: compFile };
  }
  if (tag.type === 'JSXMemberExpression') {
    let obj: AnyNode = tag;
    while (obj.type === 'JSXMemberExpression') obj = obj.object;
    if (obj.type === 'JSXIdentifier') {
      const binding = bindings.get(obj.name);
      if (binding?.kind === 'namespace') {
        const compFile = resolveLocal(binding.source);
        if (compFile && tag.property?.name) return { name: tag.property.name, file: compFile };
      }
    }
  }
  return {};
}

export function componentExportsInfo(context: ResolveContext, compRel: string): { named: Set<string>; defaultName: string | null } {
  const text = readProjectFile(context, compRel);
  return analyzeExports(parseTsx(text, compRel));
}

export function defaultExportName(context: ResolveContext, compRel: string): string | null {
  return componentExportsInfo(context, compRel).defaultName;
}

// ============================== 根元素 / 树 ==============================

function unwrapRootElement(n: AnyNode): AnyNode {
  return unwrapExpr(n);
}

export function findPageRoots(program: AnyNode): AnyNode[] {
  const roots: AnyNode[] = [];

  const collectFromFn = (fn: AnyNode) => {
    if (!fn) return;
    const pushRoot = (arg: AnyNode) => {
      const node = unwrapRootElement(arg);
      if (node && (node.type === 'JSXElement' || node.type === 'JSXFragment') && !roots.includes(node)) {
        roots.push(node);
      }
    };
    const visit = (n: AnyNode) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.type === 'string') {
        if (n !== fn && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')) {
          return;
        }
        if (n.type === 'ReturnStatement') {
          pushRoot(n.argument);
          return;
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'parent' || k === 'loc') continue;
        const v = n[k];
        if (Array.isArray(v)) for (const item of v) visit(item);
        else if (v && typeof v === 'object') visit(v);
      }
    };
    visit(fn);
  };

  for (const stmt of program.body ?? []) {
    if (stmt?.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d?.type === 'FunctionDeclaration' || d?.type === 'ArrowFunctionExpression' || d?.type === 'FunctionExpression') {
        collectFromFn(d);
      } else if (d?.type === 'Identifier') {
        const hit = findNodes(program, (n) => (n?.type === 'FunctionDeclaration' || n?.type === 'VariableDeclarator') && n.id?.name === d.name);
        if (hit[0]) collectFromFn(hit[0].node.type === 'VariableDeclarator' ? hit[0].node.init : hit[0].node);
      }
    }
  }
  if (roots.length > 0) return roots;

  const fns = findNodes(program, (n) => (n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression') && /^[A-Z]/.test(n?.id?.name ?? ''));
  for (const { node } of fns) {
    if (roots.length > 0) break;
    collectFromFn(node);
  }
  return roots;
}

function containerOf(el: AnyNode): AnyNode {
  return el;
}

function tagText(name: AnyNode): string {
  if (!name) return '#unknown';
  if (name.type === 'JSXIdentifier') return name.name;
  const parts: string[] = [];
  const walkMember = (m: AnyNode) => {
    if (m.type === 'JSXMemberExpression') {
      walkMember(m.object);
      parts.push(m.property?.name ?? '');
    } else if (m.type === 'JSXIdentifier') parts.push(m.name);
  };
  walkMember(name);
  return parts.join('.');
}

export interface TreeNode {
  kind: 'element' | 'text';
  tag?: string;
  id?: string;
  componentName?: string;
  componentFile?: string;
  attrs?: Array<{ name: string; type: string }>;
  children?: TreeNode[];
  text?: string;
}

function buildTreeNodes(nodes: AnyNode[], fileRel: string, text: string, program: AnyNode, context: ResolveContext): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (!node) continue;
    if (node.type === 'JSXText') {
      const t = node.value ?? '';
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
    const attrs = (node.openingElement?.attributes ?? []).map((a: AnyNode) =>
      a.type === 'JSXSpreadAttribute'
        ? { name: '...', type: 'spread' }
        : { name: a.name?.name ?? '?', type: 'literal' }
    );
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
  if (roots.length === 0) throw new EditorError('NO_ROOT_JSX', `页面 ${fileRel} 没有找到可编辑的 JSX 根`, 404);
  return buildTreeNodes(roots, fileRel, text, program, context);
}

// ============================== 节点信息 ==============================

export function getNodeSource(fileRel: string, text: string, nodeId: string, context: ResolveContext): NodeSourceResult {
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  const usage = usageComponentName(program, el, context, fileRel);
  const start = offsetToPoint(text, el.start);
  const end = offsetToPoint(text, el.end);

  // children 完整源码（原样）
  let childrenValue = '';
  const kids = el.children ?? [];
  if (kids.length > 0 && kids[0].start != null && kids[kids.length - 1].end != null) {
    childrenValue = text.slice(kids[0].start, kids[kids.length - 1].end);
  }
  const elementChildren: ElementChild[] = kids
    .filter((c: AnyNode) => c?.type === 'JSXElement')
    .map((c: AnyNode) => {
      const u = usageComponentName(program, c, context, fileRel);
      return {
        kind: 'element' as const,
        nodeId: elementNodeId(fileRel, text, c),
        tag: tagText(c.openingElement?.name),
        componentName: u.name,
        componentFile: u.file,
      };
    });

  const props: NodeSourceResult['props'] = (el.openingElement?.attributes ?? []).map((attr: AnyNode) => {
    const name = attr.type === 'JSXSpreadAttribute' ? '...' : attr.name?.name ?? '?';
    if (attr.type === 'JSXSpreadAttribute') {
      const arg = attr.argument;
      return {
        name,
        type: 'spread',
        valueText: arg ? text.slice(arg.start ?? el.start, arg.end ?? el.start) : undefined,
        ast: arg ? cloneJson(arg) : undefined,
      };
    }
    const result: any = { name, type: 'literal' };
    const value = attr.value;
    if (!value) {
      result.type = 'boolean';
      result.value = true;
    } else if (value.type === 'Literal') {
      result.type = 'literal';
      result.value = value.value;
      result.valueText = text.slice(value.start, value.end);
    } else if (value.type === 'JSXExpressionContainer') {
      const inner = unwrapExpr(value.expression);
      result.type = 'expression';
      result.ast = cloneJson(inner);
      result.valueText = text.slice(value.start, value.end);
      if (inner.type === 'Literal') result.value = inner.value;
    }
    return result;
  });
  props.push({ name: 'children', type: 'children', childrenValue });

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
    childrenValue,
    elementChildren,
    ast: cloneJson(el),
  };
}

// ============================== 修改属性 ==============================

export interface PropChange {
  name: string;
  /** expression 或 expr（兼容旧写法）时按表达式处理 */
  type?: string;
  value?: unknown;
  expr?: string;
  expression?: string;
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
    if (!change || typeof change.name !== 'string' || !change.name) {
      throw new EditorError('INVALID_PROPS', '属性名非法', 400);
    }
    // children 走 children 接口，不在此处理
    if (change.name === 'children') {
      throw new EditorError('INVALID_PROPS', 'children 是特殊属性，请使用 POST /node/{id}/children/source 编辑', 400);
    }
    const valueNode = buildAttrValueNode(change);
    const existing = findAttr(el, change.name);
    if (valueNode === null) {
      if (removeAttrByName(el, change.name)) applied.push({ name: change.name, action: 'remove' });
    } else if (existing) {
      existing.value = valueNode;
      applied.push({ name: change.name, action: 'set' });
    } else {
      el.openingElement.attributes.push({
        type: 'JSXAttribute',
        name: jsxIdentifier(change.name),
        value: valueNode,
      });
      applied.push({ name: change.name, action: 'add' });
    }
  }

  // import 前置校验/补齐：只扫描本次修改影响的属性值（解析不到则抛错、不写盘）
  const touched = applied
    .map((a) => findAttr(el, a.name)?.value)
    .filter((v): v is AnyNode => !!v);
  if (touched.length > 0) ensureSubtreeImports(program, touched, fileRel, context);

  // 临时哨兵定位：guard 可能补 import 前插行，旧 nodeId 不再可靠
  pushSentinel(el);
  const interim = generateSource(program);
  const interimP = parseTsx(interim, fileRel);
  const keep = findNodes(interimP, (n) => n.type === 'JSXElement' && findAttr(n, SENTINEL))[0]?.node;
  if (!keep) throw new EditorError('WRITE_FAILED', '写入失败：无法定位修改后的节点', 500);
  const newId = elementNodeId(fileRel, interim, keep);
  removeAttrByName(keep, SENTINEL);
  const updatedSource = generateSource(interimP);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  return { updatedSource, applied, nodeId: newId };
}

const SENTINEL = 'data-__editor_keep';

function findAttr(el: AnyNode, name: string): AnyNode | null {
  return (
    (el.openingElement?.attributes ?? []).find(
      (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === name
    ) ?? null
  );
}

function removeAttrByName(el: AnyNode, name: string): boolean {
  const attrs = el.openingElement?.attributes;
  if (!Array.isArray(attrs)) return false;
  const idx = attrs.findIndex(
    (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === name
  );
  if (idx === -1) return false;
  attrs.splice(idx, 1);
  return true;
}

function pushSentinel(el: AnyNode): void {
  (el.openingElement?.attributes ?? []).push({
    type: 'JSXAttribute',
    name: jsxIdentifier(SENTINEL),
    value: { type: 'Literal', value: '1', raw: '"1"' },
  });
}

function exprAttrValue(expression: AnyNode): AnyNode {
  return { type: 'JSXExpressionContainer', expression };
}

function literalValueNode(value: unknown): AnyNode {
  if (typeof value === 'string') {
    return { type: 'Literal', value, raw: JSON.stringify(value) };
  }
  return {
    type: 'Literal',
    value,
    raw:
      value === null
        ? 'null'
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value),
  };
}

function buildAttrValueNode(item: PropChange): AnyNode | null {
  const explicit = item.type === 'expression' || item.type === 'expr';
  if (item.remove === true || (item.value === undefined && item.expr === undefined && item.expression === undefined && item.ast === undefined)) {
    return null;
  }
  if (explicit) {
    const v = item.value;
    let expr: AnyNode;
    if (v && typeof v === 'object' && typeof (v as AnyNode).type === 'string') {
      expr = v as AnyNode;
    } else if (typeof v === 'string' && v.trim() !== '') {
      expr = parseExpressionText(v);
    } else if (item.ast !== undefined) {
      expr = item.ast;
    } else if (item.expression !== undefined) {
      expr = parseExpressionText(String(item.expression));
    } else if (item.expr !== undefined) {
      expr = parseExpressionText(String(item.expr));
    } else {
      throw new EditorError('INVALID_EXPRESSION', '表达式属性的 value 必须是 AST JSON 或非空表达式字符串', 400);
    }
    return exprAttrValue(expr);
  }
  let expr: AnyNode;
  if (item.ast !== undefined) {
    expr = item.ast;
  } else if (item.expr !== undefined) {
    expr = parseExpressionText(String(item.expr));
  } else if (item.expression !== undefined) {
    expr = parseExpressionText(String(item.expression));
  } else {
    const v = item.value;
    if (typeof v === 'string') return literalValueNode(v);
    if (typeof v === 'number') return exprAttrValue(literalValueNode(v));
    if (typeof v === 'boolean' || v === null) return exprAttrValue(literalValueNode(v));
    if (v === undefined) return null;
    try {
      expr = parseExpressionText(JSON.stringify(v));
    } catch {
      expr = parseExpressionText(String(v));
    }
  }
  if (expr.type === 'Literal' && typeof expr.value === 'string') {
    return literalValueNode(expr.value);
  }
  return exprAttrValue(expr);
}

// ============================== 编辑 children（源码级） ==============================

export interface SetChildrenInput {
  /** children 的源码片段（可为文本 / 表达式 / 任意 ReactNode / 空串清空） */
  source: string;
}

/** 用 children 源码替换整个 children（支持任意 JSX children，不再只限纯文本） */
export function setPageChildrenSource(
  fileRel: string,
  text: string,
  nodeId: string,
  input: SetChildrenInput,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; nodeId: string; childrenValue: string } {
  const program = parseTsx(text, fileRel);
  const el = findElementById(fileRel, text, program, nodeId);
  if (el.type !== 'JSXElement') {
    throw new EditorError('TARGET_NOT_ELEMENT', '目标节点不是 JSX 元素，无法编辑 children', 400);
  }
  const source = input?.source ?? '';

  let newChildren: AnyNode[] = [];
  if (source.trim() !== '') {
    const wrapped = `<>${source}</>`;
    const fragProgram = parseTsx(wrapped, fileRel);
    const stmt = fragProgram.body?.[0];
    const root = stmt?.type === 'ExpressionStatement' ? stmt.expression : null;
    const fragment = root && root.type === 'JSXFragment' ? root : null;
    if (!fragment) {
      throw new EditorError('PARSE_ERROR', 'children 源码解析失败：不是一个合法的 JSX children 片段', 422);
    }
    newChildren = fragment.children ?? [];
  }

  el.children = newChildren;
  if (newChildren.length > 0) {
    if (!el.closingElement) {
      if (el.openingElement) el.openingElement.selfClosing = false;
      el.closingElement = { type: 'JSXClosingElement', name: el.openingElement.name };
    }
  } else {
    // 允许保留成对标签（空 children）；也可转为自闭合
    if (el.openingElement && !el.closingElement) {
      /* 本来就是自闭合：保持 */
    }
  }

  // children 引用校验/补齐（含自定义组件与表达式标识符；解析不到则抛错不写盘）
  if (newChildren.length > 0) ensureSubtreeImports(program, newChildren, fileRel, context);

  // 哨兵定位 + 从生成文本切出 children 源码
  pushSentinel(el);
  const interim = generateSource(program);
  const interimP = parseTsx(interim, fileRel);
  const keep = findNodes(interimP, (n) => n.type === 'JSXElement' && findAttr(n, SENTINEL))[0]?.node;
  if (!keep) throw new EditorError('WRITE_FAILED', '写入失败：无法定位修改后的节点', 500);
  const newId = elementNodeId(fileRel, interim, keep);

  let childrenValue = '';
  const kKids = keep.children ?? [];
  if (kKids.length > 0 && kKids[0].start != null && kKids[kKids.length - 1].end != null) {
    childrenValue = interim.slice(kKids[0].start, kKids[kKids.length - 1].end);
  }

  removeAttrByName(keep, SENTINEL);
  const updatedSource = generateSource(interimP);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  return { updatedSource, nodeId: newId, childrenValue };
}

/** 兼容旧名：setPageChildren == setPageChildrenSource */
export function setPageChildren(
  fileRel: string,
  text: string,
  nodeId: string,
  input: { text?: string; source?: string },
  context: ResolveContext,
  history?: PageHistory
) {
  return setPageChildrenSource(fileRel, text, nodeId, { source: input.source ?? input.text ?? '' }, context, history);
}

// ============================== 添加 / 删除组件 ==============================

export interface AddComponentInput {
  parentNodeId?: string;
  nodeName: string;
  nodeFile: string;
  props?: PropChange[];
  childrenText?: string;
}

export function addPageComponent(
  fileRel: string,
  text: string,
  input: AddComponentInput,
  context: ResolveContext,
  history?: PageHistory
): { updatedSource: string; nodeId: string } {
  if (!input?.nodeName) throw new EditorError('INVALID_COMPONENT', '缺少 nodeName（组件名）', 400);
  if (!input.nodeFile) throw new EditorError('INVALID_COMPONENT', '缺少 nodeFile（组件文件路径）', 400);

  const program = parseTsx(text, fileRel);
  const compRel = String(input.nodeFile).replace(/^\.?\//, '');
  const exportsInfo = componentExportsInfo(context, compRel);
  const useNamed = exportsInfo.named.has(input.nodeName);

  let container: AnyNode | null = null;
  if (input.parentNodeId) {
    const parent = findElementById(fileRel, text, program, input.parentNodeId);
    container = containerOf(parent);
    if (container.type !== 'JSXElement' && container.type !== 'JSXFragment') {
      throw new EditorError('TARGET_NOT_CONTAINER', '目标节点不支持添加子组件', 400);
    }
  } else {
    const roots = findPageRoots(program);
    if (roots.length === 0) throw new EditorError('NO_ROOT_JSX', '页面没有可插入的根节点', 404);
    container = roots[0];
  }

  ensureImportForComponent(program, fileRel, input.nodeName, compRel, useNamed, context);

  const attrs: AnyNode[] = [
    {
      type: 'JSXAttribute',
      name: jsxIdentifier('data-__editor_new'),
      value: { type: 'Literal', value: '1', raw: '"1"' },
    },
  ];
  for (const p of input.props ?? []) {
    if (!p || typeof p.name !== 'string') continue;
    if (p.name === 'children') continue;
    const v = buildAttrValueNode(p);
    if (v === null) continue;
    attrs.push({ type: 'JSXAttribute', name: jsxIdentifier(p.name), value: v });
  }
  const children: AnyNode[] = [];
  if (typeof input.childrenText === 'string' && input.childrenText) {
    children.push({ type: 'JSXText', value: input.childrenText });
  }
  const openName = { type: 'JSXIdentifier', name: input.nodeName };
  const newEl: AnyNode = {
    type: 'JSXElement',
    openingElement: { type: 'JSXOpeningElement', name: openName, attributes: attrs, selfClosing: children.length === 0 },
    children,
    ...(children.length
      ? { closingElement: { type: 'JSXClosingElement', name: openName } }
      : {}),
  };

  if (container.type === 'JSXFragment') {
    container.children.push(newEl);
  } else {
    if (!container.closingElement) {
      if (container.openingElement) container.openingElement.selfClosing = false;
      container.closingElement = { type: 'JSXClosingElement', name: container.openingElement.name };
    }
    if (!Array.isArray(container.children)) container.children = [];
    container.children.push(newEl);
  }

  // 新增子树引用校验/补齐（根组件 import 由 ensureImportForComponent 负责，其余自动补/报错）
  ensureSubtreeImports(program, [newEl], fileRel, context);

  let first = generateSource(program);
  const firstProgram = parseTsx(first, fileRel);
  const marker = findNodes(firstProgram, (n) => n.type === 'JSXElement' && findAttr(n, 'data-__editor_new'))[0]?.node;
  if (!marker) throw new EditorError('ADD_FAILED', '插入组件失败：无法定位新增节点', 500);
  const nodeId = elementNodeId(fileRel, first, marker);
  removeAttrByName(marker, 'data-__editor_new');
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
  const roots = findPageRoots(program);
  if (roots.some((r) => r === node)) throw new EditorError('REMOVE_ROOT', '不能删除页面的根节点', 400);
  if (hit.parent && (hit.parent.type === 'JSXElement' || hit.parent.type === 'JSXFragment')) {
    const children = hit.parent.children ?? [];
    const idx = children.indexOf(node);
    if (idx === -1) throw new EditorError('REMOVE_FAILED', '无法在父节点子列表中定位该节点', 500);
    children.splice(idx, 1);
  } else {
    throw new EditorError('REMOVE_FAILED', '该节点没有可移除的父容器', 400);
  }
  const updatedSource = generateSource(program);
  history?.push(fileRel, text);
  writeProjectFile(context, fileRel, updatedSource);
  return { updatedSource };
}

function findNodeWithId(program: AnyNode, fileRel: string, text: string, nodeId: string): NodePathInfo {
  const span = decodeNodeSpan(nodeId);
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
  if (existing) {
    const existingRel = resolveLocalModule(existing.source, pageRel, context);
    if (existingRel === compRel) return;
    throw new EditorError('IMPORT_CONFLICT', `页面中已存在名为 ${nodeName} 的绑定，且来自 ${existing.source}，与目标组件 ${compRel} 冲突`, 409, { nodeName, existingSource: existing.source, target: compRel });
  }
  const specifier: AnyNode = useNamed
    ? { type: 'ImportSpecifier', imported: { type: 'Identifier', name: nodeName }, local: { type: 'Identifier', name: nodeName } }
    : { type: 'ImportDefaultSpecifier', local: { type: 'Identifier', name: nodeName } };
  const decl: AnyNode = {
    type: 'ImportDeclaration',
    specifiers: [specifier],
    source: { type: 'Literal', value: moduleSpec, raw: JSON.stringify(moduleSpec) },
  };
  let insertAt = 0;
  for (let i = 0; i < (program.body?.length ?? 0); i++) {
    if (program.body[i]?.type === 'ImportDeclaration') insertAt = i + 1;
  }
  program.body.splice(insertAt, 0, decl);
}

// ============================== 复制 / 粘贴 ==============================

export interface CopyResult {
  nodeId: string;
  file: string;
  tag: string;
  source: string;
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
      return n !== 'data-__editor_new' && !n.startsWith('data-node-');
    });
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => stripEditorMarkers(c));
    else if (v && typeof v === 'object') stripEditorMarkers(v);
  }
}

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
    if (container.type !== 'JSXElement' && container.type !== 'JSXFragment') {
      throw new EditorError('TARGET_NOT_CONTAINER', '目标节点不支持粘贴子内容', 400);
    }
  } else {
    const roots = findPageRoots(program);
    if (roots.length === 0) throw new EditorError('NO_ROOT_JSX', '目标页面没有可插入的根节点', 404);
    container = roots[0];
  }

  const clone = cloneJson(element);
  const originText = readProjectFile(context, originFile);
  const originProgram = parseTsx(originText, originFile);
  ensureImportsFromOrigin(program, targetRel, clone, originProgram, originFile, context);

  if (clone.type !== 'JSXElement') throw new EditorError('CLIPBOARD_INVALID', '剪贴板内容不是 JSX 元素', 400);
  (clone.openingElement?.attributes ?? []).unshift({
    type: 'JSXAttribute',
    name: jsxIdentifier('data-__editor_new'),
    value: { type: 'Literal', value: '1', raw: '"1"' },
  });

  if (container.type === 'JSXFragment') {
    container.children.push(clone);
  } else {
    if (!container.closingElement) {
      if (container.openingElement) container.openingElement.selfClosing = false;
      container.closingElement = { type: 'JSXClosingElement', name: container.openingElement.name };
    }
    if (!Array.isArray(container.children)) container.children = [];
    container.children.push(clone);
  }

  // 粘贴子树引用校验/补齐
  ensureSubtreeImports(program, [clone], targetRel, context);

  const first = generateSource(program);
  const firstProgram = parseTsx(first, targetRel);
  const marker = findNodes(firstProgram, (n) => n.type === 'JSXElement' && findAttr(n, 'data-__editor_new'))[0]?.node;
  if (!marker) throw new EditorError('PASTE_FAILED', '粘贴失败：无法定位新节点', 500);
  const nodeId = elementNodeId(targetRel, first, marker);
  removeAttrByName(marker, 'data-__editor_new');
  const updatedSource = generateSource(firstProgram);
  history?.push(targetRel, targetText);
  writeProjectFile(context, targetRel, updatedSource);
  return { updatedSource, nodeId };
}

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
  const needed = new Map<string, { imported?: string; kind: string; source: string }>();

  const memberRoot = (tag: AnyNode): string | null => {
    let obj: AnyNode = tag;
    while (obj.type === 'JSXMemberExpression') obj = obj.object;
    return obj.type === 'JSXIdentifier' ? obj.name : null;
  };

  walk(clone, (n) => {
    if (!n || n.type !== 'JSXElement') return undefined;
    const tag = n.openingElement?.name;
    if (!tag) return undefined;
    if (tag.type === 'JSXIdentifier' && /^[a-z]/.test(tag.name)) return undefined;
    const root = tag.type === 'JSXIdentifier' ? tag.name : memberRoot(tag);
    if (!root) return undefined;
    const b = originBindings.get(root);
    if (!b) return undefined;
    const compFile = resolveLocalModule(b.source, originFile, context);
    if (!compFile) return undefined;
    if (!needed.has(root)) {
      needed.set(root, tag.type === 'JSXMemberExpression' ? { kind: 'namespace', source: compFile } : { ...b, source: compFile });
    }
    return undefined;
  });

  for (const [localName, b] of needed) {
    const existing = targetBindings.get(localName);
    if (existing) {
      const existingRel = resolveLocalModule(existing.source, targetRel, context);
      if (existingRel === b.source) continue;
      throw new EditorError('IMPORT_CONFLICT', `粘贴内容需要本地名 ${localName}（来自 ${b.source}），与目标页现有绑定冲突`, 409);
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
    targetProgram.body.splice(lastImportIndex(targetProgram) + 1, 0, {
      type: 'ImportDeclaration',
      specifiers: [spec],
      source: { type: 'Literal', value: moduleSpec, raw: JSON.stringify(moduleSpec) },
    });
  }
}

function lastImportIndex(program: AnyNode): number {
  let idx = -1;
  for (let i = 0; i < (program.body?.length ?? 0); i++) {
    if (program.body[i]?.type === 'ImportDeclaration') idx = i;
  }
  return idx;
}

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
  parseTsx(prev, rel);
  writeProjectFile(context, rel, prev);
  return { updatedSource: prev, history: history.stats(rel) };
}
