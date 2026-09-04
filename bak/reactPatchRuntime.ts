import React from 'react';

/**
 * React运行时Patch - 在运行时为React组件添加data-code属性
 *
 * 工作原理：
 * 1. 保存原始的React.createElement
 * 2. 重写createElement，在每次创建元素时检查调用栈
 * 3. 从调用栈中提取组件文件和行号信息
 * 4. 为组件的根元素添加data-code属性
 */

// 保存原始方法
const originalCreateElement = React.createElement;

// 缓存已知的组件信息（避免重复解析栈）
const componentInfoCache = new WeakMap<Function, { dataCode: string }>();

/**
 * 从调用栈解析组件信息
 */
function parseComponentInfo(): { dataCode: string; componentName?: string } | null {
  const stack = new Error().stack;
  if (!stack) return null;

  const lines = stack.split('\n');

  for (const line of lines) {
    // 匹配模式：at FunctionName (/path/to/file.tsx:line:column)
    // 或：at FunctionName (/path/to/file.tsx:line)
    const match = line.match(/at\s+(\w+)\s+\(([^:]+):(\d+):(\d+)\)/);
    if (match) {
      const [, componentName, filePath, line] = match;
      return {
        dataCode: `${filePath}:${line}`,
        componentName,
      };
    }

    // 简化版匹配（某些情况可能没有column）
    const simpleMatch = line.match(/at\s+(\w+)\s+\(([^:]+):(\d+)\)/);
    if (simpleMatch) {
      const [, componentName, filePath, line] = simpleMatch;
      return {
        dataCode: `${filePath}:${line}`,
        componentName,
      };
    }
  }

  return null;
}

/**
 * Patch后的createElement
 */
function patchedCreateElement(
  type: any,
  props: any,
  ...children: any[]
): React.ReactElement {
  // 只处理React组件（函数或类组件）
  const isReactComponent =
    typeof type === 'function' ||
    (typeof type === 'object' &&
      type !== null &&
      typeof type.$$typeof === 'symbol');

  if (isReactComponent && props) {
    // 尝试从缓存获取组件信息
    let componentInfo = componentInfoCache.get(type);

    if (!componentInfo) {
      // 从调用栈解析组件信息
      const info = parseComponentInfo();
      if (info) {
        componentInfo = info;
        componentInfoCache.set(type, componentInfo);
      }
    }

    // 如果有组件信息且没有data-code属性，添加它
    if (componentInfo && !props['data-code']) {
      // 创建新的props对象，添加data-code
      props = { ...props, 'data-code': componentInfo.dataCode };
    }
  }

  // 调用原始方法
  return originalCreateElement.call(React, type, props, ...children);
}

/**
 * 应用React Patch
 */
export function applyReactPatch() {
  if (typeof React.createElement === 'function') {
    // 保存原始方法（如果还没保存）
    if ((React.createElement as any).__original === undefined) {
      (React.createElement as any).__original = originalCreateElement;
    }

    // 应用patch
    React.createElement = patchedCreateElement as any;

    console.log('[vite-plugin-airiot] React patch applied');
  }
}

/**
 * 移除React Patch
 */
export function removeReactPatch() {
  if ((React.createElement as any).__original) {
    React.createElement = (React.createElement as any).__original;
    console.log('[vite-plugin-airiot] React patch removed');
  }
}

/**
 * 获取当前patch状态
 */
export function isPatched(): boolean {
  return (React.createElement as any).__original !== undefined;
}
