import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import kesi from '@kesi/vite-plugin';

// @kesi/vite-plugin demo
// - 插件编译期给 pages/ 下的 JSX 注入 data-node-id（可溯源定位标记）
// - 并挂载 /__editor/* HTTP API
// - Tailwind CSS v4（@tailwindcss/vite）
// - shadcn/ui 路径别名：@/* -> ./src/*
export default defineConfig({
  plugins: [
    kesi({
      enableNodeIds: true,
      pagesDir: 'pages',
    }),
    tailwindcss(),
  ],
  esbuild: {
    jsx: 'automatic',
  },
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
