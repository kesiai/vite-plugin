import { ComponentScanner } from './componentScanner';
import { ViteDevServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileApiPlugin, setScanner } from './fileApiPlugin';

type NextFunction = () => void;

/**
 * /__editor/* API 处理器（Connect 兼容中间件）。
 * 说明：本服务面向本地开发，未做鉴权，请勿暴露到公网。
 */
export function createApiHandler(scanner: ComponentScanner, viteServer: ViteDevServer) {
  // 将 scanner 实例传递给 fileApiPlugin（文件变更后自动重扫）
  setScanner(scanner);

  return async (req: any, res: any, next: NextFunction) => {
    // 只处理 /__editor 开头的请求
    if (!req.url?.startsWith('/__editor')) {
      return next();
    }

    // 解析 JSON body（GET 请求无 body）
    if (['POST', 'DELETE', 'PUT'].includes(req.method) && !req.body) {
      req.body = await parseJsonBody(req);
    }

    // 设置基础响应头
    if (res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    // 处理 CORS 预检
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      if (res.end) res.end();
      return;
    }

    try {
      const url = new URL(req.url!, `http://${req.headers?.host || 'localhost'}`);
      const pathname = url.pathname;

      // ==================== File API ====================

      if (pathname === '/__editor/file' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        return fileApiPlugin(req, res);
      }

      // ==================== Components API ====================

      if (pathname === '/__editor/components' && req.method === 'GET') {
        const components = scanner.getComponents();

        sendJson(res, {
          success: true,
          data: components.map((comp) => ({
            name: comp.name,
            dataCode: comp.dataCode,
            filePath: comp.relativePath,
            lineNumber: comp.lineNumber,
          })),
        });
        return;
      }

      // ==================== UI API ====================

      if (pathname === '/__editor/ui' && req.method === 'GET') {
        const pageComponents = scanner.getPageComponents();

        const routes = pageComponents.map((comp) => ({
          component: comp.name,
          route: scanner.getComponentRoute(comp),
          filePath: comp.relativePath,
          lineNumber: comp.lineNumber,
        }));

        sendJson(res, {
          success: true,
          data: routes,
        });
        return;
      }

      // ==================== Routers API ====================

      if (pathname === '/__editor/routers' && req.method === 'GET') {
        const routes = extractRoutes(viteServer.config.root);

        sendJson(res, {
          success: true,
          data: routes,
        });
        return;
      }

      if (pathname === '/__editor/routers' && req.method === 'POST') {
        const routes = await getJsonBody(req);

        if (!Array.isArray(routes)) {
          sendJson(res, {
            success: false,
            error: 'routes must be an array',
          }, 400);
          return;
        }

        const result = updateRoutes(viteServer.config.root, routes);

        sendJson(res, {
          success: true,
          data: result,
        });
        return;
      }

      // ==================== Status API ====================

      if (pathname === '/__editor/status' && req.method === 'GET') {
        const status = getRuntimeStatus(viteServer);

        sendJson(res, {
          success: true,
          data: status,
        });
        return;
      }

      // ==================== Install Package API ====================

      if (pathname === '/__editor/install-package' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { packageName } = body;

        if (!packageName) {
          sendJson(res, {
            success: false,
            error: 'packageName is required',
          }, 400);
          return;
        }

        return streamSubprocess(
          res,
          { type: 'start', message: `开始安装包 ${packageName}...` },
          { type: 'complete', message: `包 ${packageName} 安装完成` },
          (onOutput) => installPackageWithOutput(packageName, viteServer.config.root, onOutput)
        );
      }

      // ==================== Install shadcn API ====================

      if (pathname === '/__editor/install-shadcn' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { componentName } = body;

        if (!componentName) {
          sendJson(res, {
            success: false,
            error: 'componentName is required',
          }, 400);
          return;
        }

        return streamSubprocess(
          res,
          { type: 'start', message: `开始安装 shadcn 组件 ${componentName}...` },
          { type: 'complete', message: `shadcn 组件 ${componentName} 安装完成` },
          (onOutput) => installShadcnComponentWithOutput(componentName, viteServer.config.root, onOutput)
        );
      }

      // ==================== Modify Code API ====================

      if (pathname === '/__editor/modify-code' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { componentName, modifications } = body;

        if (!componentName) {
          sendJson(res, {
            success: false,
            error: 'componentName is required',
          }, 400);
          return;
        }

        if (!Array.isArray(modifications)) {
          sendJson(res, {
            success: false,
            error: 'modifications must be an array',
          }, 400);
          return;
        }

        try {
          const result = await modifyComponentCode(scanner, componentName, modifications);

          sendJson(res, {
            success: true,
            data: result,
          });
        } catch (error: any) {
          sendJson(res, {
            success: false,
            error: error.message,
          }, 500);
        }
        return;
      }

      // ==================== Plugin Check API ====================

      if (pathname === '/__editor/plugin-check' && req.method === 'GET') {
        sendJson(res, {
          success: true,
          data: {
            hasPlugin: true,
            pluginName: '@kesi/vite-plugin',
            version: '1.0.0',
            message: 'Plugin is installed and active',
          },
        });
        return;
      }

      // ==================== Package JSON API ====================

      if (pathname === '/__editor/package-json' && req.method === 'GET') {
        try {
          const packageJsonPath = path.join(viteServer.config.root, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            sendJson(res, {
              success: true,
              data: {
                dependencies: packageJson.dependencies || {},
                devDependencies: packageJson.devDependencies || {},
                hasKesiClient: !!(packageJson.dependencies && packageJson.dependencies['@kesi/client']),
              },
            });
          } else {
            sendJson(res, {
              success: false,
              error: 'package.json not found',
            }, 404);
          }
        } catch (error: any) {
          sendJson(res, {
            success: false,
            error: error.message,
          }, 500);
        }
        return;
      }

      // ==================== Install Client API ====================

      if (pathname === '/__editor/install-client' && req.method === 'POST') {
        return streamSubprocess(
          res,
          { type: 'start', message: '开始安装 @kesi/client...' },
          { type: 'complete', message: '@kesi/client 安装完成' },
          (onOutput) => installPackageWithOutput('@kesi/client', viteServer.config.root, onOutput)
        );
      }

      // ==================== Init Config API ====================

      if (pathname === '/__editor/init-config' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { projectId } = body;

        if (!projectId) {
          sendJson(res, {
            success: false,
            error: 'projectId is required',
          }, 400);
          return;
        }

        try {
          const configPath = path.join(viteServer.config.root, 'kesi.config.ts');
          const configContent = `import { defineConfig } from '@kesi/client';

export default defineConfig({
  projectId: '${projectId}',
});
`;
          fs.writeFileSync(configPath, configContent, 'utf-8');

          sendJson(res, {
            success: true,
            data: {
              configPath,
              projectId,
            },
          });
        } catch (error: any) {
          sendJson(res, {
            success: false,
            error: error.message,
          }, 500);
        }
        return;
      }

      // ==================== Build API ====================

      if (pathname === '/__editor/build' && req.method === 'POST') {
        return streamSubprocess(
          res,
          { type: 'start', message: '开始构建项目...' },
          { type: 'complete', message: '构建完成' },
          (onOutput) => runBuildWithOutput(viteServer.config.root, onOutput)
        );
      }

      // 404 - 未找到的 API
      sendJson(res, {
        success: false,
        error: 'API endpoint not found',
      }, 404);
    } catch (error: any) {
      sendJson(res, {
        success: false,
        error: error.message,
      }, 500);
    }
  };
}

// ==================== Helper Functions ====================

/**
 * 解析 JSON 请求体
 */
function parseJsonBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: any) => {
      data += chunk;
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function sendJson(res: any, data: any, statusCode = 200) {
  res.statusCode = statusCode;
  if (res.setHeader) {
    res.setHeader('Content-Type', 'application/json');
  }

  const jsonData = JSON.stringify(data, null, 2);
  if (res.end) {
    res.end(jsonData);
  }
}

async function getJsonBody(req: any): Promise<any> {
  // body 已在 createApiHandler 中预先解析
  return req.body || null;
}

/**
 * 以 SSE 流式输出子进程执行结果，统一封装
 * （install-package / install-shadcn / install-client / build 等）
 */
async function streamSubprocess(
  res: any,
  startEvent: { type: string; message?: string },
  completeEvent: { type: string; message?: string },
  run: (onOutput: (output: string) => void) => Promise<any>
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify(startEvent)}\n\n`);

  try {
    await run((output) => {
      res.write(`data: ${JSON.stringify({ type: 'output', data: output })}\n\n`);
    });
    res.write(`data: ${JSON.stringify(completeEvent)}\n\n`);
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  }

  res.end();
}

function extractRoutes(root: string): any[] {
  const routeFiles = [
    'src/router/index.tsx',
    'src/router/index.ts',
    'src/App.tsx',
    'src/App.jsx',
  ];

  const routes: any[] = [];

  for (const file of routeFiles) {
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath)) {
      routes.push({
        file,
        path: filePath,
        status: 'found',
      });
    }
  }

  return routes;
}

function updateRoutes(root: string, routes: any[]): any {
  const routeFile = path.join(root, 'src/router/index.tsx');

  return {
    message: 'Routes updated',
    file: routeFile,
    routes,
  };
}

function getRuntimeStatus(viteServer: ViteDevServer): any {
  const address = viteServer.httpServer?.address();
  const port = typeof address === 'object' ? address?.port : null;
  const hostname = typeof address === 'object' ? address?.address : null;

  return {
    mode: 'development',
    running: true,
    port,
    hostname,
    origin: (viteServer as any).origin,
    timestamp: Date.now(),
  };
}

/**
 * 安装 npm 包（SSE 输出回调）
 */
async function installPackageWithOutput(
  packageName: string,
  root: string,
  onOutput: (data: string) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', packageName, '--save', '--force'], {
      cwd: root,
      shell: true,
      env: { ...process.env, NODE_ENV: 'development' },
    });

    npm.stdout?.on('data', (data) => onOutput(data.toString()));
    npm.stderr?.on('data', (data) => onOutput(data.toString()));

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({ packageName, success: true });
      } else {
        reject(new Error(`npm install failed with code ${code}`));
      }
    });

    npm.on('error', (err) => {
      reject(new Error(`Failed to start npm process: ${err.message}`));
    });
  });
}

/**
 * 安装 shadcn/ui 组件（SSE 输出回调）
 */
async function installShadcnComponentWithOutput(
  componentName: string,
  root: string,
  onOutput: (data: string) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const npx = spawn('npx', ['shadcn-ui@latest', 'add', componentName], {
      cwd: root,
      shell: true,
    });

    npx.stdout?.on('data', (data) => onOutput(data.toString()));
    npx.stderr?.on('data', (data) => onOutput(data.toString()));

    npx.on('close', (code) => {
      if (code === 0) {
        resolve({ componentName, success: true });
      } else {
        reject(new Error(`shadcn install failed with code ${code}`));
      }
    });
  });
}

/**
 * 修改组件代码：通过 scanner 找到组件文件（保证与磁盘一致），
 * 再按 modifications 依次应用 replace / insert / append / prepend。
 */
async function modifyComponentCode(
  scanner: ComponentScanner,
  componentName: string,
  modifications: any[]
): Promise<any> {
  const scan = scanner.scanAll();
  const component = scan.components.find((c) => c.name === componentName);

  if (!component) {
    throw new Error(`Component ${componentName} not found`);
  }

  const filePath = component.filePath;
  let content = fs.readFileSync(filePath, 'utf-8');

  for (const mod of modifications) {
    switch (mod.type) {
      case 'replace':
        content = content.replace(new RegExp(mod.search, 'g'), mod.replace);
        break;
      case 'insert': {
        const lines = content.split('\n');
        const lineIndex = Math.max(0, Math.min(mod.line - 1, lines.length));
        lines.splice(lineIndex, 0, mod.content);
        content = lines.join('\n');
        break;
      }
      case 'append':
        content += `\n${mod.content}`;
        break;
      case 'prepend':
        content = `${mod.content}\n${content}`;
        break;
      default:
        throw new Error(`Unsupported modification type: ${mod.type}`);
    }
  }

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    componentName,
    filePath: component.relativePath,
    modifications: modifications.length,
    success: true,
  };
}

/**
 * 执行构建（SSE 输出回调）
 */
async function runBuildWithOutput(
  root: string,
  onOutput: (data: string) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', ['run', 'build'], {
      cwd: root,
      shell: true,
    });

    npm.stdout?.on('data', (data) => onOutput(data.toString()));
    npm.stderr?.on('data', (data) => onOutput(data.toString()));

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error(`Build failed with code ${code}`));
      }
    });
  });
}

export function createExpressServer(scanner: ComponentScanner, viteServer: ViteDevServer) {
  // 返回兼容 Connect 的中间件函数
  return createApiHandler(scanner, viteServer);
}
