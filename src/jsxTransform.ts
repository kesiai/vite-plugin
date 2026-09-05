import { parseTsx, generateSource, AnyNode, jsxIdentifier } from './editor/common';
import { offsetToPoint, elementEndOffset } from './editor/common';
import { encodeNodeId } from './nodeId';

/**
 * 编译期 JSX 转换（yuku 实现）——只对 pages/ 下的文件生效。
 *
 * 目前只注入一个属性：
 *   data-node-id = "node-" + base64url({file, startLine, startCol, endLine, endCol})
 *
 * 组件名 / 组件文件 / 属性 / children 等元信息**不再注入到 DOM**：
 * 拿到 data-node-id 后调用 `GET /__editor/node/{nodeId}` 即可获取全部信息
 * （componentName / componentFile / props / children / AST / source）。
 */
export function transformJSXWithAttributes(code: string, filePath: string): { code: string } {
  try {
    const program = parseTsx(code, filePath);

    const walkAll = (n: AnyNode, fn: (node: AnyNode) => void) => {
      if (!n || typeof n !== 'object') return;
      fn(n);
      for (const k of Object.keys(n)) {
        if (k === 'parent') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => walkAll(c, fn));
        else if (v && typeof v === 'object') walkAll(v, fn);
      }
    };

    walkAll(program, (el) => {
      if (el?.type !== 'JSXElement' || !el.openingElement || !el.openingElement.start) return;
      const open = el.openingElement;

      const hasId = (open.attributes ?? []).some(
        (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === 'data-node-id'
      );
      if (hasId) return;

      const startP = offsetToPoint(code, open.start);
      const endP = offsetToPoint(code, elementEndOffset(el));
      const id = encodeNodeId(
        filePath,
        { line: startP.line, column: startP.column },
        { line: endP.line, column: endP.column }
      );
      open.attributes.push({
        type: 'JSXAttribute',
        name: jsxIdentifier('data-node-id'),
        value: { type: 'Literal', value: id, raw: JSON.stringify(id) },
      });
    });

    const out = generateSource(program);
    return { code: out };
  } catch (error: any) {
    console.error(
      `[@kesi/vite-plugin] Error transforming JSX${filePath ? ` (${filePath})` : ''}:`,
      error?.message ?? error
    );
    return { code };
  }
}
