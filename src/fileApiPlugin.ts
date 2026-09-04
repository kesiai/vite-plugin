import * as fs from 'fs';
import * as path from 'path';
import { ComponentScanner } from './componentScanner';

/**
 * 页面文件管理 API（/__editor/file）。
 *
 * 统一语义：所有页面文件的读写/创建/删除都以「pages 目录」为根，
 * pageName 为相对该目录的路径（可含子目录，如 "dashboard/Dashboard"，
 * 可带或不带 .tsx/.jsx 后缀）。
 */

const DEFAULT_PAGES_DIR = 'pages';

let ROOT_DIR: string = process.cwd();
let PAGES_DIR: string = path.resolve(ROOT_DIR, DEFAULT_PAGES_DIR);

// 保存 scanner 实例的引用，文件变更后触发重扫
let scannerInstance: ComponentScanner | null = null;

/**
 * 设置 pages 目录和根目录
 * @param pagesDir pages 目录（绝对路径，或相对 rootDir 的相对路径）
 * @param rootDir  项目根目录
 */
export function setPagesDir(pagesDir: string, rootDir?: string): void {
  ROOT_DIR = rootDir || process.cwd();
  PAGES_DIR = path.isAbsolute(pagesDir)
    ? path.normalize(pagesDir)
    : path.resolve(ROOT_DIR, pagesDir);
}

/**
 * 设置 scanner 实例（文件写入/创建/删除后用于刷新组件缓存）
 */
export function setScanner(scanner: ComponentScanner | null): void {
  scannerInstance = scanner;
}

function afterFileChanged(): void {
  if (scannerInstance) {
    scannerInstance.rescan();
  }
}

/**
 * 把调用方传入的 pageName 解析为 pages 目录内的绝对路径。
 * 规则：必须是相对路径、不得使用 ".." 越过 pages 目录、不允许绝对路径。
 */
function resolvePagePath(pageName: string): string {
  if (typeof pageName !== 'string' || pageName.trim() === '') {
    throw new Error(`Invalid pageName: ${pageName}`);
  }

  // 统一分隔符并去掉开头的 "./" 与 "/"，再拒绝绝对路径和目录穿越
  const rel = pageName.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
  if (
    !rel ||
    rel.split('/').includes('..') ||
    path.isAbsolute(pageName) ||
    pageName.includes('\0')
  ) {
    throw new Error(`Invalid pageName (path traversal is not allowed): ${pageName}`);
  }

  const target = path.resolve(PAGES_DIR, rel);
  const pagesRoot = path.normalize(PAGES_DIR);
  if (target !== pagesRoot && !target.startsWith(pagesRoot + path.sep)) {
    throw new Error(`Invalid pageName (outside pages dir): ${pageName}`);
  }
  return target;
}

/** 补全文件后缀：pageName 已带 .tsx/.jsx 则原样返回，否则优先匹配已存在的文件 */
function resolveFileWithExtension(basePath: string): string {
  if (/\.(tsx|jsx)$/.test(basePath)) return basePath;

  for (const ext of ['.tsx', '.jsx']) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return `${basePath}.tsx`;
}

/** 递归收集 pages 目录下的所有页面文件 */
function getPagesList(): Array<{ name: string; path: string }> {
  const result: Array<{ name: string; path: string }> = [];

  const walk = (dir: string, relDir: string) => {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        walk(fullPath, rel);
      } else if (/\.(tsx|jsx)$/.test(entry.name)) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        result.push({
          name: rel.replace(/\.(tsx|jsx)$/, ''),
          path: fullPath,
        });
      }
    }
  };

  if (fs.existsSync(PAGES_DIR)) {
    walk(PAGES_DIR, '');
  }
  return result;
}

/** 读取页面内容 */
function getPageContent(pageName: string): string {
  const filePath = resolveFileWithExtension(resolvePagePath(pageName));
  if (!fs.existsSync(filePath)) {
    throw new Error(`Page ${pageName} not found`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/** 保存页面内容（覆盖写） */
function savePageContent(pageName: string, content: string): void {
  const filePath = resolveFileWithExtension(resolvePagePath(pageName));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** 创建新页面（默认 .tsx 模板） */
function createPage(pageName: string, template?: string): void {
  const basePath = resolvePagePath(pageName);
  const filePath = /\.(tsx|jsx)$/.test(basePath) ? basePath : `${basePath}.tsx`;
  if (fs.existsSync(filePath)) {
    throw new Error(`Page ${pageName} already exists`);
  }

  const baseName = path.basename(pageName, path.extname(pageName));
  const defaultTemplate =
    template ||
    `import React from 'react';

export default function Page() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">${baseName}</h1>
      <p>Start editing to see magic happen!</p>
    </div>
  );
}
`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, defaultTemplate, 'utf-8');
}

/** 删除页面 */
function deletePage(pageName: string): void {
  const filePath = resolveFileWithExtension(resolvePagePath(pageName));
  if (!fs.existsSync(filePath)) {
    throw new Error(`Page ${pageName} not found`);
  }
  fs.unlinkSync(filePath);
}

/**
 * /__editor/file API
 * GET /__editor/file                      -> 页面文件列表
 * POST /__editor/file {action:'read'}     -> 读取页面
 * POST /__editor/file {action:'save'}     -> 保存页面
 * POST /__editor/file {action:'create'}   -> 创建页面
 * DELETE /__editor/file {pageName}        -> 删除页面
 */
export function fileApiPlugin(req: any, res: any): void {
  const send = (data: any, statusCode = 200) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };

  try {
    if (req.method === 'GET') {
      const pages = getPagesList();
      send({ success: true, data: pages });
      return;
    }

    if (req.method === 'POST') {
      const data = req.body || {};

      switch (data.action) {
        case 'read': {
          const content = getPageContent(data.pageName);
          send({ success: true, data: content });
          return;
        }
        case 'save': {
          savePageContent(data.pageName, data.content);
          afterFileChanged();
          send({ success: true });
          return;
        }
        case 'create': {
          createPage(data.pageName, data.template);
          afterFileChanged();
          send({ success: true });
          return;
        }
        default:
          send({ success: false, error: 'Invalid action' }, 400);
          return;
      }
    }

    if (req.method === 'DELETE') {
      const data = req.body || {};
      deletePage(data.pageName);
      afterFileChanged();
      send({ success: true });
      return;
    }

    send({ success: false, error: 'Method not allowed' }, 405);
  } catch (error: any) {
    send({ success: false, error: error.message }, 500);
  }
}
