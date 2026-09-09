import { Plugin } from 'vite';
import { ComponentScanner } from './componentScanner';
import { createExpressServer } from './server';
import { transformJSXWithAttributes } from './jsxTransform';
import type { AliasEntry } from './editor/paths';
import { setPagesDir } from './fileApiPlugin';
import { resolve, relative, sep } from 'path';
import type { PluginOptions } from './types';

/**
 * Vite 开发插件：
 * 1. 编译期为 pages/ 下的 JSX 注入 data-node-id（组件信息经 /__editor/node/{id} 获取）
 *    （见 nodeId.ts / jsxTransform.ts）
 * 2. 挂载 /__editor/* HTTP API（组件扫描、文件读写、安装、构建等）
 *
 * 仅在开发模式（vite serve）下生效，不影响生产构建。
 */
export function kesiPlugin(options: PluginOptions = {}): Plugin {
  const {
    enableNodeIds = true,
    rootDir,
    pagesDir = 'pages',
    componentsDir = 'components',
  } = options;

  let scanner: ComponentScanner | undefined;
  let isDevelopment = true;
  let viteRoot = '';
  let viteAliases: AliasEntry[] = [];

  // 归一化 Vite resolve.alias（对象形式 / 数组形式）
  const normalizeAliases = (alias: any): AliasEntry[] => {
    if (!alias) return [];
    if (Array.isArray(alias)) {
      return alias
        .filter((a: any) => a && typeof a.find === 'string' && typeof a.replacement === 'string')
        .map((a: any) => ({ find: a.find, replacement: a.replacement }));
    }
    return Object.entries(alias)
      .filter(([, v]) => typeof v === 'string')
      .map(([find, replacement]) => ({ find, replacement: replacement as string }));
  };

  return {
    name: 'kesi-vite-plugin',
    enforce: 'pre', // 先于 React 等插件执行

    config(_config, { command }) {
      isDevelopment = command === 'serve';
      return {
        server: {
          cors: true,
        },
      };
    },

    configureServer(server) {
      viteRoot = server.config.root;
      viteAliases = normalizeAliases((server.config.resolve as any)?.alias);

      // 计算根目录：优先使用用户提供的 rootDir，否则用 Vite root
      const resolvedRootDir = rootDir ? resolve(rootDir) : viteRoot;
      setPagesDir(resolve(resolvedRootDir, pagesDir), resolvedRootDir);

      scanner = new ComponentScanner(resolvedRootDir, pagesDir, componentsDir);
      const scanResult = scanner.scanAll();
      console.log(
        `[kesi-vite-plugin] Scanned ${scanResult.components.length} components (${scanResult.pageComponents.length} in ${pagesDir}/), root: ${resolvedRootDir}`
      );

      // HTTP API 中间件（/__editor/*，含页面编辑接口）
      const middleware = createExpressServer(scanner, server, {
        rootDir: viteRoot,
        pagesDir,
        aliases: viteAliases,
      });
      server.middlewares.use(middleware);
    },

    transform(code, id) {
      if (!isDevelopment || !enableNodeIds) return null;
      if (!/\.(jsx|tsx)$/.test(id)) return null;
      if (id.includes('node_modules')) return null;
      if (!viteRoot) return null;

      // 只处理 pages 目录下的文件（data-node-* 标记仅作用于页面层，
      // 其他目录的 tsx 不做转换）
      const relativeId = relative(viteRoot, id).split(sep).join('/');
      if (!relativeId.startsWith(`${pagesDir}/`)) return null;

      return addNodeAttributes(code, relativeId);
    },

    handleHotUpdate({ file }) {
      // 文件变化时重新扫描组件列表，保证 API 数据与磁盘一致
      if (isDevelopment && /\.(jsx|tsx)$/.test(file) && scanner) {
        scanner.scanAll();
      }
    },

    transformIndexHtml(html, ctx) {
      if (!isDevelopment) return html;

      // 编辑器画布/预览模式：把入口脚本替换为 Canvas.tsx（由宿主项目提供）
      const url = ctx?.originalUrl || '';
      const isEditorMode =
        url.includes('__editor_canvas') || url.includes('__editor_preview');
      if (!isEditorMode) return html;

      return html.replace(
        /<script\s+type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/g,
        () => '<script type="module" src="/Canvas.tsx">'
      );
    },
  };
}

/**
 * 为 pages 下 JSX 注入 data-node-id（yuku AST 转换），出错时返回原代码
 */
function addNodeAttributes(code: string, relativePath: string): { code: string } {
  try {
    return transformJSXWithAttributes(code, relativePath);
  } catch (error) {
    console.error('[kesi-vite-plugin] Error adding node attributes:', error);
    return { code };
  }
}

export default kesiPlugin;
