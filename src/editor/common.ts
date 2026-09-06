import { parse as yParse } from '@yuku-parser/wasm';
import { generate as yGenerate } from '@yuku-codegen/wasm';

/**
 * 编辑器模块共用工具：yuku 解析/生成封装、位置换算、AST 遍历与 JSX 操作。
 * 全部基于 ESTree / TS-ESTree 兼容 AST（yuku-parser wasm 产出）。
 */

/** 业务错误：带错误码、HTTP 状态与可读信息，供 /__editor API 完整透出 */
export class EditorError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export type AnyNode = any;

/** 解析文件内容为 ESTree program；带诊断时抛 PARSE_ERROR */
export function parseTsx(code: string, relPath?: string): AnyNode {
  const lang = !relPath
    ? 'tsx'
    : relPath.endsWith('.jsx')
      ? 'jsx'
      : relPath.endsWith('.tsx')
        ? 'tsx'
        : relPath.endsWith('.ts') || relPath.endsWith('.mts') || relPath.endsWith('.cts')
          ? 'ts'
          : 'js';

  const { program, diagnostics } = yParse(code, {
    lang,
    sourceType: 'module',
    preserveParens: true,
    attachComments: true,
  });

  if (diagnostics.length > 0) {
    const detail = diagnostics.map((d: any) => ({
      message: d.message,
      start: d.start,
      end: d.end,
    }));
    throw new EditorError(
      'PARSE_ERROR',
      `JS/TS 解析失败${relPath ? `：${relPath}` : ''}：${detail[0]?.message ?? '未知语法错误'}`,
      422,
      detail
    );
  }
  return program;
}

/** 由 AST 重新生成源码（pretty、保留注释与引号风格） */
export function generateSource(program: AnyNode): string {
  try {
    return yGenerate(program, {
      format: 'pretty',
      indent: 2,
      quotes: 'preserve',
      comments: 'all',
    });
  } catch (error: any) {
    throw new EditorError('CODEGEN_ERROR', `代码生成失败：${error?.message ?? error}`, 422);
  }
}

/** 用脚本模式解析一段 JS 表达式文本（用于把用户输入的表达式变成 AST） */
export function parseExpressionText(text: string): AnyNode {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new EditorError('INVALID_VALUE', '属性表达式不能为空', 400);
  }
  const { program, diagnostics } = yParse(text, {
    lang: 'js',
    sourceType: 'module',
    preserveParens: false,
  });
  if (diagnostics.length > 0) {
    throw new EditorError(
      'INVALID_EXPRESSION',
      `属性表达式解析失败：${diagnostics[0].message}`,
      422,
      diagnostics.map((d: any) => ({ message: d.message, start: d.start, end: d.end }))
    );
  }
  const stmt = program.body?.[0];
  if (!stmt || stmt.type !== 'ExpressionStatement' || !stmt.expression) {
    throw new EditorError('INVALID_EXPRESSION', `「${text}」不是合法的表达式`, 422);
  }
  return stmt.expression;
}

/** 深拷贝（AST 为纯 JSON，无循环） */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 位置对象（与 data-node-id 载荷一致：行 1 起、列 0 起） */
export interface Point {
  line: number;
  column: number;
}

export function offsetToPoint(text: string, offset: number): Point {
  let line = 1;
  let lastLf = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastLf = i;
    }
  }
  return { line, column: offset - (lastLf + 1) };
}

export function pointToOffset(text: string, point: Point): number {
  const lines = text.split('\n');
  if (point.line < 1 || point.line > lines.length) return -1;
  let offset = 0;
  for (let i = 0; i < point.line - 1; i++) offset += lines[i].length + 1;
  return offset + point.column;
}

/** 取 JSX 元素结束位置对应的 offset（与 data-node-id 编码一致） */
export function elementEndOffset(el: AnyNode): number {
  if (el.type === 'JSXElement') {
    if (el.closingElement) return el.closingElement.start;
    return el.end; // 自闭合元素
  }
  if (el.type === 'JSXFragment') return el.closingFragment?.start ?? el.end;
  return el.end;
}

/** 去除括号包裹（preserveParens=true 时括号会保留为 ParenthesizedExpression） */
export function unwrapExpr(node: AnyNode): AnyNode {
  let n = node;
  while (n && n.type === 'ParenthesizedExpression') n = n.expression;
  return n;
}

/** 深度遍历 AST，enter 返回 false 则剪枝 */
export function walk(node: AnyNode, enter: (n: AnyNode, parent: AnyNode | null, key: string | null, index: number | null) => boolean | void) {
  if (!node || typeof node !== 'object') return;
  const recurse = (n: AnyNode, parent: AnyNode | null, key: string | null, index: number | null) => {
    const r = enter(n, parent, key, index);
    if (r === false) return;
    if (typeof n !== 'object' || n === null) return;
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) {
        v.forEach((child, i) => recurse(child, n, k, i));
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        recurse(v, n, k, null);
      }
    }
  };
  recurse(node, null, null, null);
}

export interface NodePathInfo {
  node: AnyNode;
  parent: AnyNode | null;
  parentKey: string | null;
  index: number | null;
}

/** 查找第一个满足 predicate 的节点及其容器路径 */
export function findNode(node: AnyNode, predicate: (n: AnyNode) => boolean): NodePathInfo | null {
  let hit: NodePathInfo | null = null;
  walk(node, (n, parent, key, index) => {
    if (hit) return false;
    if (n && predicate(n)) {
      hit = { node: n, parent, parentKey: key, index };
      return false;
    }
    return undefined;
  });
  return hit;
}

/** 收集所有满足 predicate 的节点 */
export function findNodes(node: AnyNode, predicate: (n: AnyNode) => boolean): NodePathInfo[] {
  const hits: NodePathInfo[] = [];
  walk(node, (n, parent, key, index) => {
    if (n && predicate(n)) hits.push({ node: n, parent, parentKey: key, index });
    return undefined;
  });
  return hits;
}

/** 从容器中删除一个子节点（父为数组字段时按 index 移除） */
export function removeFromContainer(path: NodePathInfo): void {
  if (!path.parent) {
    throw new EditorError('REMOVE_ROOT', '不能删除页面根节点', 400);
  }
  if (path.index !== null && path.parentKey && Array.isArray(path.parent[path.parentKey])) {
    path.parent[path.parentKey].splice(path.index, 1);
    return;
  }
  if (path.parentKey && path.parent[path.parentKey] === path.node) {
    path.parent[path.parentKey] = null;
    return;
  }
  throw new EditorError('REMOVE_FAILED', '无法定位待删除节点的父容器', 500);
}

/** 属性工具 ------------------------------------------------------------ */

export function getAttr(el: AnyNode, name: string): AnyNode | undefined {
  return el?.openingElement?.attributes?.find(
    (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === name
  );
}

export function hasAttr(el: AnyNode, name: string): boolean {
  return !!getAttr(el, name);
}

export function removeAttr(el: AnyNode, name: string): boolean {
  const attrs = el?.openingElement?.attributes;
  if (!Array.isArray(attrs)) return false;
  const idx = attrs.findIndex(
    (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === name
  );
  if (idx === -1) return false;
  attrs.splice(idx, 1);
  return true;
}

export function jsxIdentifier(name: string): AnyNode {
  return { type: 'JSXIdentifier', name };
}

export function literalAttrValue(value: unknown): AnyNode {
  // 字符串走双引号字面量；其它原样
  if (typeof value === 'string') {
    return { type: 'Literal', value, raw: JSON.stringify(value) };
  }
  return {
    type: 'Literal',
    value,
    raw:
      typeof value === 'number' ? String(value)
      : value === null ? 'null'
      : typeof value === 'boolean' ? String(value)
      : String(value),
  };
}

export function exprAttrValue(expression: AnyNode): AnyNode {
  return { type: 'JSXExpressionContainer', expression };
}

/**
 * 由任意「新值」构造 JSX 属性 value 节点。
 *
 * 推荐的显式写法：item = { name, type, value }
 *   - type: 'expr' —— 表达式属性；value 二选一：
 *       · 表达式字符串（如 "() => save()"、"count + 1"）：先用 parseExpressionText 解析成
 *         AST，再包进 JSXExpressionContainer 作为属性表达式写回；
 *       · AST JSON（ESTree 表达式节点对象）：直接克隆包进 JSXExpressionContainer。
 *   - type 省略时按旧约定推断：item.value 原始值、item.expr 表达式文本、item.ast AST JSON。
 * 未提供任何值或 item.remove=true → 返回 null（表示删除该属性）。
 */
export function buildAttrValue(item: AnyNode): AnyNode | null {
  const explicitExpr = item?.type === 'expression' || item?.type === 'expr';
  if (
    item &&
    (item.remove === true ||
      (item.value === undefined && item.expr === undefined && item.expression === undefined && item.ast === undefined))
  ) {
    return null;
  }
  let expr: AnyNode;

  if (explicitExpr) {
    // 表达式类型：value 既可以是 AST JSON，也可以是「表达式字符串」
    const v = item.value;
    if (v && typeof v === 'object' && typeof v.type === 'string') {
      expr = v as AnyNode; // AST JSON
    } else if (typeof v === 'string' && v.trim() !== '') {
      expr = parseExpressionText(v); // 表达式字符串 -> AST
    } else if (item.ast !== undefined) {
      expr = item.ast;
    } else if (item.expr !== undefined) {
      expr = parseExpressionText(String(item.expr));
    } else if (item.expression !== undefined) {
      expr = parseExpressionText(String(item.expression));
    } else {
      throw new EditorError('INVALID_EXPRESSION', '表达式属性（type:expression）的 value 必须是 AST JSON 或非空表达式字符串', 400);
    }
    // 显式表达式：一律包成 {<expr>} 写回（不做字符串字面量特判）
    return exprAttrValue(expr);
  }

  if (item.ast !== undefined) {
    expr = item.ast;
  } else if (item.expr !== undefined) {
    expr = parseExpressionText(String(item.expr));
  } else if (item.expression !== undefined) {
    expr = parseExpressionText(String(item.expression));
  } else {
    const v = item.value;
    // JSON 兼容值：字符串/数字/布尔/null 直接 Literal；对象/数组转 JSON 对象表达式
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      v === null
    ) {
      const lit = literalAttrValue(v);
      return typeof v === 'string' ? lit : exprAttrValue(lit);
    }
    // 简单对象/数组：用 JSON.parse 字符串再 codegen? 直接构造 ObjectExpression 太繁琐，
    // 转成 AST JSON（与 ESTree 兼容的表达式），优先走 expr 文本解析保证正确性
    try {
      expr = parseExpressionText(JSON.stringify(v));
    } catch {
      expr = parseExpressionText(String(v));
    }
  }

  // 表达式文本解析出来是字符串/数字字面量时直接作为属性字面量（class="x" 风格）
  if (expr.type === 'Literal' && typeof expr.value === 'string') {
    return { type: 'Literal', value: expr.value, raw: JSON.stringify(expr.value) };
  }
  return exprAttrValue(expr);
}

export function setAttrValue(el: AnyNode, name: string, valueNode: AnyNode | null): 'set' | 'add' | 'remove' | 'none' {
  const existing = getAttr(el, name);
  if (valueNode === null) {
    return removeAttr(el, name) ? 'remove' : 'none';
  }
  if (existing) {
    existing.value = valueNode;
    return 'set';
  }
  el.openingElement.attributes.push({
    type: 'JSXAttribute',
    name: jsxIdentifier(name),
    value: valueNode,
  });
  return 'add';
}

/** 属性 -> 便于展示/编辑的值描述（值类型字段统一为 type；表达式类型为 expression） */
export function describeAttrValue(attr: AnyNode): AnyNode {
  const name = attr.name?.name ?? '(spread)';
  if (attr.type === 'JSXSpreadAttribute') {
    return { name, type: 'spread' };
  }
  const value = attr.value;
  if (!value) return { name, type: 'boolean', value: true };
  if (value.type === 'Literal') {
    return { name, type: 'literal', value: value.value };
  }
  if (value.type === 'JSXExpressionContainer') {
    const e = unwrapExpr(value.expression);
    if (e && e.type === 'Literal') {
      return { name, type: 'literal', value: e.value };
    }
    return { name, type: 'expression' };
  }
  return { name, type: 'expression' };
}

/** import 工具 --------------------------------------------------------- */

export interface BindingInfo {
  kind: 'named' | 'default' | 'namespace';
  imported?: string;
  source: string;
}

export function collectBindings(program: AnyNode): Map<string, BindingInfo> {
  const map = new Map<string, BindingInfo>();
  for (const stmt of program.body ?? []) {
    if (stmt?.type !== 'ImportDeclaration') continue;
    const source = stmt.source?.value;
    for (const spec of stmt.specifiers ?? []) {
      const local = spec.local?.name;
      if (!local) continue;
      if (spec.type === 'ImportDefaultSpecifier') map.set(local, { kind: 'default', source });
      else if (spec.type === 'ImportNamespaceSpecifier') map.set(local, { kind: 'namespace', source });
      else if (spec.type === 'ImportSpecifier') {
        map.set(local, {
          kind: 'named',
          imported: spec.imported?.name ?? local,
          source,
        });
      }
    }
  }
  return map;
}

/** 收集文件导出：named 集合、default 名字 */
export function analyzeExports(program: AnyNode): { named: Set<string>; defaultName: string | null } {
  const named = new Set<string>();
  let defaultName: string | null = null;

  for (const stmt of program.body ?? []) {
    if (!stmt) continue;
    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d?.type === 'FunctionDeclaration') defaultName = d.id?.name ?? null;
      else if (d?.type === 'Identifier') defaultName = d.name;
      else if (d?.type === 'ArrowFunctionExpression' || d?.type === 'FunctionExpression') defaultName = null;
    } else if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration;
      if (decl?.type === 'FunctionDeclaration' && decl.id?.name) named.add(decl.id.name);
      if (decl?.type === 'VariableDeclaration') {
        for (const v of decl.declarations ?? []) {
          const id = v.id;
          const grab = (node: AnyNode) => {
            if (node?.type === 'Identifier') named.add(node.name);
            else if (node?.type === 'ObjectPattern') (node.properties ?? []).forEach((p: AnyNode) => grab(p.type === 'RestElement' ? p.argument : p.value ?? p));
            else if (node?.type === 'ArrayPattern') (node.elements ?? []).forEach((e: AnyNode) => e && grab(e));
          };
          grab(id);
        }
      }
      for (const spec of stmt.specifiers ?? []) {
        if (spec.type === 'ExportSpecifier' && spec.exported?.type === 'Identifier') {
          if (spec.exported.name === 'default') {
            defaultName = spec.local?.name ?? defaultName;
          } else {
            named.add(spec.exported.name);
          }
        }
      }
    }
  }
  return { named, defaultName };
}
