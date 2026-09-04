import fs from 'fs';
import path from 'path';

export interface ComponentData {
  name: string;
  filePath: string;
  relativePath: string;
  lineNumber: number;
  dataCode: string;
  displayName: string;
}

export interface ScanResult {
  components: ComponentData[];
  pageComponents: ComponentData[];
}

/**
 * 扫描项目中的React组件
 */
export class ComponentScanner {
  private root: string;
  private pagesDir: string;
  private componentsDir: string;
  private componentsCache: Map<string, ComponentData[]> = new Map();
  private pageComponentsCache: ComponentData[] = [];

  constructor(
    root: string,
    pagesDir: string = 'pages',
    componentsDir: string = 'components'
  ) {
    this.root = root;
    this.pagesDir = pagesDir;
    this.componentsDir = componentsDir;
  }

  /**
   * 扫描所有组件
   */
  scanAll(): ScanResult {
    this.componentsCache.clear();
    this.pageComponentsCache = [];

    this.scanDirectory(this.root);

    return {
      components: Array.from(this.componentsCache.values()).flat(),
      pageComponents: this.pageComponentsCache,
    };
  }

  /**
   * 递归扫描目录
   */
  private scanDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过node_modules、隐藏目录和dist目录
        if (entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name === 'build' ||
            entry.name.startsWith('.')) {
          continue;
        }

        // 递归扫描所有子目录
        this.scanDirectory(fullPath);
      } else if (entry.isFile()) {
        // 处理jsx/tsx文件
        if (/\.(jsx|tsx)$/.test(entry.name)) {
          this.scanFile(fullPath);
        }
      }
    }
  }

  /**
   * 扫描单个文件
   */
  private scanFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(this.root, filePath);
      const components = this.extractComponents(content, filePath, relativePath);

      // 检查文件是否在pages目录中
      const isInPages = relativePath.startsWith(`${this.pagesDir}/`) || relativePath.startsWith(`${this.pagesDir}\\`);

      if (isInPages) {
        const pageName = path.basename(filePath, path.extname(filePath));
        const firstComponent = components[0];
        this.pageComponentsCache.push({
          name: pageName,
          filePath,
          relativePath,
          lineNumber: firstComponent?.lineNumber ?? 1,
          dataCode: firstComponent?.dataCode ?? `${relativePath}:1`,
          displayName: pageName,
        });
      }

      this.componentsCache.set(filePath, components);
    } catch (error) {
      console.error(`Error scanning file ${filePath}:`, error);
    }
  }

  /**
   * 从文件内容中提取组件信息
   */
  private extractComponents(
    content: string,
    filePath: string,
    relativePath: string
  ): ComponentData[] {
    const components: ComponentData[] = [];
    const lines = content.split('\n');

    // 正则表达式匹配React组件定义
    // 1. function ComponentName() {}
    // 2. const ComponentName = () => {}
    // 3. const ComponentName = function() {}
    // 4. export function ComponentName() {}
    // 5. export const ComponentName = ...

    const patterns = [
      // function declaration
      /^\s*(?:export\s+(?:default\s+)?function|function)\s+([A-Z][a-zA-Z0-9_]*)/,
      // arrow function or function expression
      /^\s*(?:export\s+(?:default\s+)?)?const\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function)/,
      // React.forwardRef
      /^\s*(?:export\s+(?:default\s+)?)?const\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*React\.forwardRef/,
    ];

    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const componentName = match[1];
          const lineNumber = index + 1;
          const dataCode = `${relativePath}:${lineNumber}`;

          components.push({
            name: componentName,
            filePath,
            relativePath,
            lineNumber,
            dataCode,
            displayName: componentName,
          });
          break; // 只匹配第一个成功的pattern
        }
      }
    });

    return components;
  }

  /**
   * 获取所有组件
   */
  getComponents(): ComponentData[] {
    return Array.from(this.componentsCache.values()).flat();
  }

  /**
   * 获取pages和blocks目录下的组件
   */
  getPageComponents(): ComponentData[] {
    return this.pageComponentsCache;
  }

  /**
   * 获取组件的展示路由路径
   */
  getComponentRoute(component: ComponentData): string {
    // 将文件路径转换为路由路径
    // 例如: pages/dashboard/Dashboard.tsx -> /kesi/components/dashboard/Dashboard
    const routePath = component.relativePath
      .replace(/\.(jsx|tsx)$/, '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(segment => segment !== this.pagesDir && segment !== this.componentsDir)
      .join('/');

    return `/kesi/components/${routePath}`;
  }

  /**
   * 清除扫描缓存
   * 在文件创建、删除或修改后调用
   */
  clearCache(): void {
    this.componentsCache.clear();
    this.pageComponentsCache = [];
  }

  /**
   * 重新扫描（清除缓存后重新扫描）
   */
  rescan(): ScanResult {
    this.clearCache();
    return this.scanAll();
  }
}
