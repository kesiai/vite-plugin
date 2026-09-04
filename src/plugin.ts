import { Plugin } from 'vite';
import { ComponentScanner } from './componentScanner';
import { createExpressServer } from './server';
import { transformJSXWithAttributes } from './jsxTransform';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import express from 'express';
import { setPagesDir } from './fileApiPlugin';
import { spawn } from 'child_process';

export interface PluginOptions {
  enableDataCode?: boolean;
  enableComponentRoutes?: boolean;
  rootDir?: string;
  pagesDir?: string;
  componentsDir?: string;
}

export function airiotPlugin(options: PluginOptions = {}): Plugin {
  console.log('[vite-plugin-airiot] Plugin loading...');

  const {
    enableDataCode = true,
    enableComponentRoutes = true,
    rootDir,
    pagesDir = 'pages',
    componentsDir = 'components',
  } = options;

  let scanner: ComponentScanner;
  let isDevelopment = true;
  let viteRoot: string;

  return {
    name: 'vite-plugin-airiot',
    enforce: 'pre', // 在其他插件之前执行（特别是 React 插件）

    config: (_config, { command }) => {
      // 使用command来检测开发模式
      isDevelopment = command === 'serve';
      console.log('[vite-plugin-airiot] Config hook - command:', command, 'isDevelopment:', isDevelopment);

      return {
        server: {
          // 确保CORS配置正确
          cors: true,
        },
      };
    },

    configureServer(server) {
      console.log('[vite-plugin-airiot] configureServer called, command:', server.config.command);

      // 保存 Vite 根目录供后续使用
      viteRoot = server.config.root;

      // 计算根目录：如果用户提供了 rootDir，则使用它，否则使用 Vite 的 root
      const resolvedRootDir = rootDir ? resolve(rootDir) : server.config.root;
      console.log('[vite-plugin-airiot] Root directory:', resolvedRootDir);
      console.log('[vite-plugin-airiot] Pages directory:', pagesDir);
      console.log('[vite-plugin-airiot] Components directory:', componentsDir);

      // 设置 fileApiPlugin 的 pages 目录
      const pagesDirPath = resolve(resolvedRootDir, pagesDir);
      setPagesDir(pagesDirPath, resolvedRootDir);
      console.log('[vite-plugin-airiot] File API pages directory:', pagesDirPath);

      scanner = new ComponentScanner(resolvedRootDir, pagesDir, componentsDir);

      const scanResult = scanner.scanAll();
      console.log(`[vite-plugin-airiot] Found ${scanResult.components.length} components`);
      console.log(`[vite-plugin-airiot] Found ${scanResult.pageComponents.length} page components`);

      const expressApp = createExpressServer(scanner, server, {
        enableDataCode,
        enableComponentRoutes,
        pagesDir,
        componentsDir,
      });

      server.middlewares.use(expressApp);
      console.log('[vite-plugin-airiot] HTTP API server initialized');

      // 启动 opencode-ai
      console.log('[vite-plugin-airiot] Starting opencode-ai in:', resolvedRootDir);
      const opencode = spawn('opencode', ['serve', '--hostname', '0.0.0.0'], {
        cwd: resolvedRootDir,
        stdio: 'inherit',
        shell: true,
      });

      opencode.on('error', (err) => {
        console.warn('[vite-plugin-airiot] Failed to start opencode:', err.message);
      });

      opencode.on('exit', (code) => {
        console.log('[vite-plugin-airiot] opencode exited with code:', code);
      });

      // 添加 /__air_editor 路径代理，访问 editor 项目的 dist 目录
      const editorDistPath = resolve(__dirname, '../../editor/dist');
      console.log('[vite-plugin-airiot] Setting up /__air_editor proxy to:', editorDistPath);

      // 检查 dist 目录是否存在
      if (existsSync(editorDistPath)) {
        server.middlewares.use('/__air_editor', express.static(editorDistPath) as any);
        console.log('[vite-plugin-airiot] Express static middleware initialized for /__air_editor');
      } else {
        console.warn('[vite-plugin-airiot] Editor dist directory not found:', editorDistPath);
      }
    },

    transform(code, id) {
      // 只在开发模式下处理
      if (!isDevelopment) {
        return null;
      }
      // 只处理jsx和tsx文件
      if (!/\.(jsx|tsx)$/.test(id)) {
        return null;
      }
      // 只处理pages目录中的文件
      const relativeId = id.replace(viteRoot + '/', '');
      if (!relativeId.startsWith(`${pagesDir}/`) && !relativeId.startsWith(`${pagesDir}\\`)) {
        return null;
      }

      // 跳过node_modules
      if (id.includes('node_modules')) {
        return null;
      }

      // 如果启用data-code属性添加
      if (enableDataCode) {
        return addDataCodeAttributes(code, id);
      }

      return null;
    },

    handleHotUpdate({ file }) {
      // 当文件变化时，重新扫描组件
      if (isDevelopment && /\.(jsx|tsx)$/.test(file)) {
        if (scanner) {
          scanner.scanAll();
        }
      }
    },

    transformIndexHtml(html, ctx) {
      // 只在开发模式下处理
      if (!isDevelopment) {
        return html;
      }
      // 检查是否是编辑器模式（通过 URL 参数或路径判断）
      const path = ctx?.originalUrl || '';
      const isEditorMode = path.includes('__editor_canvas') ||
                          path.includes('__editor_preview');
      if (!isEditorMode) {
        return html;
      }

      // 修改 index.html 中的入口脚本路径
      // 使用通配符匹配任何 script type="module" 标签
      const modifiedHtml = html.replace(
        /<script\s+type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/g,
        () => {
          return '<script type="module" src="/Canvas.tsx">';
        }
      );

      return modifiedHtml;
    },
  };
}

/**
 * 为React组件添加data-code属性（使用AST转换）
 * @param code 源代码
 * @param id 文件路径
 */
function addDataCodeAttributes(
  code: string,
  id: string
): { code: string; map?: any } {
  try {
    // 使用Babel AST转换，添加真实的data-code属性
    return transformJSXWithAttributes(code, id);
  } catch (error) {
    // 如果出错，返回原代码
    console.error('[vite-plugin-airiot] Error adding data-code:', error);
    return { code };
  }
}

export default airiotPlugin;
