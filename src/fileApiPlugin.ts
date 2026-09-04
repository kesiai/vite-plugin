import * as fs from "fs";
import * as path from "path";
import { ComponentScanner } from "./componentScanner";

// 存储 pages 目录路径和根目录
let PAGES_DIR = path.resolve(process.cwd(), 'pages');
let ROOT_DIR = process.cwd();

// 存储 scanner 实例的引用
let scannerInstance: ComponentScanner | null = null;

/**
 * 设置 pages 目录和根目录
 */
export function setPagesDir(pagesDir: string, rootDir?: string): void {
  ROOT_DIR = rootDir || process.cwd();
  PAGES_DIR = path.resolve(ROOT_DIR, pagesDir);
}

/**
 * 设置 scanner 实例
 */
export function setScanner(scanner: ComponentScanner): void {
  scannerInstance = scanner;
}

/**
 * 确保目录存在
 */
function ensurePagesDir() {
  if (!fs.existsSync(PAGES_DIR)) {
    fs.mkdirSync(PAGES_DIR, { recursive: true });
  }
}

/**
 * 获取所有页面文件列表
 */
function getPagesList(): Array<{ name: string; path: string }> {
  ensurePagesDir();

  const files = fs.readdirSync(PAGES_DIR);
  const tsxFiles = files.filter(
    (file) => file.endsWith(".tsx") || file.endsWith(".jsx"),
  );

  return tsxFiles.map((file) => ({
    name: file.replace(/\.(tsx|jsx)$/, ""),
    path: path.join(PAGES_DIR, file),
  }));
}

/**
 * 读取页面内容
 */
function getPageContent(pageName: string): string {
  ensurePagesDir();

  const possibleExtensions = [".tsx", ".jsx"];
  for (const ext of possibleExtensions) {
    const filePath = path.join(ROOT_DIR, `${pageName}${ext}`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  }

  throw new Error(`Page ${pageName} not found`);
}

/**
 * 保存页面内容
 */
function savePageContent(pageName: string, content: string): void {
  ensurePagesDir();

  // 确保文件名以 .tsx 结尾
  const fileName = pageName.endsWith(".tsx") ? pageName : `${pageName}.tsx`;
  const filePath = path.join(ROOT_DIR, fileName);

  // 写入文件
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * 创建新页面
 */
function createPage(pageName: string, template?: string): void {
  ensurePagesDir();

  const fileName = pageName.endsWith(".tsx") ? pageName : `${pageName}.tsx`;
  const filePath = path.join(PAGES_DIR, fileName);

  if (fs.existsSync(filePath)) {
    throw new Error(`Page ${pageName} already exists`);
  }

  const defaultTemplate =
    template ||
    `import React from 'react';

export default function Page() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">${pageName}</h1>
      <p>Start editing to see magic happen!</p>
    </div>
  );
}
`;

  fs.writeFileSync(filePath, defaultTemplate, "utf-8");
}

/**
 * 删除页面
 */
function deletePage(pageName: string): void {
  ensurePagesDir();

  const possibleExtensions = [".tsx", ".jsx"];
  for (const ext of possibleExtensions) {
    const filePath = path.join(ROOT_DIR, `${pageName}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return;
    }
  }

  throw new Error(`Page ${pageName} not found`);
}

/**
 * Vite 插件：提供文件管理 API
 */
export function fileApiPlugin(req: any, res: any): void {
  if (req.method === "GET") {
    // 获取页面列表
    try {
      const pages = getPagesList();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, data: pages }));
    } catch (error: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  } else if (req.method === "POST") {
    try {
      const data = req.body;

      if (data.action === "read") {
        // 读取页面内容
        const content = getPageContent(data.pageName);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: content }));
      } else if (data.action === "save") {
        // 保存页面内容
        savePageContent(data.pageName, data.content);
        // 清除 scanner 缓存，使文件变化能被检测到
        if (scannerInstance) {
          scannerInstance.rescan();
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } else if (data.action === "create") {
        // 创建新页面
        createPage(data.pageName, data.template);
        // 清除 scanner 缓存，使新文件能被扫描到
        if (scannerInstance) {
          scannerInstance.rescan();
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: "Invalid action" }));
      }
    } catch (error: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  } else if (req.method === "DELETE") {
    // 删除页面
    try {
      const data = req.body;
      deletePage(data.pageName);
      // 清除 scanner 缓存，使文件删除能被检测到
      if (scannerInstance) {
        scannerInstance.rescan();
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true }));
    } catch (error: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  } else {
    res.statusCode = 405;
    res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
  }
}
