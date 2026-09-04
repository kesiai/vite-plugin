import React from 'react';
import { Cell } from './Cell';

/**
 * React Patcher - 类似 Vite React Fast Refresh 的实现
 *
 * 工作原理：
 * 1. 拦截 React.createElement 调用
 * 2. 检测组件是否有 data-node-id 属性
 * 3. 自动包裹 Cell 组件以支持属性热更新
 */

// 保存原始的 createElement
const originalCreateElement = React.createElement;

// 组件签名缓存，用于识别组件类型
const componentSignatures = new WeakMap<Function, string>();

/**
 * 获取组件签名
 * 用于识别相同的组件类型
 */
function getComponentSignature(component: Function): string {
  if (componentSignatures.has(component)) {
    return componentSignatures.get(component)!;
  }

  // 使用函数名或 toString 作为签名
  const signature = component.name || component.toString().slice(0, 50);
  componentSignatures.set(component, signature);
  return signature;
}

/**
 * 包裹组件以支持热更新
 */
function wrapWithRefresh(
  type: any,
  props: any,
  ...children: any[]
): React.ReactElement {
  // 检查是否有 data-node-id 属性
  const nodeId = props?.['data-node-id'];

  if (nodeId) {
    // 使用原始 createElement 创建元素
    const element = originalCreateElement.call(React, type, props, ...children);

    // 包裹 Cell 组件
    return originalCreateElement.call(
      React,
      Cell,
      {
        nodeId,
        key: props?.key || nodeId,
      },
      element
    );
  }

  // 没有 data-node-id，直接返回原始元素
  return originalCreateElement.call(React, type, props, ...children);
}

/**
 * 创建一个被 patch 的 React 对象
 *
 * @param originalReact 原始的 React 对象
 * @returns 被 patch 的 React 对象
 */
export function createPatchedReact(originalReact: typeof React) {
  const patchedReact = { ...originalReact };

  // 复写 createElement
  patchedReact.createElement = function (type: any, props: any, ...children: any[]) {
    // 对于函数组件和类组件
    if (typeof type === 'function' || (typeof type === 'object' && type?.$$typeof)) {
      // 使用包裹的版本
      return wrapWithRefresh(type, props, ...children);
    }

    // 对于其他类型（如 div, span 等），检查是否需要包裹
    if (typeof type === 'string') {
      const nodeId = props?.['data-node-id'];
      if (nodeId) {
        const element = originalCreateElement.call(originalReact, type, props, ...children);
        return originalCreateElement.call(
          originalReact,
          Cell,
          {
            nodeId,
            key: props?.key || nodeId,
          },
          element
        );
      }
    }

    // 默认行为
    return originalCreateElement.call(originalReact, type, props, ...children);
  };

  return patchedReact;
}

/**
 * 重置 React patch（用于测试或清理）
 */
export function resetReactPatch() {
  // 在这个实现中，我们创建了一个新的 React 对象而不是修改全局的 React
  // 所以不需要重置逻辑
}

/**
 * 获取组件签名（用于调试）
 */
export function getSignature(component: Function): string {
  return getComponentSignature(component);
}
