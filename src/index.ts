import { Plugin } from 'vite';
import { airiotPlugin, PluginOptions } from './plugin';

export * from './types';
export * from './plugin';
export * from './componentScanner';

export default airiotPlugin;
export { airiotPlugin, PluginOptions };

/**
 * Vite插件入口函数
 */
export function airiot(options?: PluginOptions): Plugin {
  return airiotPlugin(options);
}
