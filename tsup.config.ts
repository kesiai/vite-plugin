import { defineConfig } from 'tsup';

// 说明：d.ts 不再由 tsup（rollup-plugin-dts）生成 —— 该引擎只兼容 TypeScript 5.x，
// 与本项目使用的 TypeScript 7 冲突。声明文件改由 `npm run build` 里的
// `tsc --emitDeclarationOnly` 产出（见 package.json scripts.build）。
export default defineConfig([
  // Node.js 端 Vite 插件
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: true,  // 第一个构建清理 dist
    sourcemap: false,
    shims: true,
    bundle: true,
  },
  // 浏览器端 Canvas 组件
  {
    entry: ['src/Canvas.tsx'],
    format: ['esm'],
    dts: false,
    clean: false,  // 不清理，保留第一个构建的输出
    sourcemap: false,
    shims: false,
    bundle: false,  // 不打包依赖，让使用方提供 React
  },
]);
