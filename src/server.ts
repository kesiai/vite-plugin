import { ComponentScanner, ComponentData } from './componentScanner';
import { ViteDevServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileApiPlugin, setScanner } from './fileApiPlugin';

interface ServerOptions {
  enableDataCode: boolean;
  enableComponentRoutes: boolean;
  pagesDir: string;
  componentsDir: string;
}

type NextFunction = () => void;

interface Request {
  url?: string;
  method?: string;
  body?: any;
}

interface Response {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end?: (data?: string) => void;
  json?: (data: any) => void;
}

export function createApiHandler(
  scanner: ComponentScanner,
  viteServer: ViteDevServer,
  options: ServerOptions
) {
  // 将 scanner 实例传递给 fileApiPlugin
  setScanner(scanner);

  return async (req: any, res: any, next: NextFunction) => {

    // 只处理/__airiot开头的请求
    if (!req.url?.startsWith('/__airiot')) {
      return next();
    }

    // 解析JSON body
    if (req.method === 'POST' && !req.body) {
      req.body = await parseJsonBody(req);
    }

    // 设置CORS头
    if (res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      if (res.end) res.end();
      return;
    }

    try {
      const url = new URL(req.url!, `http://${req.headers?.host || 'localhost'}`);
      const pathname = url.pathname;

      if(pathname === '/__airiot/file' && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
        return fileApiPlugin(req, res);
      }

      // ==================== Components API ====================

      if (pathname === '/__airiot/components' && req.method === 'GET') {
        const components = scanner.getComponents();

        sendJson(res, {
          success: true,
          data: components.map(comp => ({
            name: comp.name,
            dataCode: comp.dataCode,
            filePath: comp.relativePath,
            lineNumber: comp.lineNumber,
          })),
        });
        return;
      }

      // ==================== UI API ====================

      if (pathname === '/__airiot/ui' && req.method === 'GET') {
        const pageComponents = scanner.getPageComponents();

        const routes = pageComponents.map(comp => ({
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

      if (pathname === '/__airiot/routers' && req.method === 'GET') {
        const routes = extractRoutes(viteServer.config.root);

        sendJson(res, {
          success: true,
          data: routes,
        });
        return;
      }

      if (pathname === '/__airiot/routers' && req.method === 'POST') {
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

      if (pathname === '/__airiot/status' && req.method === 'GET') {
        const status = getRuntimeStatus(viteServer);

        sendJson(res, {
          success: true,
          data: status,
        });
        return;
      }

      // ==================== Install Package API ====================

      if (pathname === '/__airiot/install-package' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { packageName } = body;

        if (!packageName) {
          sendJson(res, {
            success: false,
            error: 'packageName is required',
          }, 400);
          return;
        }

        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 发送开始事件
        res.write(`data: ${JSON.stringify({ type: 'start', message: `开始安装包 ${packageName}...` })}\n\n`);

        try {
          await installPackageWithOutput(packageName, viteServer.config.root, (output) => {
            // 发送输出事件
            res.write(`data: ${JSON.stringify({ type: 'output', data: output })}\n\n`);
          });

          // 发送完成事件
          res.write(`data: ${JSON.stringify({ type: 'complete', message: `包 ${packageName} 安装完成` })}\n\n`);
        } catch (error: any) {
          // 发送错误事件
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        }

        res.end();
        return;
      }

      // ==================== Install shadcn API ====================

      if (pathname === '/__airiot/install-shadcn' && req.method === 'POST') {
        const body = await getJsonBody(req);
        const { componentName } = body;

        if (!componentName) {
          sendJson(res, {
            success: false,
            error: 'componentName is required',
          }, 400);
          return;
        }

        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 发送开始事件
        res.write(`data: ${JSON.stringify({ type: 'start', message: `开始安装 shadcn 组件 ${componentName}...` })}\n\n`);

        try {
          await installShadcnComponentWithOutput(componentName, viteServer.config.root, (output) => {
            // 发送输出事件
            res.write(`data: ${JSON.stringify({ type: 'output', data: output })}\n\n`);
          });

          // 发送完成事件
          res.write(`data: ${JSON.stringify({ type: 'complete', message: `shadcn 组件 ${componentName} 安装完成` })}\n\n`);
        } catch (error: any) {
          // 发送错误事件
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        }

        res.end();
        return;
      }

      // ==================== Modify Code API ====================

      if (pathname === '/__airiot/modify-code' && req.method === 'POST') {
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
          const result = await modifyComponentCode(
            viteServer.config.root,
            componentName,
            modifications
          );

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

      if (pathname === '/__airiot/plugin-check' && req.method === 'GET') {
        // 检查当前项目是否安装了 vite-plugin-airiot
        sendJson(res, {
          success: true,
          data: {
            hasPlugin: true,
            pluginName: 'vite-plugin-airiot',
            version: '1.0.0',
            message: 'Plugin is installed and active'
          }
        });
        return;
      }

      // ==================== Package JSON API ====================

      if (pathname === '/__airiot/package-json' && req.method === 'GET') {
        try {
          const packageJsonPath = path.join(viteServer.config.root, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            sendJson(res, {
              success: true,
              data: {
                dependencies: packageJson.dependencies || {},
                devDependencies: packageJson.devDependencies || {},
                hasAiriotClient: !!(packageJson.dependencies && packageJson.dependencies['@airiot/client']),
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

      // ==================== Install AIRIOT Client API ====================

      if (pathname === '/__airiot/install-airiot-client' && req.method === 'POST') {
        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 发送开始事件
        res.write(`data: ${JSON.stringify({ type: 'start', message: '开始安装 @airiot/client...' })}\n\n`);

        try {
          await installPackageWithOutput('@airiot/client', viteServer.config.root, (output) => {
            // 发送输出事件
            res.write(`data: ${JSON.stringify({ type: 'output', data: output })}\n\n`);
          });

          // 发送完成事件
          res.write(`data: ${JSON.stringify({ type: 'complete', message: '@airiot/client 安装完成' })}\n\n`);
        } catch (error: any) {
          // 发送错误事件
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        }

        res.end();
        return;
      }

      // ==================== Init AIRIOT Config API ====================

      if (pathname === '/__airiot/init-airiot-config' && req.method === 'POST') {
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
          // 创建或更新 airiot.config.ts
          const configPath = path.join(viteServer.config.root, 'airiot.config.ts');
          const configContent = `import { defineConfig } from '@airiot/client';

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

      if (pathname === '/__airiot/build' && req.method === 'POST') {
        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 发送开始事件
        res.write(`data: ${JSON.stringify({ type: 'start', message: '开始构建项目...' })}\n\n`);

        try {
          await runBuildWithOutput(viteServer.config.root, (output) => {
            // 发送输出事件
            res.write(`data: ${JSON.stringify({ type: 'output', data: output })}\n\n`);
          });

          // 发送完成事件
          res.write(`data: ${JSON.stringify({ type: 'complete', message: '构建完成' })}\n\n`);
        } catch (error: any) {
          // 发送错误事件
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        }

        res.end();
        return;
      }

      // 404 - 未找到的API
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
 * 解析JSON请求体
 */
async function parseJsonBody(req: any): Promise<any> {
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
  // body已经在createApiHandler中预先解析了
  return req.body || null;
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
 * 安装npm包（带输出回调）
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

    npm.stdout?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npm.stderr?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({
          packageName,
          success: true,
        });
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
 * 安装npm包
 */
async function installPackage(packageName: string, root: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', packageName, '--save', '--force'], {
      cwd: root,
      shell: true,
      env: { ...process.env, NODE_ENV: 'development' },
    });

    let stdout = '';
    let stderr = '';

    npm.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    npm.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({
          packageName,
          success: true,
          stdout,
          stderr,
        });
      } else {
        reject(new Error(`npm install failed with code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * 安装shadcn/ui组件（带输出回调）
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

    npx.stdout?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npx.stderr?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npx.on('close', (code) => {
      if (code === 0) {
        resolve({
          componentName,
          success: true,
        });
      } else {
        reject(new Error(`shadcn install failed with code ${code}`));
      }
    });
  });
}

/**
 * 安装shadcn/ui组件
 */
async function installShadcnComponent(componentName: string, root: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const npx = spawn('npx', ['shadcn-ui@latest', 'add', componentName], {
      cwd: root,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    npx.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    npx.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    npx.on('close', (code) => {
      if (code === 0) {
        resolve({
          componentName,
          success: true,
          stdout,
          stderr,
        });
      } else {
        reject(new Error(`shadcn install failed with code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * 扫描所有组件（辅助函数）
 */
function scanComponents(root: string): ComponentData[] {
  const components: ComponentData[] = [];

  function scanDir(dir: string, baseDir = '') {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.') && entry.name !== 'dist') {
          scanDir(fullPath, baseDir || entry.name);
        }
      } else if (/\.(jsx|tsx)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relativePath = path.relative(root, fullPath);

          // 提取组件
          const lines = content.split('\n');
          lines.forEach((line, index) => {
            const patterns = [
              /^\s*(?:export\s+(?:default\s+)?function|function)\s+([A-Z][a-zA-Z0-9_]*)/,
              /^\s*(?:export\s+(?:default\s+)?)?const\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function)/,
            ];

            for (const pattern of patterns) {
              const match = line.match(pattern);
              if (match) {
                components.push({
                  name: match[1],
                  filePath: relativePath,
                  relativePath,
                  lineNumber: index + 1,
                  dataCode: `${relativePath}:${index + 1}`,
                  displayName: match[1],
                });
                break;
              }
            }
          });
        } catch (error) {
          // 忽略读取错误
        }
      }
    }
  }

  scanDir(root);
  return components;
}

/**
 * 修改组件代码
 */
async function modifyComponentCode(
  root: string,
  componentName: string,
  modifications: any[]
): Promise<any> {
  // 查找组件文件
  const components = scanComponents(root);
  const component = components.find(c => c.name === componentName);

  if (!component) {
    throw new Error(`Component ${componentName} not found`);
  }

  const filePath = path.join(root, component.filePath);
  let content = fs.readFileSync(filePath, 'utf-8');

  // 应用修改
  for (const mod of modifications) {
    switch (mod.type) {
      case 'replace':
        content = content.replace(new RegExp(mod.search, 'g'), mod.replace);
        break;
      case 'insert':
        const lines = content.split('\n');
        const lineIndex = Math.max(0, Math.min(mod.line - 1, lines.length));
        lines.splice(lineIndex, 0, mod.content);
        content = lines.join('\n');
        break;
      case 'append':
        content += `\n${mod.content}`;
        break;
      case 'prepend':
        content = `${mod.content}\n${content}`;
        break;
    }
  }

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    componentName,
    filePath: component.filePath,
    modifications: modifications.length,
    success: true,
  };
}

/**
 * 执行构建（带输出回调）
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

    npm.stdout?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npm.stderr?.on('data', (data) => {
      const output = data.toString();
      onOutput(output);
    });

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
        });
      } else {
        reject(new Error(`Build failed with code ${code}`));
      }
    });
  });
}

/**
 * 执行构建
 */
async function runBuild(root: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', ['run', 'build'], {
      cwd: root,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    npm.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    npm.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    npm.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          stdout,
          stderr,
        });
      } else {
        reject(new Error(`Build failed with code ${code}: ${stderr}`));
      }
    });
  });
}

export function createExpressServer(
  scanner: ComponentScanner,
  viteServer: ViteDevServer,
  options: ServerOptions
) {
  // 这个函数现在返回一个兼容Connect的中间件函数
  return createApiHandler(scanner, viteServer, options);
}
