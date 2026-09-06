import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import kesi from '@kesi/vite-plugin';

// @kesi/vite-plugin demo
// - 编译期给 pages/ 的 JSX 注入 data-node-id；并挂载 /__editor/* API
// - @vitejs/plugin-react：提供 automatic JSX 与 **fast refresh**——改任意 .tsx 只热更
//   对应组件并保留状态，不再整页 reload（不需要手动 import.meta.hot.accept）
// - Tailwind CSS v4（@tailwindcss/vite）；别名 @/* -> ./src/*
export default defineConfig({
  plugins: [
    kesi({
      enableNodeIds: true,
      pagesDir: 'pages',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: process.env.EDITOR_PROXY_BASE || '/',
  server: {
    port: 5199,
    strictPort: true,
  },
});
