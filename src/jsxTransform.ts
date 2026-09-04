import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import t from '@babel/types';

/**
 * 方案1：使用Babel AST转换在JSX元素上添加data-code属性
 * 这是推荐的方式，因为它：
 * - 不修改React的jsx运行时
 * - 在编译时完成，零运行时开销
 * - 精确控制哪些元素添加属性
 */

export function transformJSXWithAttributes(
  code: string,
  filePath: string
): { code: string; map?: any } {
  try {
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    const relativePath = filePath
      .replace(process.cwd(), '')
      .replace(/^\//, '');

    // 存储组件定义信息
    const componentStack: Array<{ name: string; line: number }> = [];
    let nodeIdCounter = 0;

    traverse.default(ast, {
      // 识别组件定义
      // FunctionDeclaration(path) {
      //   console.log(`[vite-plugin-airiot] Visiting FunctionDeclaration at ${relativePath}:${path.node.loc?.start.line}`);
      //   if (isReactComponent(path.node)) {
      //     const name = path.node.id?.name;
      //     if (name) {
      //       componentStack.push({
      //         name,
      //         line: path.node.loc?.start.line || 1,
      //       });
      //     }
      //   }
      // },

      // VariableDeclarator(path) {
      //   if (
      //     t.isIdentifier(path.node.id) &&
      //     (t.isArrowFunctionExpression(path.node.init) ||
      //       t.isFunctionExpression(path.node.init))
      //   ) {
      //     const name = path.node.id.name;
      //     if (/^[A-Z]/.test(name)) {
      //       componentStack.push({
      //         name,
      //         line: path.node.loc?.start.line || 1,
      //       });
      //     }
      //   }
      // },

      // // 在JSX元素上添加data-code属性
      // JSXElement(path) {
      //   console.log(`[vite-plugin-airiot] Visiting JSXElement at ${relativePath}:${path.node.loc?.start.line}`);
      //   // 只处理最外层的JSX元素（组件的根元素）
      //   // 检查父元素是否是JSX，如果不是，说明这是根元素
      //   let isRoot = true;
      //   let parent: typeof path.parentPath | null = path.parentPath;
      //   while (parent) {
      //     if (parent.isJSX()) {
      //       isRoot = false;
      //       break;
      //     }
      //     parent = parent.parentPath;
      //   }

      //   if (!isRoot) return;

      //   // 获取最近的组件信息
      //   const currentComponent = componentStack[componentStack.length - 1];
      //   if (!currentComponent) return;

      //   const dataCodeValue = `${relativePath}:${currentComponent.line}`;

      //   const openingElement = path.node.openingElement;
      //   const id = `node-${nodeIdCounter++}`;
      //   const name = openingElement.name.name || "Unknown";

      //   // Inject data-node-id for visual selection
      //   openingElement.attributes.push(
      //     t.jsxAttribute(
      //       t.jsxIdentifier("data-node-id"),
      //       t.stringLiteral(id)
      //     )
      //   );

      //   // 检查是否已有data-code属性
      //   const hasDataCode = openingElement.attributes.some((attr) =>
      //     t.isJSXAttribute(attr) &&
      //     t.isJSXIdentifier(attr.name) &&
      //     attr.name.name === 'data-code'
      //   );

      //   console.log(`[vite-plugin-airiot] Transforming component ${currentComponent.name} in ${relativePath}, hasDataCode: ${hasDataCode}`);

      //   if (!hasDataCode) {
      //     // 添加data-code属性
      //     openingElement.attributes.push(
      //       t.jsxAttribute(
      //         t.jsxIdentifier('data-code'),
      //         t.stringLiteral(dataCodeValue)
      //       )
      //     );
      //   }
      // },
      JSXOpeningElement(path) {
        const openingElement = path.node;
        const id = `node-${nodeIdCounter++}`;
        // const name = openingElement.name.name || "Unknown";

        // Inject data-node-id for visual selection
        openingElement.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-node-id"),
            t.stringLiteral(id)
          )
        );
      }
    });

    // 生成代码
    const output = generate.default(
      ast,
      {
        retainLines: true,
        comments: true,
      },
      code
    );

    return {
      code: output.code,
    };
  } catch (error) {
    // 如果解析失败，返回原代码
    console.error('Error transforming JSX:', error);
    return { code };
  }
}

/**
 * 判断是否是React组件
 */
function isReactComponent(node: any): boolean {
  if (!node || !node.id) return false;
  const name = node.id.name;
  return /^[A-Z]/.test(name);
}

/**
 * 方案2：创建自定义jsx runtime（备选方案）
 * 如果需要运行时动态添加，可以使用这个方案
 *
 * 使用方法：
 * 1. 创建 src/jsx-runtime.ts
 * 2. 在vite.config.ts中配置resolve.alias
 */

export const jsxRuntimeCode = `
import { jsx as jsxRuntime, jsxs as jsxsRuntime, Fragment } from 'react/jsx-runtime';

// 用于存储当前组件上下文
const componentContext = new WeakMap();

function withDataCode(type, props, key) {
  const currentComponent = getCurrentComponent();

  if (currentComponent && props && !props['data-code']) {
    // 添加data-code属性
    props = { ...props, 'data-code': currentComponent.dataCode };
  }

  return jsxRuntime(type, props, key);
}

function getCurrentComponent() {
  // 通过Error.stack获取调用栈信息
  const stack = new Error().stack;
  if (!stack) return null;

  // 解析栈信息获取组件位置
  const lines = stack.split('\\n');
  for (const line of lines) {
    if (line.includes('.tsx') || line.includes('.jsx')) {
      const match = line.match(/(?:at |@)([^\\s]+):(\\d+):(\\d+)/);
      if (match) {
        return {
          dataCode: \`\${match[1]}:\${match[2]}\`
        };
      }
    }
  }

  return null;
}

export const jsx = withDataCode;
export const jsxs = withDataCode;
export { Fragment };
`;

/**
 * 方案3：Vite配置别名来使用自定义runtime
 */
export const viteAliasConfig = `
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import airiot from 'vite-plugin-airiot';

export default defineConfig({
  resolve: {
    alias: {
      // 使用自定义jsx runtime（仅在开发模式）
      ...(process.env.NODE_ENV === 'development' ? {
        'react/jsx-runtime': '/src/jsx-runtime.ts',
        'react/jsx-dev-runtime': '/src/jsx-runtime.ts',
      } : {}),
    },
  },
  plugins: [
    react(),
    airiot(),
  ],
});
`;

/**
 * 推荐方案：使用Babel插件
 *
 * 优点：
 * 1. 编译时完成，零运行时开销
 * 2. 精确控制，不修改React源码
 * 3. 可以只处理特定文件/组件
 * 4. 支持source map
 *
 * 实现见上面的 transformJSXWithAttributes 函数
 */
