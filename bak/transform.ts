import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import t from '@babel/types';

export interface TransformResult {
  code: string;
  components: ComponentInfo[];
}

export interface ComponentInfo {
  name: string;
  line: number;
  dataCode: string;
}

/**
 * 为React组件添加data-code属性
 */
export function transformComponentCode(
  code: string,
  filePath: string
): TransformResult {
  const components: ComponentInfo[] = [];

  try {
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    // 计算相对路径
    const relativePath = filePath
      .replace(process.cwd(), '')
      .replace(/^\//, '');

    traverse(ast, {
      // 处理函数声明组件
      FunctionDeclaration(path) {
        if (isReactComponent(path.node)) {
          const componentName = path.node.id?.name || 'Unknown';
          const lineNumber = path.node.loc?.start.line || 1;
          const dataCode = `${relativePath}:${lineNumber}`;

          components.push({
            name: componentName,
            line: lineNumber,
            dataCode,
          });

          // 在函数体的开始添加 data-code 注释（用于调试）
          // 实际的 data-code 属性会在 JSX 元素上添加
        }
      },

      // 处理箭头函数组件
      VariableDeclarator(path) {
        if (
          t.isIdentifier(path.node.id) &&
          t.isArrowFunctionExpression(path.node.init) ||
          t.isFunctionExpression(path.node.init)
        ) {
          const componentName = path.node.id.name;
          // 检查是否是组件名（首字母大写）
          if (/^[A-Z]/.test(componentName)) {
            const lineNumber = path.node.loc?.start.line || 1;
            const dataCode = `${relativePath}:${lineNumber}`;

            components.push({
              name: componentName,
              line: lineNumber,
              dataCode,
            });
          }
        }
      },

      // 处理JSX元素 - 添加 data-code 属性
      JSXElement(path) {
        // 只处理根级JSX元素或者在函数组件内的JSX元素
        const openingElement = path.node.openingElement;

        // 检查是否已经有 data-code 属性
        const hasDataCode = openingElement.attributes.some(attr =>
          t.isJSXAttribute(attr) &&
          t.isJSXIdentifier(attr.name) &&
          attr.name.name === 'data-code'
        );

        if (!hasDataCode && isComponentJSX(path.node)) {
          // 找到最近的组件定义
          const componentDataCode = findComponentDataCode(path);
          if (componentDataCode) {
            // 添加 data-code 属性
            openingElement.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier('data-code'),
                t.stringLiteral(componentDataCode)
              )
            );
          }
        }
      },
    });

    return {
      code,
      components,
    };
  } catch (error) {
    // 如果解析失败，返回原代码
    return {
      code,
      components: [],
    };
  }
}

/**
 * 判断是否是React组件
 */
function isReactComponent(node: t.Function | t.FunctionDeclaration): boolean {
  if (!node.id) return false;
  const name = node.id.name;
  // React组件通常以大写字母开头
  return /^[A-Z]/.test(name);
}

/**
 * 判断JSX元素是否是组件（而不是HTML元素）
 */
function isComponentJSX(node: t.JSXElement): boolean {
  const tagName = node.openingElement.name;
  if (t.isJSXIdentifier(tagName)) {
    // 组件名以大写字母开头
    return /^[A-Z]/.test(tagName.name);
  }
  return true;
}

/**
 * 向上查找组件的 data-code 信息
 */
function findComponentDataCode(path: any): string | null {
  let currentPath = path;
  while (currentPath) {
    // 查找父级函数声明或变量声明
    if (currentPath.parentPath) {
      const parent = currentPath.parentPath;

      if (
        t.isFunctionDeclaration(parent.node) ||
        (t.isVariableDeclarator(parent.node) &&
          t.isIdentifier(parent.node.id))
      ) {
        // 找到组件定义，生成 data-code
        const nodeName = t.isFunctionDeclaration(parent.node)
          ? parent.node.id?.name
          : parent.node.id?.name;

        if (nodeName && /^[A-Z]/.test(nodeName)) {
          const line = parent.node.loc?.start.line || 1;
          // 这里需要从外部获取文件路径信息
          return null; // 将在插件上下文中处理
        }
      }
    }
    currentPath = currentPath.parentPath;
  }
  return null;
}
