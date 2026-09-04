/**
 * data-node-id 编解码工具
 *
 * 约定格式（编译期由 JSX AST 转换注入到每个元素的开标签上）：
 *
 *   data-node-id = "node-" + base64url( JSON.stringify(NodeSourceSpan) )
 *
 * NodeSourceSpan 载荷字段：
 *   - file      相对项目根目录的源码路径（POSIX 分隔符，无前导 "/"）
 *   - startLine 起始标签 "<tag" 的开始行号（1 起）
 *   - startCol  起始标签 "<tag" 的开始列号（0 起，Babel AST 约定）
 *   - endLine   结束标签 "</tag>" 的开始行号；自闭合元素为该标签结束位置的行
 *   - endCol    结束标签 "</tag>" 的开始列号；自闭合元素为该标签结束位置的列
 *
 * 设计目的：解码后即可在源码中精确框定该组件/元素从起始标签到结束标签的
 * 位置，供 AI / 编辑器工具定位源码、修改代码与属性。
 */

export const NODE_ID_PREFIX = 'node-';

/** 源码中的一个点（行 1 起、列 0 起，与 Babel AST loc 一致） */
export interface NodeSourcePoint {
  line: number;
  column: number;
}

/** 元素在源码中的标签跨度 */
export interface NodeSourceSpan {
  /** 相对项目根目录的源码路径（POSIX，无前导 /） */
  file: string;
  /** 起始标签 "<tag" 的开始行号（1 起） */
  startLine: number;
  /** 起始标签 "<tag" 的开始列号（0 起） */
  startCol: number;
  /** 结束标签 "</tag>" 的开始行号；自闭合元素为该标签结束位置的行 */
  endLine: number;
  /** 结束标签 "</tag>" 的开始列号；自闭合元素为该标签结束位置的列 */
  endCol: number;
}

function toBase64Url(text: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf8').toString('base64url');
  }
  // 浏览器环境兜底（保留给未来在 iframe/Canvas 中解码使用）
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  return decodeURIComponent(escape(atob(padded)));
}

/**
 * 生成 data-node-id
 * @param file  相对项目根目录的源码路径（POSIX，无前导 /）
 * @param start 起始标签 "<tag" 的位置
 * @param end   结束标签 "</tag>" 的开始位置（自闭合元素传该标签的结束位置）
 */
export function encodeNodeId(
  file: string,
  start: NodeSourcePoint,
  end: NodeSourcePoint
): string {
  const span: NodeSourceSpan = {
    file,
    startLine: start.line,
    startCol: start.column,
    endLine: end.line,
    endCol: end.column,
  };
  return NODE_ID_PREFIX + toBase64Url(JSON.stringify(span));
}

/** 判断一个值是否符合 data-node-id 前缀 */
export function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(NODE_ID_PREFIX);
}

/**
 * 解码 data-node-id
 * @returns 解析成功的 NodeSourceSpan；格式非法或载荷不完整时返回 null
 */
export function decodeNodeId(id: string | null | undefined): NodeSourceSpan | null {
  if (!isNodeId(id)) return null;

  try {
    const raw = fromBase64Url(id.slice(NODE_ID_PREFIX.length));
    const parsed = JSON.parse(raw);

    if (
      typeof parsed?.file !== 'string' ||
      !Number.isFinite(parsed?.startLine) ||
      !Number.isFinite(parsed?.startCol) ||
      !Number.isFinite(parsed?.endLine) ||
      !Number.isFinite(parsed?.endCol)
    ) {
      return null;
    }

    return {
      file: parsed.file,
      startLine: parsed.startLine,
      startCol: parsed.startCol,
      endLine: parsed.endLine,
      endCol: parsed.endCol,
    };
  } catch {
    return null;
  }
}

/** decodeNodeId 的别名，便于语义化调用 */
export const nodeIdToSpan = decodeNodeId;
