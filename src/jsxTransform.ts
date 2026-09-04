import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import t from '@babel/types';
import fs from 'fs';
import path from 'path';
import { encodeNodeId } from './nodeId';

// @babel/* 为 CJS 模块，不同打包器对默认导入的互操作不一致（有的注入 __esModule，
// 有的不注入），这里统一做一次安全取值：优先取 .default，否则取模块自身。
type TraverseFn = typeof traverseModule;
type GenerateFn = typeof generateModule;
const traverse: TraverseFn = (() => {
  const m = traverseModule as unknown as { default?: TraverseFn };
  return m.default ?? traverseModule;
})();
const generate: GenerateFn = (() => {
  const m = generateModule as unknown as { default?: GenerateFn };
  return m.default ?? generateModule;
})();

/** Vite resolve.alias 的一项（兼容字符串/正则两种 find） */
export interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

export interface TransformOptions {
  /** 项目根目录（绝对路径），用于解析组件文件与计算相对路径 */
  rootDir: string;
  /** 宿主项目 resolve.alias 配置（用于解析 @/ 等本地别名） */
  aliases?: AliasEntry[];
}

/** 缓存「默认导出组件文件 -> 组件名」，避免对同一文件反复解析 */
const defaultExportNameCache = new Map<string, string | null>();

/**
 * 编译期 JSX 转换 —— 只处理 pages/ 下的页面文件。
 *
 * 1) data-node-id（每个 JSX 元素）
 *    data-node-id = "node-" + base64url({file, startLine, startCol, endLine, endCol})
 *    记录元素写在页面文件的哪一行、开标签/结束标签的跨度（见 nodeId.ts）。
 *
 * 2) data-node-name / data-node-file（页面里用到的自定义组件）
 *    对页面中 <Button>、<AlertDialogContent>、<Card> 这类「组件元素」注入：
 *      - data-node-name：组件真实的导出名（Button、Card…）
 *      - data-node-file：组件定义文件相对项目根目录的路径
 *        （如 src/components/ui/button.tsx）——是组件自己的文件，不是使用它的页面文件。
 *    实现方式：静态解析该组件的 import 绑定（含 @/ 等别名）定位到定义文件；
 *    属性作为 props 传入组件，组件把多余 props（data-*）转发到自身根 DOM 时即会出现在
 *    真实节点上（Base UI 等原始组件已实测会透传）。
 *
 *    宿主元素（<div>/<button>）与解析不到本地文件的组件不注入 name/file；
 *    来自 node_modules 外部包的组件（如 lucide 图标）也不注入（不属于项目源码）。
 *
 * 转换在编译时完成、零运行时开销；失败时原样返回代码，不阻断构建。
 */
export function transformJSXWithAttributes(
  code: string,
  filePath: string,
  options?: TransformOptions
): { code: string; map?: any } {
  try {
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    // 本文件内的 import 绑定表：本地名 -> { kind, imported?, source }
    const importBindings = collectImportBindings(ast);

    // 每次转换内部对「模块标识符 -> 项目内相对路径」做缓存
    const resolvedCache = new Map<string, string | null>();
    const resolveSource = (spec: string) => {
      if (resolvedCache.has(spec)) return resolvedCache.get(spec)!;
      const rel = resolveLocalModule(spec, filePath, options);
      resolvedCache.set(spec, rel);
      return rel;
    };

    traverse(ast, {
      JSXElement(path) {
        const openingElement = path.node.openingElement;
        if (!openingElement.loc?.start) return;
        const start = openingElement.loc.start;

        // ---------- data-node-id：所有元素 ----------
        const hasNodeId = hasAttr(openingElement, 'data-node-id');
        if (!hasNodeId) {
          const end =
            path.node.closingElement?.loc?.start ?? openingElement.loc.end;
          if (end) {
            const id = encodeNodeId(filePath, start, end);
            openingElement.attributes.push(
              t.jsxAttribute(t.jsxIdentifier('data-node-id'), t.stringLiteral(id))
            );
          }
        }

        // ---------- data-node-name / data-node-file：自定义组件 ----------
        if (hasAttr(openingElement, 'data-node-name')) return;

        const usage = analyzeComponentUsage(openingElement, importBindings);
        if (!usage) return;

        const componentFile = resolveSource(usage.source);
        if (!componentFile) return; // 外部包/解析不到本地文件 → 不标注

        let name = usage.name;
        if (usage.kind === 'default') {
          // 默认导出：尝试从定义文件解析组件名
          const defName = getDefaultExportName(componentFile, options);
          if (defName) name = defName;
        }

        openingElement.attributes.push(
          t.jsxAttribute(t.jsxIdentifier('data-node-name'), t.stringLiteral(name)),
          t.jsxAttribute(
            t.jsxIdentifier('data-node-file'),
            t.stringLiteral(componentFile)
          )
        );
      },
    });

    const output = generate(
      ast,
      {
        retainLines: true,
        comments: true,
      },
      code
    );

    return { code: output.code };
  } catch (error) {
    // 如果解析/转换失败，返回原代码，避免阻断构建
    console.error('[@kesi/vite-plugin] Error transforming JSX:', error);
    return { code };
  }
}

// ==================== 内部工具 ====================

function hasAttr(openingElement: t.JSXOpeningElement, attrName: string): boolean {
  return openingElement.attributes.some(
    (attr) =>
      t.isJSXAttribute(attr) &&
      t.isJSXIdentifier(attr.name) &&
      attr.name.name === attrName
  );
}

interface ImportBinding {
  kind: 'named' | 'default' | 'namespace';
  imported?: string; // named: 原导出名；namespace: 无
  source: string;
}

/** 收集 import 绑定表（含命名别名、默认、命名空间） */
function collectImportBindings(ast: t.File): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      for (const spec of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          bindings.set(spec.local.name, { kind: 'default', source });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          bindings.set(spec.local.name, { kind: 'namespace', source });
        } else if (t.isImportSpecifier(spec)) {
          const imported =
            t.isIdentifier(spec.imported) ? spec.imported.name
            : t.isStringLiteral(spec.imported) ? spec.imported.value
            : spec.local.name;
          bindings.set(spec.local.name, {
            kind: 'named',
            imported,
            source,
          });
        }
      }
    },
  });

  return bindings;
}

interface ComponentUsage {
  kind: 'named' | 'default' | 'namespace';
  /** 注入 data-node-name 用的名字（namespace 场景为该标签的末段） */
  name: string;
  source: string;
}

/**
 * 判断 JSX 标签是否是对「自定义组件」的使用，并返回用于定位的信息。
 * 宿主元素 / 未通过 import 引入的本地标签返回 null。
 */
function analyzeComponentUsage(
  openingElement: t.JSXOpeningElement,
  bindings: Map<string, ImportBinding>
): ComponentUsage | null {
  const tag = openingElement.name;

  if (t.isJSXIdentifier(tag)) {
    if (/^[a-z]/.test(tag.name)) return null; // 宿主元素
    const binding = bindings.get(tag.name);
    if (!binding) return null; // 本文件内定义/全局 → 不标注
    return {
      kind: binding.kind,
      name:
        binding.kind === 'named' && binding.imported
          ? binding.imported
          : tag.name,
      source: binding.source,
    };
  }

  if (t.isJSXMemberExpression(tag)) {
    // <ui.Button> / <Primitive.Root>
    const objectName = memberRootName(tag);
    if (!objectName) return null;
    const binding = bindings.get(objectName);
    if (!binding || binding.kind !== 'namespace') return null;
    return {
      kind: 'namespace',
      name: memberPropertyName(tag) ?? 'Component',
      source: binding.source,
    };
  }

  return null;
}

function memberRootName(node: any): string | null {
  let obj: any = node;
  while (t.isJSXMemberExpression(obj)) obj = obj.object;
  return t.isJSXIdentifier(obj) ? obj.name : null;
}

/** 取 <a.b.C> 这类标签的末段属性名（C） */
function memberPropertyName(node: any): string | null {
  return t.isJSXIdentifier(node.property) ? node.property.name : null;
}

/**
 * 把 import 模块标识符解析为「项目根目录内的相对路径（posix）」。
 * 只解析本地模块（相对路径 / 绝对路径 / 别名如 @/）；解析不到或属于
 * node_modules 外部包时返回 null。
 */
function resolveLocalModule(
  spec: string,
  importerRelPath: string,
  options?: TransformOptions
): string | null {
  if (!options?.rootDir) return null;
  const rootDir = options.rootDir;
  const importerAbs = path.resolve(rootDir, importerRelPath);

  let resolved: string;

  if (spec.startsWith('.') || spec.startsWith('/')) {
    resolved = spec;
  } else {
    // 裸包名（含 @scope/pkg）：先尝试命中别名，否则视为外部包
    const aliased = applyAlias(spec, options.aliases);
    if (aliased == null) return null;
    resolved = aliased;
  }

  const abs = path.resolve(path.dirname(importerAbs), resolved);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) return null;

  const fileAbs = resolveFileOnDisk(abs);
  if (!fileAbs) return null;

  return path.relative(rootDir, fileAbs).split(path.sep).join('/');
}

function applyAlias(spec: string, aliases?: AliasEntry[]): string | null {
  if (!aliases || aliases.length === 0) return null;

  // 字符串 find 按长度降序匹配，优先最长前缀（如 @/ 优先于 @）
  const sorted = [...aliases].sort((a, b) => {
    const la = typeof a.find === 'string' ? a.find.length : 0;
    const lb = typeof b.find === 'string' ? b.find.length : 0;
    return lb - la;
  });

  for (const { find, replacement } of sorted) {
    if (typeof find === 'string') {
      if (spec === find) return replacement;
      if (spec.startsWith(find + '/')) return replacement + spec.slice(find.length);
    } else if (find.test(spec)) {
      return spec.replace(find, replacement);
    }
  }
  return null;
}

function resolveFileOnDisk(abs: string): string | null {
  const candidates = [
    abs,
    `${abs}.tsx`,
    `${abs}.ts`,
    `${abs}.jsx`,
    `${abs}.js`,
    path.join(abs, 'index.tsx'),
    path.join(abs, 'index.ts'),
    path.join(abs, 'index.jsx'),
    path.join(abs, 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return path.resolve(c);
    }
  }
  return null;
}

/**
 * 读取一个「默认导出组件」文件的组件名（带缓存）。
 * 支持 export default function X / export default X（X 为本文件内大写声明）。
 */
function getDefaultExportName(
  relPath: string,
  options?: TransformOptions
): string | null {
  const rootDir = options?.rootDir;
  if (!rootDir) return null;
  const abs = path.resolve(rootDir, relPath);

  if (defaultExportNameCache.has(abs)) return defaultExportNameCache.get(abs)!;

  let name: string | null = null;
  try {
    const fileCode = fs.readFileSync(abs, 'utf8');
    const ast = parse(fileCode, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    const caps = new Map<string, string>(); // 声明名
    let defaultExprName: string | null = null;

    traverse(ast, {
      FunctionDeclaration(p) {
        if (p.node.id && /^[A-Z]/.test(p.node.id.name)) {
          caps.set(p.node.id.name, p.node.id.name);
        }
      },
      VariableDeclarator(p) {
        const id = p.node.id;
        if (t.isIdentifier(id) && /^[A-Z]/.test(id.name)) {
          caps.set(id.name, id.name);
        }
      },
      ExportDefaultDeclaration(p) {
        const decl = p.node.declaration;
        if (t.isFunctionDeclaration(decl)) {
          name = decl.id?.name || null;
        } else if (t.isIdentifier(decl)) {
          defaultExprName = decl.name;
          name = /^[A-Z]/.test(decl.name) ? decl.name : caps.get(decl.name) || null;
        }
      },
      ExportNamedDeclaration(p) {
        for (const s of p.node.specifiers) {
          if (
            t.isExportSpecifier(s) &&
            t.isIdentifier(s.exported) &&
            s.exported.name === 'default'
          ) {
            if (t.isIdentifier(s.local)) {
              name = /^[A-Z]/.test(s.local.name)
                ? s.local.name
                : caps.get(s.local.name) || null;
            }
          }
        }
      },
    });

    if (!name && defaultExprName && /^[A-Z]/.test(defaultExprName)) {
      name = defaultExprName;
    }
  } catch {
    name = null;
  }

  defaultExportNameCache.set(abs, name);
  return name;
}
