import { Plugin } from 'vite';
import { ComponentScanner } from './componentScanner';
import { createExpressServer } from './server';
import { resolve } from 'path';
import { setPagesDir } from './fileApiPlugin';
import { spawn } from 'child_process';

export interface PluginOptions {
  enableDataCode?: boolean;
  enableComponentRoutes?: boolean;
  rootDir?: string;
  pagesDir?: string;
  componentsDir?: string;
  /**
   * data-code实现方式：
   * - 'patch': 运行时patch React.createElement（推荐，无需Babel依赖）
   * - 'ast': 编译时AST转换（需要@babel/generator）
   * @default 'patch'
   */
  dataCodeImplementation?: 'patch' | 'ast';
}

export function airiotPlugin(options: PluginOptions = {}): Plugin {
  console.log('[vite-plugin-airiot] Plugin loading...');

  const {
    enableDataCode = true,
    enableComponentRoutes = true,
    rootDir,
    pagesDir = 'pages',
    componentsDir = 'components',
    dataCodeImplementation = 'patch',
  } = options;

  let scanner: ComponentScanner;
  let isDevelopment = true;

  return {
    name: 'vite-plugin-airiot',
    enforce: 'post',

    config: ({ mode }, { command }) => {
      isDevelopment = command === 'serve';
      console.log('[vite-plugin-airiot] Config hook - command:', command, 'isDevelopment:', isDevelopment, 'implementation:', dataCodeImplementation);

      return {
        server: {
          cors: true,
        },
      };
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

      // 如果使用patch方式，注入React patch代码
      if (enableDataCode && dataCodeImplementation === 'patch') {
        console.log('[vite-plugin-airiot] Using React patch implementation');

        // 注入patch代码到所有HTML响应
        server.middlewares.use((req: any, res: any, next: any) => {
          if (req.url?.endsWith('.html') || req.url === '/') {
            const originalEnd = res.end;

            res.end = function(chunk?: any, encoding?: any) {
              if (chunk && typeof chunk === 'string' && chunk.includes('</body>')) {
                const patchScript = generatePatchScript();
                const modifiedChunk = chunk.replace('</body>', patchScript + '</body>');
                originalEnd.call(this, modifiedChunk, encoding);
              } else {
                originalEnd.call(this, chunk, encoding);
              }
            }.bind(res);
          }
          next();
        });
      }
    },

    async transform(code, id) {
      // 只在开发模式下处理
      if (!isDevelopment) {
        return null;
      }

      // 只处理jsx和tsx文件
      if (!/\.(jsx|tsx)$/.test(id)) {
        return null;
      }

      // 跳过node_modules
      if (id.includes('node_modules')) {
        return null;
      }

      // AST方式处理
      if (enableDataCode && dataCodeImplementation === 'ast') {
        try {
          const { transformJSXWithAttributes } = await import('./jsxTransform');
          return transformJSXWithAttributes(code, id);
        } catch (error) {
          console.error('[vite-plugin-airiot] AST transform error:', error);
          // 如果AST转换失败，回退到不添加data-code
          return { code };
        }
      }

      return null;
    },

    handleHotUpdate({ file }) {
      if (isDevelopment && /\.(jsx|tsx)$/.test(file)) {
        if (selector) {
          scanner.scanAll();
        }
      }
    },
  };
}

/**
 * 生成React patch脚本
 */
function generatePatchScript(): string {
  return `
<script type="module">
(function() {
  'use strict';

  console.log('[vite-plugin-airiot] Initializing React patch...');

  // 等待DOM加载完成
  function initPatch() {
    // 查找React对象
    const react = window.React || window.__REACT__;

    if (!react || typeof react.createElement !== 'function') {
      console.warn('[vite-plugin-airiot] React not found, patching skipped');
      return;
    }

    const originalCreateElement = react.createElement;

    // 保存原始方法
    if (!originalCreateElement.__airiot_original) {
      originalCreateElement.__airiot_original = originalCreateElement.bind(react);
    }

    // 组件信息缓存
    const componentCache = new WeakMap();

    /**
     * 从调用栈提取组件信息
     */
    function extractComponentInfo() {
      const stack = new Error().stack;
      if (!stack) return null;

      const lines = stack.split('\\n');

      for (const line of lines) {
        // 匹配模式：at Dashboard (/src/pages/Dashboard.tsx:10:15)
        const match = line.match(/at\\s+(\\w+)\\s+\\(([^:]+):(\\d+):(\\d+)\\)/);
        if (match) {
          const [, componentName, filePath, line, col] = match;

          // 过滤掉node_modules等
          if (filePath.includes('node_modules') || filePath.includes('<')) {
            continue;
          }

          // 只处理.tsx或.jsx文件
          if (/\\.(tsx|jsx)$/.test(filePath)) {
            return {
              filePath: filePath.replace(/^\\//, ''),
              line: parseInt(line, 10),
              column: parseInt(col, 10),
              componentName,
            };
          }
        }

        // 简化匹配：at FunctionName (/path/to/file.tsx:line)
        const simpleMatch = line.match(/at\\s+(\\w+)\\s+\\(([^:]+):(\\d+)\\)/);
        if (simpleMatch) {
          const [, componentName, filePath, line] = simpleMatch;

          if (filePath.includes('node_modules') || filePath.includes('<')) {
            continue;
          }

          if (/\\.(tsx|jsx)$/.test(filePath)) {
            return {
              filePath: filePath.replace(/^\\//, ''),
              line: parseInt(line, 10),
              column: 0,
              componentName,
            };
          }
        }
      }

      return null;
    }

    /**
     * 判断是否是React组件
     */
    function isReactComponent(type) {
      if (typeof type === 'function') {
        const name = type.displayName || type.name;
        return name && /^[A-Z]/.test(name);
      }
      if (typeof type === 'object' && type !== null) {
        const $$typeof = type.$$typeof;
        // React组件类型的$$typeof值
        return $$typeof === 0xeac7 || // Memo
               $$typeof === 0xeac8 || // ForwardRef
               $$typeof === 0xeaa1;  // ForwardRef
      }
      return false;
    }

    /**
     * Patch后的createElement
     */
    function patchedCreateElement(type, props, ...children) {
      // 只处理React组件
      if (isReactComponent(type) && props && typeof props === 'object') {
        let info = componentCache.get(type);

        if (!info) {
          info = extractComponentInfo();
          if (info) {
            componentCache.set(type, info);
          }
        }

        // 添加data-code属性
        if (info && !props['data-code']) {
          props = {
            ...props,
            'data-code': info.filePath + ':' + info.line
          };
        }
      }

      return originalCreateElement.call(react, type, props, ...children);
    }

    // 应用patch
    react.createElement = patchedCreateElement;
    console.log('[vite-plugin-airiot] React patch applied successfully');
    console.log('[vite-plugin-airiot] Components will now have data-code attributes');
  }

  // 在页面加载后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPatch);
  } else {
    // DOM已加载，直接初始化
    setTimeout(initPatch, 0);
  }
})();
</script>
  `;
}

export default airiotPlugin;
