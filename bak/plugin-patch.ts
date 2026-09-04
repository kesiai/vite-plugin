import { Plugin } from 'vite';
import { ComponentScanner, ComponentData } from './componentScanner';
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
   * data-code实现方式
   * - 'patch': 运行时patch React.createElement（需要注入初始化代码）
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
    enforce: 'pre',

    config: ({ mode }, { command }) => {
      isDevelopment = command === 'serve';
      console.log('[vite-plugin-airiot] Config hook - command:', command, 'isDevelopment:', isDevelopment);

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
        server.middlewares.use((req: any, res: any, next: any) => {
          // 只在主HTML文件加载时注入
          if (req.url === '/' || req.url === '/index.html') {
            // 注入React patch脚本到HTML中
            res.setHeader('Content-Type', 'text/html');

            const transformStream = (await import('vite')).transformIndexHtml(
              req.url,
              res,
              '/',
              {
                transform(html: string) {
                  // 在</body>前注入patch脚本
                  const patchScript = `
<script type="module">
(function() {
  // 收集所有组件的data-code信息
  const componentDataCodeMap = new Map();

  // 解析调用栈获取组件位置
  function parseComponentFromStack() {
    const stack = new Error().stack;
    if (!stack) return null;

    const lines = stack.split('\\n');
    for (const line of lines) {
      // 匹配类似 "at Dashboard (/src/pages/Dashboard.tsx:10:15)"
      const match = line.match(/at (\\w+)\\s+\\(([^:]+):(\\d+):(\\d+)/);
      if (match) {
        const [, componentName, filePath, line, column] = match;
        return { componentName, filePath, line: Number(column), column: Number(column) };
      }
      // 匹配简化版
      const simpleMatch = line.match(/at (\\w+)\\s+\\(([^:]+):(\\d+)/);
      if (simpleMatch) {
        const [, componentName, filePath, line] = simpleMatch;
        return { componentName, filePath, line: Number(line), column: 0 };
      }
    }
    }

    // 获取组件信息
    function getComponentInfo() {
      const info = parseComponentFromStack();
      if (info) {
        return \`\${info.filePath}:\${info.line}\`;
      }
      return null;
    }

  // 等待React加载
  if (typeof window !== 'undefined' && window.__REACT__) {
    const originalCreateElement = window.__REACT__.createElement;

    window.__REACT__.createElement = function(type, props, ...children) {
      // 只处理函数组件
      if (typeof type === 'function' || (typeof type === 'object' && type?.$$typeof)) {
        const dataCode = getComponentInfo();

        if (dataCode && props && !props['data-code']) {
          // 添加data-code属性
          props = { ...props, 'data-code': dataCode };
        }
      }

      return originalCreateElement.call(this, type, props, ...children);
    };

    console.log('[vite-plugin-airiot] React patched for data-code attributes');
  }
})();
</script>
                  `;
                  return html.replace('</body>', patchScript + '</body>');
                },
              }
            );

            // 注意：由于stream模式，这里需要直接返回
            // Vite会处理这个transform
          } else {
            next();
          }
        });
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

      // 跳过node_modules
      if (id.includes('node_modules')) {
        return null;
      }

      // 如果使用AST方式
      if (enableDataCode && dataCodeImplementation === 'ast') {
        const { addDataCodeAST } = require('./jsxTransform');
        return addDataCodeAST(code, id);
      }

      // patch方式不需要在transform中处理
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
