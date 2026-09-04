import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js 端 Vite 插件
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,  // 第一个构建清理 dist
    sourcemap: false,
    shims: true,
    bundle: true,
  },
  // 浏览器端 Canvas 组件
  {
    entry: ['src/Canvas.tsx'],
    format: ['esm'],
    dts: true,
    clean: false,  // 不清理，保留第一个构建的输出
    sourcemap: false,
    shims: false,
    bundle: false,  // 不打包依赖，让使用方提供 React
  },
]);
