export interface PluginOptions {
  /**
   * 是否启用 data-code 属性添加
   * @default true
   */
  enableDataCode?: boolean;

  /**
   * 是否启用组件展示路由
   * @default true
   */
  enableComponentRoutes?: boolean;

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

export interface ComponentInfo {
  path: string;
  lineNumber: number;
  dataCode: string;
}

export interface RouteInfo {
  path: string;
  component: string;
  filePath: string;
}

export interface AirlotConfig {
  routes?: RouteInfo[];
}
