import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * ============================================================
 * 外层编辑器宿主 —— vite 配置（把“目标页面 + 插件 API”同源化）
 * ============================================================
 * 目标 vite dev server 默认运行在 http://127.0.0.1:5173
 * （可按需用环境变量覆盖：TARGET_DEV_URL）
 *
 * 同源化 URL 设计：
 *   iframe/页面  : http://localhost:3000/rest/apps/dev/{pageRouter}
 *                 例：/rest/apps/dev/dashboard/Dashboard?kesi_editor=1
 *   API          : http://localhost:3000/rest/apps/editor/{path}
 *                 例：/rest/apps/editor/node/node-xxx         （= /__editor/node/node-xxx）
 * 这样外层页面 / iframe / API 全部同源（localhost:3000），不再有跨域问题；
 * 也无需 CORS，iframe 内 editor-client 也能直接用相对路径调用 API。
 *
 * 注意（重要）：
 *  1) 页面 HTML 内部资源（/src/...、/@vite/...）是“绝对路径”。
 *     要让这些资源也走同源代理，二选一：
 *       A. 目标 dev server 以 base='/rest/apps/dev/' 启动（推荐，见下）
 *          此时 HTML 资源本身就是 /rest/apps/dev/...，代理只需“透传”。
 *       B. 仅 rewrite 页面入口，资源路径需另做 HTML 改写（vite server.proxy
 *          不支持改写响应体，需要自写 connect 中间件），复杂度高。
 *  2) HMR WebSocket：目标以 base=A 启动时，vite client 的 ws 地址含 base，
 *     走同前缀代理（ws:true 且不 rewrite）可正常热更；
 *     若采用“入口 rewrite、资源另配”的方式，HMR 基本不可用——编辑器应在
 *     每次写盘后主动 iframe.reload() 刷新（见集成指南 §4.7）。
 * ============================================================
 */

const TARGET = process.env.TARGET_DEV_URL || 'http://127.0.0.1:5173';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // ---- 方式 A（推荐）：目标 dev server 以 base='/rest/apps/dev/' 启动 ----
      // 目标端 vite.config: base: process.env.EDITOR_PROXY_BASE || '/'
      //   启动目标: EDITOR_PROXY_BASE=/rest/apps/dev/ vite
      // 本代理纯透传（不 rewrite），页面与资源、HMR ws 都工作。
      '/rest/apps/dev': {
        target: TARGET,
        changeOrigin: true,
        ws: true,
        // 透传：请求 /rest/apps/dev/dashboard/Dashboard -> 目标同样路径
      },

      // ---- 方式 B（兜底）：目标 base='/'，仅把页面入口 rewrite 过去 ----
      // 用不到时可以整段删除；资源/HMR 限制见文件头注释。
      // '/rest/apps/dev': {
      //   target: TARGET,
      //   changeOrigin: true,
      //   rewrite: (p) => p.replace(/^\/rest\/apps\/dev/, ''),
      // },

      // ---- 插件 API：/rest/apps/editor/{...} -> /__editor/{...} ----
      '/rest/apps/editor': {
        target: TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rest\/apps\/editor/, '/__editor'),
      },
    },
  },
});
