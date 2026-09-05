import fs from 'fs';
import path from 'path';
import { parseTsx, generateSource, EditorError, AnyNode, cloneJson, collectBindings, analyzeExports, jsxIdentifier } from './editor/common';
import { ResolveContext, resolveLocalModule } from './editor/paths';
import { offsetToPoint, elementEndOffset } from './editor/common';
import { encodeNodeId } from './nodeId';

/**
 * 编译期 JSX 转换（基于 yuku-parser / yuku-codegen，替代旧 Babel 实现）。
 * 只被插件用于 pages/ 下的文件：
 *
 * 1) data-node-id（每个 JSX 元素）
 *    data-node-id = "node-" + base64url({file, startLine, startCol, endLine, endCol})
 * 2) data-node-name / data-node-file（页面里用到的自定义组件）
 *    import 绑定静态解析（含 @/ 别名），name=导出名，file=组件定义文件。
 */
export interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

export interface TransformOptions {
  rootDir: string;
  aliases?: AliasEntry[];
}

const defaultNameCache = new Map<string, string | null>();

function componentExports(fileRel: string, context: TransformOptions): { named: Set<string>; defaultName: string | null } {
  const abs = path.resolve(context.rootDir, fileRel);
  if (defaultNameCache.has(fileRel)) {
    // cache 只存 defaultName；named 集合小，每次解析也行（文件少）
  }
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const program = parseTsx(text, fileRel);
    return analyzeExports(program);
  } catch {
    return { named: new Set(), defaultName: null };
  }
}

function usageInfo(
  program: AnyNode,
  el: AnyNode,
  context: TransformOptions,
  fileRel: string
): { name: string; file: string } | null {
  const tag = el?.openingElement?.name;
  if (!tag) return null;

  const bindings = collectBindings(program);

  if (tag.type === 'JSXIdentifier') {
    if (/^[a-z]/.test(tag.name)) return null; // 宿主元素
    const binding = bindings.get(tag.name);
    if (!binding) return null;
    const compFile = resolveLocalModule(binding.source, fileRel, context);
    if (!compFile) return null;
    if (binding.kind === 'named') {
      return { name: binding.imported ?? tag.name, file: compFile };
    }
    if (binding.kind === 'namespace') return null;
    // default import：组件名取定义文件默认导出的名字（解析失败则退回本地名）
    const { defaultName } = componentExports(compFile, context);
    return { name: defaultName ?? tag.name, file: compFile };
  }

  if (tag.type === 'JSXMemberExpression') {
    let obj: AnyNode = tag;
    while (obj.type === 'JSXMemberExpression') obj = obj.object;
    if (obj.type === 'JSXIdentifier') {
      const binding = bindings.get(obj.name);
      if (binding?.kind === 'namespace') {
        const compFile = resolveLocalModule(binding.source, fileRel, context);
        if (compFile && tag.property?.name) {
          return { name: tag.property.name, file: compFile };
        }
      }
    }
  }
  return null;
}

function hasAttr(el: AnyNode, name: string): boolean {
  return (el?.openingElement?.attributes ?? []).some(
    (a: AnyNode) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === name
  );
}

function stringAttr(el: AnyNode, name: string, value: string): void {
  el.openingElement.attributes.push({
    type: 'JSXAttribute',
    name: jsxIdentifier(name),
    value: { type: 'Literal', value, raw: JSON.stringify(value) },
  });
}

export function transformJSXWithAttributes(
  code: string,
  filePath: string,
  options?: TransformOptions
): { code: string } {
  try {
    if (!options?.rootDir) {
      throw new EditorError('ROOT_DIR_REQUIRED', '缺少 rootDir（transform 上下文）', 500);
    }
    const program = parseTsx(code, filePath);
    const context: ResolveContext = options;

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

      if (!hasAttr(el, 'data-node-id')) {
        const startP = offsetToPoint(code, open.start);
        const endP = offsetToPoint(code, elementEndOffset(el));
        const id = encodeNodeId(
          filePath,
          { line: startP.line, column: startP.column },
          { line: endP.line, column: endP.column }
        );
        stringAttr(el, 'data-node-id', id);
      }

      if (hasAttr(el, 'data-node-name')) return;
      const usage = usageInfo(program, el, context, filePath);
      if (!usage) return;
      stringAttr(el, 'data-node-name', usage.name);
      stringAttr(el, 'data-node-file', usage.file);
    });

    const out = generateSource(program);
    return { code: out };
  } catch (error: any) {
    // 转换失败原样返回源码，绝不阻断构建
    console.error(
      `[@kesi/vite-plugin] Error transforming JSX${filePath ? ` (${filePath})` : ''}:`,
      error?.message ?? error
    );
    return { code };
  }
}
