export interface PluginOptions {
  /**
   * 是否在开发模式为 JSX 元素注入 data-node-id 定位标记
   * @default true
   */
  enableNodeIds?: boolean;

  /**
   * 项目根目录（绝对路径或相对于 process.cwd() 的相对路径）
   * @default process.cwd()
   */
  rootDir?: string;

  /**
   * 页面目录（相对于 rootDir）
   * @default 'pages'
   */
  pagesDir?: string;

  /**
   * 组件目录（相对于 rootDir），用于扫描可复用组件
   * @default 'components'
   */
  componentsDir?: string;
}
