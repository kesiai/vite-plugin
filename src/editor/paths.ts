import fs from 'fs';
import path from 'path';
import { EditorError } from './common';

/** Vite resolve.alias 的一项 */
export interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

export interface ResolveContext {
  rootDir: string;
  aliases?: AliasEntry[];
}

/** 项目根目录内相对（posix）路径 -> 磁盘绝对路径，超出根目录报错 */
export function absFromRoot(context: ResolveContext, relPosix: string): string {
  const abs = path.resolve(context.rootDir, relPosix);
  if (abs !== context.rootDir && !abs.startsWith(context.rootDir + path.sep)) {
    throw new EditorError(
      'PATH_OUTSIDE_ROOT',
      `路径超出项目根目录：${relPosix}`,
      400
    );
  }
  return abs;
}

function fileExistsCandidates(abs: string): string | null {
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
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function applyAlias(spec: string, aliases?: AliasEntry[]): string | null {
  if (!aliases || aliases.length === 0) return null;
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

/**
 * 把 import 模块标识符解析为项目根内相对（posix）文件路径。
 * 只解析本地模块（./ ../ / @/ ~ 等别名）；外部包/解析失败返回 null。
 */
export function resolveLocalModule(
  spec: string,
  importerRelPosix: string,
  context: ResolveContext
): string | null {
  let resolved: string;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    resolved = spec;
  } else {
    const aliased = applyAlias(spec, context.aliases);
    if (aliased == null) return null;
    resolved = aliased;
  }
  const rootDir = context.rootDir;
  const importerAbs = path.resolve(rootDir, importerRelPosix);
  const abs = path.resolve(path.dirname(importerAbs), resolved);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) return null;
  const file = fileExistsCandidates(abs);
  if (!file) return null;
  return path.relative(rootDir, file).split(path.sep).join('/');
}

/** 读取项目内文件文本 */
export function readProjectFile(context: ResolveContext, relPosix: string): string {
  const abs = absFromRoot(context, relPosix);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (error: any) {
    throw new EditorError(
      'FILE_READ_ERROR',
      `读取文件失败：${relPosix}（${error?.message ?? error}）`,
      500
    );
  }
}

/** 写入项目内文件文本 */
export function writeProjectFile(context: ResolveContext, relPosix: string, content: string): void {
  const abs = absFromRoot(context, relPosix);
  try {
    fs.writeFileSync(abs, content, 'utf8');
  } catch (error: any) {
    throw new EditorError(
      'FILE_WRITE_ERROR',
      `写入文件失败：${relPosix}（${error?.message ?? error}）`,
      500
    );
  }
}

/** 计算「页面文件」到「组件文件」的 import 模块路径（无扩展名、相对路径） */
export function pageImportSpecifier(
  pageRelPosix: string,
  componentRelPosix: string
): string {
  const pageDir = path.posix.dirname(pageRelPosix);
  let rel = path.posix.relative(pageDir, componentRelPosix).replace(/\.(tsx|jsx|ts|js)$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/**
 * 把用户给出的页面名（'dashboard/Dashboard' / 'pages/dashboard/Dashboard.tsx'）解析成
 * 项目根内相对路径，并确认文件存在；带防目录穿越。
 */
export function resolvePageRel(
  context: ResolveContext,
  pagesDir: string,
  pageNameOrRel: string
): string {
  if (typeof pageNameOrRel !== 'string' || !pageNameOrRel.trim()) {
    throw new EditorError('INVALID_PAGE', '缺少 page（页面名）', 400);
  }
  let rel = pageNameOrRel.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
  if (!rel.startsWith(pagesDir + '/')) {
    rel = pagesDir + '/' + rel;
  }
  if (rel.includes('..')) {
    throw new EditorError('INVALID_PAGE', `非法的页面路径：${pageNameOrRel}`, 400);
  }
  const abs = absFromRoot(context, rel);
  const found = fileExistsCandidates(abs);
  if (!found) {
    throw new EditorError('PAGE_NOT_FOUND', `页面文件不存在：${rel}`, 404, { page: pageNameOrRel });
  }
  return path.relative(context.rootDir, found).split(path.sep).join('/');
}
