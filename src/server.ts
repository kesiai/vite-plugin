import { ComponentScanner } from './componentScanner';
import { ViteDevServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileApiPlugin, setScanner } from './fileApiPlugin';
import type { AliasEntry } from './editor/paths';
import { EditorError } from './editor/common';
import { ResolveContext, readProjectFile, writeProjectFile, resolvePageRel } from './editor/paths';
import {
  getPageTree,
  getNodeSource,
  setPageProps,
  setPageChildren,
  addPageComponent,
  removePageComponent,
  CopyResult,
} from './editor/page';
import { componentSchema } from './editor/schema';
import { decodeNodeId } from './nodeId';
import { PageHistory } from './editor/history';
import { copyNodeSubtree, pasteNodeSubtree, applyHistory } from './editor/page';

type NextFunction = () => void;

/** 页面编辑类接口所需的上下文 */
export interface EditorApiContext {
  rootDir: string;
  pagesDir: string;
  aliases?: AliasEntry[];
}

/**
 * /__editor/* API 处理器（Connect 兼容中间件）。
 * 说明：本服务面向本地开发，未做鉴权，请勿暴露到公网。
 */
export function createApiHandler(
  scanner: ComponentScanner,
  viteServer: ViteDevServer,
  editorCtx: EditorApiContext
) {
  // 将 scanner 实例传递给 fileApiPlugin（文件变更后自动重扫）
  setScanner(scanner);

  const ctx: ResolveContext = {
    rootDir: editorCtx.rootDir,
    aliases: editorCtx.aliases,
  };
  const pagesDir = editorCtx.pagesDir;
  const history = new PageHistory();
  let clipboard: CopyResult | null = null;

  /** 读取一个页面文件文本（相对路径解析 + 存在性检查） */
  const pageText = (page: string): { rel: string; text: string } => {
    const rel = resolvePageRel(ctx, pagesDir, page);
    return { rel, text: readProjectFile(ctx, rel) };
  };

  /** 统一执行编辑器动作并渲染成功/失败响应（错误信息完整透出） */
  const runEditorAction = async (
    res: any,
    action: () => any
  ): Promise<void> => {
    try {
      const data = await action();
      sendJson(res, { success: true, data });
    } catch (error: any) {
      if (error instanceof EditorError) {
        sendJson(
          res,
          { success: false, error: { code: error.code, message: error.message, detail: error.detail ?? undefined } },
          error.status
        );
        return;
      }
      // 兜底：完整错误信息（含堆栈），便于排查
      sendJson(
        res,
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error?.message ?? String(error),
            detail: { stack: error?.stack ?? undefined },
          },
        },
        500
      );
    }
  };

  return async (req: any, res: any, next: NextFunction) => {
    // 只处理 /__editor 开头的请求
    if (!req.url?.startsWith('/__editor')) {
      return next();
    }

    // 解析 JSON body（GET 请求无 body）
    if (['POST', 'DELETE'].includes(req.method) && !req.body) {
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

      // ==================== REST: Pages（页面资源） ====================
      // 方法约定：查询 GET；新建 POST /pages；覆盖写 POST /pages/{page}/content；
      // 删除 DELETE（修改类均用 POST，兼容只支持 GET/POST 的服务器/代理）

      const pagesPrefix = '/__editor/pages';
      const pageRestOf = (pathname: string) =>
        decodeURIComponent(pathname.slice(pagesPrefix.length + 1));

      // GET /__editor/pages —— 页面列表
      if (pathname === pagesPrefix && req.method === 'GET') {
        return runEditorAction(res, async () => ({ pages: listPages(ctx, pagesDir) }));
      }

      // POST /__editor/pages —— 新建页面 { path, template? }
      if (pathname === pagesPrefix && req.method === 'POST') {
        return runEditorAction(res, async () => {
          const body = (await getJsonBody(req)) ?? {};
          if (!body.path) throw new EditorError('MISSING_FIELDS', '缺少 path（页面名）', 400);
          const rel = createPageFile(ctx, pagesDir, String(body.path), body.template);
          scanner.scanAll();
          return { page: rel };
        });
      }

      // /__editor/pages/{pagePath} 及其子动作
      if (pathname.startsWith(pagesPrefix + '/')) {
        const rest = pageRestOf(pathname);

        const tryPageAction = async (): Promise<boolean> => {
          if (rest.endsWith('/tree') && req.method === 'GET') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -5));
            const text = readProjectFile(ctx, rel);
            const tree = getPageTree(rel, text, ctx);
            await runEditorAction(res, async () => ({ file: rel, tree }));
            return true;
          }
          if (rest.endsWith('/content') && req.method === 'POST') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -8));
            const body = (await getJsonBody(req)) ?? {};
            if (typeof body.content !== 'string') {
              throw new EditorError('INVALID_CONTENT', 'content 必须是字符串', 400);
            }
            history.push(rel, readProjectFile(ctx, rel));
            writeProjectFile(ctx, rel, body.content);
            scanner.scanAll();
            await runEditorAction(res, async () => ({ file: rel, saved: true }));
            return true;
          }
          if (rest.endsWith('/children') && req.method === 'POST') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -9));
            const text = readProjectFile(ctx, rel);
            const body = (await getJsonBody(req)) ?? {};
            const result = addPageComponent(
              rel,
              text,
              { nodeName: body.nodeName, nodeFile: body.nodeFile, props: body.props, childrenText: body.childrenText },
              ctx,
              history
            );
            scanner.scanAll();
            await runEditorAction(res, async () => result);
            return true;
          }
          if (rest.endsWith('/history') && req.method === 'GET') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -8));
            await runEditorAction(res, async () => ({ ...history.stats(rel), page: rel }));
            return true;
          }
          if (rest.endsWith('/undo') && req.method === 'POST') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -5));
            const text = readProjectFile(ctx, rel);
            const result = applyHistory(ctx, history, rel, text, 'undo');
            scanner.scanAll();
            await runEditorAction(res, async () => ({ ...result, page: rel }));
            return true;
          }
          if (rest.endsWith('/redo') && req.method === 'POST') {
            const rel = resolvePageRel(ctx, pagesDir, rest.slice(0, -5));
            const text = readProjectFile(ctx, rel);
            const result = applyHistory(ctx, history, rel, text, 'redo');
            scanner.scanAll();
            await runEditorAction(res, async () => ({ ...result, page: rel }));
            return true;
          }
          return false;
        };
        if (await tryPageAction()) return;

        // 页面文件本体：GET 读取 / DELETE 删除
        const rel = resolvePageRel(ctx, pagesDir, rest);
        if (req.method === 'GET') {
          await runEditorAction(res, async () => ({ file: rel, content: readProjectFile(ctx, rel) }));
          return;
        }
        if (req.method === 'DELETE') {
          return runEditorAction(res, async () => {
            deletePageFile(ctx, pagesDir, rel);
            scanner.scanAll();
            return { file: rel, deleted: true };
          });
        }
        sendJson(
          res,
          { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '该页面资源仅支持 GET/DELETE；覆盖写请 POST /pages/{page}/content' } },
          405
        );
        return;
      }

      // ==================== REST: Node（页面节点 / 组件资源） ====================

      const nodePrefix = '/__editor/node/';
      if (pathname.startsWith(nodePrefix)) {
        const rest = decodeURIComponent(pathname.slice(nodePrefix.length));

        const parseNodeRest = (restPath: string): { nodeId: string; action: string | null } => {
          for (const suffix of ['/props', '/children/text', '/children', '/schema']) {
            if (restPath.endsWith(suffix)) {
              return { nodeId: restPath.slice(0, -suffix.length), action: suffix.slice(1) };
            }
          }
          return { nodeId: restPath, action: null };
        };
        const { nodeId, action } = parseNodeRest(rest);
        const { rel: file, text } = pageText(inferPageFromNode(nodeId));

        // GET /__editor/node/{id} —— 节点源码 / 属性 / children / AST
        if (action === null && req.method === 'GET') {
          await runEditorAction(res, async () => getNodeSource(file, text, nodeId, ctx));
          return;
        }
        // GET /__editor/node/{id}/schema —— 该组件节点的属性 schema
        if (action === 'schema' && req.method === 'GET') {
          return runEditorAction(res, async () => {
            const info = getNodeSource(file, text, nodeId, ctx);
            if (!info.componentName || !info.componentFile) {
              throw new EditorError('NOT_A_COMPONENT', `节点 <${info.tag}> 不是自定义组件，无属性 schema`, 404);
            }
            const compText = readProjectFile(ctx, info.componentFile);
            return componentSchema(compText, info.componentFile, info.componentName, ctx);
          });
        }
        // POST /__editor/node/{id}/props —— 批量修改属性
        if (action === 'props' && req.method === 'POST') {
          return runEditorAction(res, async () => {
            const body = (await getJsonBody(req)) ?? {};
            const result = setPageProps(file, text, nodeId, body.props, ctx, history);
            scanner.scanAll();
            return result;
          });
        }
        // POST /__editor/node/{id}/children/text —— 用文本替换 children
        if (action === 'children/text' && req.method === 'POST') {
          return runEditorAction(res, async () => {
            const body = (await getJsonBody(req)) ?? {};
            if (typeof body.text !== 'string') throw new EditorError('INVALID_CHILDREN', 'text 必须是字符串', 400);
            const result = setPageChildren(file, text, nodeId, { text: body.text }, ctx, history);
            scanner.scanAll();
            return result;
          });
        }
        // POST /__editor/node/{id}/children —— 插入组件子节点
        if (action === 'children' && req.method === 'POST') {
          return runEditorAction(res, async () => {
            const body = (await getJsonBody(req)) ?? {};
            const result = addPageComponent(
              file,
              text,
              { parentNodeId: nodeId, nodeName: body.nodeName, nodeFile: body.nodeFile, props: body.props, childrenText: body.childrenText },
              ctx,
              history
            );
            scanner.scanAll();
            return result;
          });
        }
        // DELETE /__editor/node/{id} —— 删除节点
        if (action === null && req.method === 'DELETE') {
          return runEditorAction(res, async () => {
            const result = removePageComponent(file, text, nodeId, ctx, history);
            scanner.scanAll();
            return result;
          });
        }
        sendJson(
          res,
          { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: `节点资源 ${rest} 不支持 ${req.method}（修改请用 POST）` } },
          405
        );
        return;
      }

      // ==================== REST: Component Schemas（查询） ====================

      if (pathname === '/__editor/component-schemas' && req.method === 'GET') {
        return runEditorAction(res, async () => {
          const nodeName = url.searchParams.get('nodeName');
          const nodeFile = url.searchParams.get('nodeFile');
          if (!nodeName || !nodeFile) {
            throw new EditorError('MISSING_FIELDS', '缺少查询参数 nodeName 或 nodeFile', 400);
          }
          const fileRel = nodeFile.replace(/^\.?\//, '');
          const compText = readProjectFile(ctx, fileRel);
          return componentSchema(compText, fileRel, nodeName, ctx);
        });
      }

      // ==================== REST: Clipboard ====================

      if (pathname === '/__editor/clipboard' && req.method === 'GET') {
        return runEditorAction(res, async () => ({
          has: !!clipboard,
          file: clipboard?.file ?? null,
          tag: clipboard?.tag ?? null,
        }));
      }
      if (pathname === '/__editor/clipboard' && req.method === 'POST') {
        return runEditorAction(res, async () => {
          const body = (await getJsonBody(req)) ?? {};
          if (!body.nodeId) throw new EditorError('MISSING_FIELDS', '缺少 nodeId', 400);
          const rel = inferPageFromNode(String(body.nodeId));
          const { rel: file, text } = pageText(rel);
          const copy = copyNodeSubtree(file, text, String(body.nodeId), ctx);
          clipboard = copy;
          return { nodeId: copy.nodeId, file: copy.file, tag: copy.tag, source: copy.source };
        });
      }
      if (pathname === '/__editor/clipboard/apply' && req.method === 'POST') {
        return runEditorAction(res, async () => {
          const body = (await getJsonBody(req)) ?? {};
          if (!clipboard) throw new EditorError('NO_CLIPBOARD', '剪贴板为空：请先复制节点（POST /__editor/clipboard）', 404);
          const { rel: file, text } = pageText(body.page || clipboard.file);
          const result = pasteNodeSubtree(
            file,
            text,
            body.parentNodeId || undefined,
            clipboard.element,
            clipboard.file,
            ctx,
            history
          );
          scanner.scanAll();
          return result;
        });
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

function listPages(ctx: ResolveContext, pagesDir: string): Array<{ name: string; path: string }> {
  const rootAbs = path.resolve(ctx.rootDir, pagesDir);
  const out: Array<{ name: string; path: string }> = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(full, rel ? `${rel}/${entry.name}` : entry.name);
      } else if (/\.(tsx|jsx)$/.test(entry.name)) {
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        out.push({ name: relName.replace(/\.(tsx|jsx)$/, ''), path: full });
      }
    }
  };
  if (fs.existsSync(rootAbs)) walk(rootAbs, '');
  return out;
}

function createPageFile(ctx: ResolveContext, pagesDir: string, pageName: string, template?: string): string {
  let rel = String(pageName).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
  if (!rel.startsWith(pagesDir + '/')) rel = pagesDir + '/' + rel;
  if (rel.includes('..')) throw new EditorError('INVALID_PAGE', `非法的页面路径：${pageName}`, 400);
  const abs = path.resolve(ctx.rootDir, rel);
  const finalPath = /\.(tsx|jsx)$/.test(abs) ? abs : `${abs}.tsx`;
  if (fs.existsSync(finalPath)) {
    throw new EditorError('PAGE_EXISTS', `页面已存在：${pageName}`, 409);
  }
  const base = (path.basename(finalPath).replace(/\.(tsx|jsx)$/, '') || 'Page').replace(/[^A-Za-z0-9_$]/g, '') || 'Page';
  const content =
    template ??
    `import React from 'react';

export default function ${base.charAt(0).toUpperCase() + base.slice(1)}() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">${pageName}</h1>
      <p>Start editing to see magic happen!</p>
    </div>
  );
}
`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, content, 'utf8');
  return path.relative(ctx.rootDir, finalPath).split(path.sep).join('/');
}

function deletePageFile(ctx: ResolveContext, pagesDir: string, rel: string): void {
  const abs = path.resolve(ctx.rootDir, rel);
  const pagesAbs = path.resolve(ctx.rootDir, pagesDir);
  if (abs !== pagesAbs && !abs.startsWith(pagesAbs + path.sep)) {
    throw new EditorError('INVALID_PAGE', `只能删除 ${pagesDir}/ 下的页面：${rel}`, 400);
  }
  try {
    fs.unlinkSync(abs);
  } catch (error: any) {
    throw new EditorError('FILE_DELETE_ERROR', `删除页面失败：${error?.message ?? error}`, 500);
  }
}

/** 从 node-id 推断所属页面文件 */
function inferPageFromNode(nodeId: string): string {
  const span = decodeNodeId(nodeId);
  if (!span) throw new EditorError('INVALID_NODE_ID', `node-id 无法解码：${nodeId}`, 400);
  return span.file;
}

export function createExpressServer(
  scanner: ComponentScanner,
  viteServer: ViteDevServer,
  editorCtx: EditorApiContext
) {
  // 返回兼容 Connect 的中间件函数
  return createApiHandler(scanner, viteServer, editorCtx);
}
