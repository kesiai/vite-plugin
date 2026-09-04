import { Plugin } from 'vite';
import { kesiPlugin } from './plugin';
import type { PluginOptions } from './types';

export * from './types';
export * from './plugin';
export * from './componentScanner';
export * from './nodeId';

export default kesiPlugin;
export { kesiPlugin };

/**
 * Vite 插件入口函数
 */
export function kesi(options?: PluginOptions): Plugin {
  return kesiPlugin(options);
}
