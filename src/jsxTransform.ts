import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import t from '@babel/types';
import { encodeNodeId } from './nodeId';

// @babel/* 为 CJS 模块，不同打包器对默认导入的互操作不一致（有的注入 __esModule，
// 有的不注入），这里统一做一次安全取值：优先取 .default，否则取模块自身。
type TraverseFn = typeof traverseModule;
type GenerateFn = typeof generateModule;
const traverse: TraverseFn = (() => {
  const m = traverseModule as unknown as { default?: TraverseFn };
  return m.default ?? traverseModule;
})();
const generate: GenerateFn = (() => {
  const m = generateModule as unknown as { default?: GenerateFn };
  return m.default ?? generateModule;
})();

/**
 * 编译期 JSX 转换：为每个 JSX 元素的开标签注入 data-node-id。
 *
 * data-node-id 采用可溯源定位格式（见 nodeId.ts）：
 *   data-node-id = "node-" + base64url({file, startLine, startCol, endLine, endCol})
 *
 * 其中 end 位置为结束标签 "</tag>" 的起始位置（自闭合元素为该标签自身的结束位置），
 * 解码后即可在源码中精确定位该元素的标签跨度，供后续工具修改代码与属性。
 *
 * 优点：
 * - 编译时完成，零运行时开销
 * - 不修改 React jsx runtime
 * - 生成的是真实 DOM 属性，可被 querySelector / dataset 访问
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

    traverse(ast, {
      JSXElement(path) {
        const openingElement = path.node.openingElement;
        if (!openingElement.loc?.start) return;

        // 已被注入过（如对同一 AST 重复转换）则跳过
        const hasNodeId = openingElement.attributes.some(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            attr.name.name === 'data-node-id'
        );
        if (hasNodeId) return;

        // 结束位置：优先取结束标签 "</tag>" 的起始位置；
        // 自闭合元素（<tag />）没有结束标签，取开标签自身的结束位置。
        const start = openingElement.loc.start;
        const end =
          path.node.closingElement?.loc?.start ?? openingElement.loc.end;
        if (!end) return;

        const id = encodeNodeId(filePath, start, end);

        openingElement.attributes.push(
          t.jsxAttribute(t.jsxIdentifier('data-node-id'), t.stringLiteral(id))
        );
      },
    });

    const output = generate(
      ast,
      {
        retainLines: true,
        comments: true,
      },
      code
    );

    return { code: output.code };
  } catch (error) {
    // 如果解析/转换失败，返回原代码，避免阻断构建
    console.error('[@kesi/vite-plugin] Error transforming JSX:', error);
    return { code };
  }
}
