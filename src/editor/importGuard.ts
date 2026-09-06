import fs from 'fs';
import path from 'path';
import { EditorError, AnyNode, collectBindings, walk, parseTsx, analyzeExports } from './common';
import { ResolveContext, resolveLocalModule, pageImportSpecifier } from './paths';

/** @kesi/client 可自动导入导出面（移植自 ensure-kesi-imports：组件 + 全部 hooks + getSettings） */
const CLIENT_IMPORTABLE = [
  'Page', 'Subscribe',
  'useUser', 'useLogin', 'useLogout', 'useUserReg', 'useUserAttr',
  'useEvents', 'useEvent', 'useEventsWithSpread',
  'useDictValue', 'useDictSet', 'useDictGet',
  'useLanguageDictionaryValue', 'useLanguageDictionarySet', 'useLanguageDictionaryGet',
  'useMessage',
  'useCellDataValue', 'useDatasetSet', 'useDatasetsValue', 'useDatasourceValue',
  'usePageVar', 'usePageVarValue', 'useSetPageVar', 'usePageVarCallback',
  'useSystemVar',
  'useFunctions', 'useFunctionsValue', 'useFunctionsSet', 'useFunctionsGet',
  'useIteration', 'useIterationValue',
  'useScale', 'useViewValue', 'usePlayback', 'usePageStore',
  'useTag', 'useTagValue', 'useTableData', 'useTableDataValue',
  'useUpdateTags', 'useUpdateMeta', 'useUpdateData', 'useUpdateTagsTimeout',
  'useReferenceValue', 'useUpdateReference', 'useSubscribeContext',
  'useTimeSubscribe', 'useServerTime',
  'useDataTagSubscribe', 'useTableDataSubscribe', 'useTagWarningSubscribe',
  'useTagsTimeoutSubscribe', 'useComputeSubscribe',
  'useCommWS', 'useWS', 'useWSData',
  'useModel', 'useModelValue', 'useModelState', 'useSetModelState', 'useModelCallback',
  'useModelGet', 'useModelSave', 'useModelDelete', 'useModelGetItems', 'useModelItem',
  'useModelQuery', 'useModelPermission', 'useModelEvent', 'useModelEffect',
  'useModelPagination', 'useModelCount', 'useModelPageSize', 'useModelFields',
  'useModelList', 'useModelSelect', 'useModelListRow', 'useModelListHeader',
  'useModelListOrder', 'useModelListItem',
  'getSettings',
] as const;
const CLIENT_MODULE = '@kesi/client';
const CLIENT_SET = new Set<string>(CLIENT_IMPORTABLE);


/**
 * import 自动补齐与前置校验（对齐 ensure-kesi-imports 的思路，泛化到任意项目组件）。
 *
 * 触发：props 添加/修改、children 添加/修改、组件新增/粘贴等任何写盘前调用：
 *   1. 扫描「本次修改影响范围」内实际出现的自定义标识符（大写开头标识符 / JSX 组件标签，
 *      天然排除字符串/注释/类型（跳过 TS* 节点），只统计 AST 中真实引用）；
 *   2. 页面文件已 import / 已声明的名字跳过；
 *   3. 缺失的名字尝试从项目组件目录解析（按命名惯例探测 + 按导出扫描，带缓存）：
 *      - 能解析 → 自动合并/新增 import（幂等，支持 named/default）；
 *      - 无法解析或与已有绑定冲突 → 抛出 MISSING_IMPORT / IMPORT_CONFLICT，
 *        调用方不得执行写盘。
 */

interface ResolvedSource {
  rel: string; // 组件文件（相对项目根）
  kind: 'named' | 'default';
  defaultName?: string;
}

/** 组件导出名 -> 文件 索引缓存（按 root 缓存） */
const INDEX_CACHE = new Map<string, Map<string, ResolvedSource>>();

const PROBE_DIRS = ['src/components', 'components'];
/** shadcn 风格的文件后缀（TabsContent -> tabs.tsx 的 Content 等） */
const FILE_SUFFIXES = [
  'Content', 'Header', 'Title', 'Description', 'Footer', 'Action', 'Cancel',
  'Trigger', 'Overlay', 'Portal', 'Close', 'Item', 'List', 'Icon', 'Root', 'Viewport', 'Media',
];

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function probeCandidates(name: string, rootDir: string): string[] {
  const k = kebab(name);
  const bases = PROBE_DIRS.map((d) => path.resolve(rootDir, d));
  const files = new Set<string>();
  for (const base of bases) {
    files.add(path.join(base, 'ui', `${k}.tsx`));
    files.add(path.join(base, `${k}.tsx`));
    files.add(path.join(base, `${k}.tsx`));
    for (const suffix of FILE_SUFFIXES) {
      if (name.endsWith(suffix)) {
        const core = name.slice(0, -suffix.length);
        if (core) files.add(path.join(base, 'ui', `${kebab(core)}.tsx`));
      }
    }
  }
  return [...files];
}

function exportsMatch(rel: string, rootDir: string, name: string): ResolvedSource | null {
  try {
    const text = fs.readFileSync(path.resolve(rootDir, rel), 'utf8');
    const ex = analyzeExports(parseTsx(text, rel));
    if (ex.named.has(name)) return { rel, kind: 'named' };
    if (ex.defaultName === name) return { rel, kind: 'default', defaultName: name };
  } catch {
    /* 跳过不可解析文件 */
  }
  return null;
}

/** 索引项目组件目录（src/components、components 递归） */
function buildIndex(rootDir: string): Map<string, ResolvedSource> {
  const cached = INDEX_CACHE.get(rootDir);
  if (cached) return cached;
  const index = new Map<string, ResolvedSource>();

  const walkDir = (dir: string, relDir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walkDir(full, relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (/\.(tsx|jsx)$/.test(entry.name)) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        try {
          const text = fs.readFileSync(full, 'utf8');
          const ex = analyzeExports(parseTsx(text, rel));
          for (const n of ex.named) if (!index.has(n)) index.set(n, { rel, kind: 'named' });
          if (ex.defaultName && !index.has(ex.defaultName)) {
            index.set(ex.defaultName, { rel, kind: 'default', defaultName: ex.defaultName });
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  for (const d of PROBE_DIRS) {
    walkDir(path.resolve(rootDir, d), d);
  }
  INDEX_CACHE.set(rootDir, index);
  return index;
}

function resolveComponentForName(name: string, ctx: ResolveContext): ResolvedSource | null {
  const rootDir = ctx.rootDir;
  // 1) 命名惯例快速探测（避免先全量扫描）
  for (const cand of probeCandidates(name, rootDir)) {
    if (!fs.existsSync(cand)) continue;
    const rel = path.relative(rootDir, cand).split(path.sep).join('/');
    const hit = exportsMatch(rel, rootDir, name);
    if (hit) return hit;
  }
  // 2) 全量索引（带缓存）
  const hit = buildIndex(rootDir).get(name);
  return hit ?? null;
}

/**
 * 页面代码里所有“已定义/已导入”的标识符集合（整个文件近似收集，避免把局部变量当缺失）
 */
function collectDefinedIdentifiers(program: AnyNode): Set<string> {
  const defined = new Set<string>();
  const addId = (id: AnyNode | null | undefined) => {
    if (id && typeof id?.name === 'string') defined.add(id.name);
  };
  const bindings = collectBindings(program);
  for (const local of bindings.keys()) defined.add(local);

  walk(program, (n) => {
    if (!n || typeof n.type !== 'string') return undefined;
    if (n.type.startsWith('TS')) return false; // 类型区不产生运行时引用
    if (n.type === 'VariableDeclarator' && n.id) addId(n.id);
    if (n.type === 'FunctionDeclaration' && n.id) addId(n.id);
    if (n.type === 'FunctionExpression' && n.id) addId(n.id);
    if (n.type === 'ClassDeclaration' && n.id) addId(n.id);
    if (n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
      for (const p of n.params ?? []) {
        // 简单解构收集参数名（覆盖常见用例）
        const collectParam = (pNode: AnyNode) => {
          if (!pNode) return;
          if (pNode.type === 'Identifier') addId(pNode);
          else if (pNode.type === 'AssignmentPattern') collectParam(pNode.left);
          else if (pNode.type === 'ObjectPattern') (pNode.properties ?? []).forEach((pp: AnyNode) => collectParam(pp.type === 'RestElement' ? pp.argument : pp.value ?? pp));
          else if (pNode.type === 'ArrayPattern') (pNode.elements ?? []).forEach((e: AnyNode) => e && collectParam(e));
        };
        collectParam(p);
      }
    }
    return undefined;
  });
  return defined;
}

/** 安全地合并/新增 import；冲突抛 IMPORT_CONFLICT */
function ensureImport(program: AnyNode, fileRel: string, localName: string, source: ResolvedSource, ctx: ResolveContext): void {
  const bindings = collectBindings(program);
  const existing = bindings.get(localName);
  if (existing) {
    const existingRel = resolveLocalModule(existing.source, fileRel, ctx);
    if (existingRel === source.rel) return; // 同源无需重复
    throw new EditorError(
      'IMPORT_CONFLICT',
      `标识符 ${localName} 已绑定自 ${existing.source}，与自动导入目标 ${source.rel} 冲突，已取消本次修改`,
      409,
      { name: localName, existing: existing.source, target: source.rel }
    );
  }

  const moduleSpec = pageImportSpecifier(fileRel, source.rel);
  const specifier: AnyNode =
    source.kind === 'default'
      ? { type: 'ImportDefaultSpecifier', local: { type: 'Identifier', name: localName } }
      : { type: 'ImportSpecifier', imported: { type: 'Identifier', name: localName }, local: { type: 'Identifier', name: localName } };
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

/**
 * 校验并补齐本次修改范围里缺失的 import。
 * 未解析的名字/绑定冲突会抛错（调用方必须在写盘前调用，抛错即不写盘）。
 * @returns 本次自动补充的 import 名列表
 */
export function ensureSubtreeImports(
  program: AnyNode,
  subtreeRoots: AnyNode[],
  fileRel: string,
  ctx: ResolveContext
): string[] {
  if (!subtreeRoots || subtreeRoots.length === 0) return [];

  // 1) 收集本次修改范围里实际出现的所有标识符（AST 级，排除字符串/注释/TS 类型/成员属性名/对象键）
  const used = new Set<string>();
  const scan = (n: AnyNode) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.type === 'string' && n.type.startsWith('TS')) return;
    const t = n.type;
    if (t === 'MemberExpression') {
      scan(n.object);
      if (n.computed) scan(n.property);
      return;
    }
    if (t === 'Property' || t === 'ObjectProperty') {
      if (n.computed) scan(n.key);
      scan(n.value);
      return;
    }
    if (t === 'ObjectMethod' || t === 'PropertyDefinition' || t === 'MethodDefinition') {
      scan(n.value);
      return;
    }
    if (t === 'JSXElement') {
      const tag = n.openingElement?.name;
      if (tag?.type === 'JSXIdentifier') used.add(tag.name);
      else if (tag?.type === 'JSXMemberExpression') {
        let obj: AnyNode = tag;
        while (obj.type === 'JSXMemberExpression') obj = obj.object;
        if (obj.type === 'JSXIdentifier') used.add(obj.name);
      }
    } else if (t === 'Identifier') {
      used.add(n.name);
    }
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') scan(v);
    }
  };
  for (const root of subtreeRoots) scan(root);

  let defined = collectDefinedIdentifiers(program);
  const added: string[] = [];

  // 2) @kesi/client 成员：自动合并/新增 import（本文件已声明同名则不重复导入）
  const clientMissing = [...used].filter((n) => CLIENT_SET.has(n) && !defined.has(n));
  if (clientMissing.length > 0) {
    mergeClientImports(program, clientMissing);
    added.push(...clientMissing);
    defined = collectDefinedIdentifiers(program); // 重新收集，避免后续把 client 成员当缺失组件
  }

  // 3) 大写自定义组件/常量：尝试自动补 import；补不了则抛错（不写盘）
  const unresolvedCaps = [...used].filter(
    (n) => /^[A-Z]/.test(n) && !CLIENT_SET.has(n) && !defined.has(n)
  );
  if (unresolvedCaps.length === 0) return added;

  const cannot: string[] = [];
  for (const name of unresolvedCaps) {
    const src = resolveComponentForName(name, ctx);
    if (!src) {
      cannot.push(name);
      continue;
    }
    ensureImport(program, fileRel, name, src, ctx);
    added.push(name);
  }
  if (cannot.length > 0) {
    throw new EditorError(
      'MISSING_IMPORT',
      `代码中引用了 ${cannot.join('、')}，但无法自动补全 import（未在组件目录中找到对应导出，也非 @kesi/client 成员或本页已声明标识符）。请先导入或添加对应组件后重试；本次修改未执行。`,
      409,
      { missing: cannot }
    );
  }
  return added;
}

/**
 * 把缺失的 @kesi/client 成员合并进已有 `import { ... } from '@kesi/client'`；
 * 无该 import 时在 import 区末尾新增一条。幂等（跳过已导入名）。
 */
function mergeClientImports(program: AnyNode, names: string[]): void {
  let decl: AnyNode | null = null;
  for (const stmt of program.body ?? []) {
    if (
      stmt?.type === 'ImportDeclaration' &&
      stmt.source?.value === CLIENT_MODULE &&
      stmt.importKind !== 'type'
    ) {
      decl = stmt;
      break;
    }
  }

  if (decl) {
    const existing = new Set(
      (decl.specifiers ?? [])
        .map((sp: AnyNode) => sp.local?.name)
        .filter((x: string | undefined): x is string => !!x)
    );
    for (const name of names) {
      if (!existing.has(name)) {
        decl.specifiers.push({
          type: 'ImportSpecifier',
          imported: { type: 'Identifier', name },
          local: { type: 'Identifier', name },
        });
        existing.add(name);
      }
    }
    return;
  }

  const insertAt = lastImportIndex(program) + 1;
  program.body.splice(insertAt, 0, {
    type: 'ImportDeclaration',
    importKind: 'value',
    specifiers: names.map((name) => ({
      type: 'ImportSpecifier',
      imported: { type: 'Identifier', name },
      local: { type: 'Identifier', name },
    })),
    source: { type: 'Literal', value: CLIENT_MODULE, raw: `'${CLIENT_MODULE}'` },
  });
}

function lastImportIndex(program: AnyNode): number {
  let idx = -1;
  for (let i = 0; i < (program.body?.length ?? 0); i++) {
    if (program.body[i]?.type === 'ImportDeclaration') idx = i;
  }
  return idx;
}
