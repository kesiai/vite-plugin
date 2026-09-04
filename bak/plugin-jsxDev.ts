import { Plugin } from 'vite';
import { ComponentScanner } from './componentScanner';
import { createExpressServer } from './server';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setPagesDir } from './fileApiPlugin';
import { spawn } from 'node:child_process';

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

  return {
    name: 'vite-plugin-airiot',

    config(_config, { command }) {
      isDevelopment = command === 'serve';
      console.log('[vite-plugin-airiot] Config hook - command:', command, 'isDevelopment:', isDevelopment);
      return {};
    },

    configureServer(server) {
      if (!isDevelopment) {
        return;
      }

      console.log('[vite-plugin-airiot] configureServer called, command:', server.config.command);

      // 计算根目录：如果用户提供了 rootDir，则使用它，否则使用 Vite 的 root
      const resolvedRootDir = rootDir ? resolve(rootDir) : server.config.root;
      console.log('[vite-plugin-airiot] Root directory:', resolvedRootDir);
      console.log('[vite-plugin-airiot] Pages directory:', pagesDir);
      console.log('[vite-plugin-airiot] Components directory:', componentsDir);

      // 设置 fileApiPlugin 的 pages 目录
      const pagesDirPath = resolve(resolvedRootDir, pagesDir);
      setPagesDir(pagesDir, resolvedRootDir);

      // 动态创建 .airiot 目录和 editor.js 入口文件
      const airiotDir = join(resolvedRootDir, 'node_modules', '.airiot');
      if (!existsSync(airiotDir)) {
        mkdirSync(airiotDir, { recursive: true });
        console.log('[vite-plugin-airiot] Created .airiot directory:', airiotDir);
      }

      const editorJsPath = join(airiotDir, 'editor.tsx');
      const editorContent = `import React from 'react';
import ReactDOM from 'react-dom/client';
import { Canvas } from '/src/Canvas';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("Could not find root element");

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <Canvas />
  </React.StrictMode>
);
`;
      writeFileSync(editorJsPath, editorContent, 'utf-8');
      console.log('[vite-plugin-airiot] Created editor.tsx entry file:', editorJsPath);

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
      const opencode = spawn('opencode', ['web', '--hostname', '0.0.0.0'], {
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
    },

    transform(_code, _id) {
      // 不需要在 transform 中处理，jsx-runtime 会自动添加 data-code
      return null;
    },

    handleHotUpdate({ file }) {
      if (isDevelopment && /\.(jsx|tsx)$/.test(file)) {
        if (scanner) {
          scanner.scanAll();
        }
      }
    },
  };
}

export default airiotPlugin;
