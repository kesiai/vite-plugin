/**
 * 应用「文件 → 路由」解析（服务端版本）
 *
 * 编辑器客户端原在 src/services/appRoutes.ts 里用 readFile 拉 App.tsx 并正则解析；
 * 为收敛到单一后端（/__editor），解析迁到插件侧：GET /__editor/routers 直接读
 * 项目内 router 文件并返回解析结果。逻辑与客户端原实现逐段一致：
 *  import 声明 / lazy()  → 组件名 → 文件
 *  <Route path element>  → 组件名 → 路由 path
 *  合成 文件（归一化 pages/x，无扩展名）→ 路由 path（后出现覆盖，贴近叶子路由语义）
 */
import * as fs from 'fs';
import * as path from 'path';

/** 路由配置文件（按优先级；读取失败自动跳过） */
export const ROUTER_FILES = ['src/App.tsx', 'src/App.jsx', 'src/main.tsx'];

/** import 路径归一：'@/pages/x' / './pages/x' → 'pages/x'（无扩展名，统一小写比较用原样） */
function normalizeImportPath(p: string): string {
  return p
    .replace(/^@\//, '')
    .replace(/^\.\//, '')
    .replace(/^\.\.\//, '');
}

/** 解析 router 文件内容 → { 归一化文件路径: 路由 path } */
export function parseFileRoutes(content: string): Record<string, string> {
  // 1. import 声明 → 组件名 → 文件路径
  const compToFile: Record<string, string> = {};
  const importRe =
    /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*?)\}|([A-Za-z0-9_$]+))\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(importRe)) {
    const source = normalizeImportPath(m[4]);
    if (!source.startsWith('pages/') && !source.startsWith('components/')) continue;
    if (m[2]) {
      // { A, B as C } → A→file, C→file
      for (const part of m[2].split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const asMatch = seg.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        compToFile[asMatch ? asMatch[2] : seg] = source;
      }
    }
    if (m[1]) compToFile[m[1]] = source; // default, named 混用
    if (m[3]) compToFile[m[3]] = source; // 纯 default
  }
  // const X = lazy(() => import('@/pages/x'))
  const lazyRe = /([A-Za-z0-9_$]+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(lazyRe)) {
    const source = normalizeImportPath(m[2]);
    if (source.startsWith('pages/') || source.startsWith('components/')) {
      compToFile[m[1]] = source;
    }
  }

  // 2. Route 声明 → 组件名 → 路由 path（嵌套 Routes 的子 path 就是完整 path，父级为 /*）
  const compToRoute: Record<string, string> = {};
  const routeRe = /path=["']([^"']*)["'][^>]*?element=\{<\s*([A-Za-z0-9_$]+)/g;
  for (const m of content.matchAll(routeRe)) {
    compToRoute[m[2]] = m[1] || '/';
  }

  // 3. 合成 文件 → 路由（后出现的 Route 覆盖前面的，贴近「叶子路由生效」语义）
  const fileToRoute: Record<string, string> = {};
  for (const [comp, routePath] of Object.entries(compToRoute)) {
    const file = compToFile[comp];
    if (file) fileToRoute[file] = routePath;
  }
  return fileToRoute;
}

/** 读首个存在的路由文件并解析（与编辑器旧 ensureFileRouteMap 的优先级/断路一致） */
export function readAppRouteMap(rootDir: string): Record<string, string> {
  for (const file of ROUTER_FILES) {
    const abs = path.resolve(rootDir, file);
    try {
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      return parseFileRoutes(content);
    } catch {
      // 读取失败：试下一个
    }
  }
  return {};
}
