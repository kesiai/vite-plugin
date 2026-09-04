/**
 * 运行时React Patch代码生成器
 *
 * 这个模块生成运行时代码，用于在浏览器中patch React
 */

export function generateReactPatchCode(): string {
  return `
(function() {
  'use strict';

  console.log('[vite-plugin-airiot] Initializing React patch...');

  // 查找React对象
  const react = window.React || window.__REACT__ || window.require?.('react');

  if (!react) {
    console.warn('[vite-plugin-airiot] React not found, patching skipped');
    return;
  }

  const originalCreateElement = react.createElement;

  if (!originalCreateElement || typeof originalCreateElement !== 'function') {
    console.warn('[vite-plugin-airiot] createElement not found, patching skipped');
    return;
  }

  // 保存原始方法
  if (!originalCreateElement.__original) {
    originalCreateElement.__original = originalCreateElement.bind(react);
  }

  // 组件信息缓存
  const componentCache = new WeakMap();

  /**
   * 从调用栈提取组件信息
   */
  function extractComponentInfo() {
    const stack = new Error().stack;
    if (!stack) return null;

    const lines = stack.split('\\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 匹配：at Dashboard (/src/pages/Dashboard.tsx:10:15)
      const match = line.match(/at\\s+(?:export\\s+)?:\\(?:(\\w+)\\s+)?\\)?(?:async\\s+)?([^\\s(]+)\\s+\\(([^:]+):(\\d+):(\\d+)\\)/);

      if (match) {
        const [, fnName, filePath, line, col] = match;

        // 过滤掉内部调用
        if (filePath.includes('node_modules') || filePath.includes('runtime')) {
          continue;
        }

        // 只处理.tsx或.jsx文件
        if (/\\.(tsx|jsx)$/.test(filePath)) {
          return {
            filePath: filePath.replace(/^\\//, ''),
            line: parseInt(line, 10),
            column: parseInt(col, 10),
            functionName: fnName || '(anonymous)'
          };
        }
      }
    }

    return null;
  }

  /**
   * 判断是否是React组件
   */
  function isReactComponent(type) {
    if (typeof type === 'function') {
      return /^[_A-Z]/.test(type.name || '');
    }
    if (typeof type === 'object' && type !== null) {
      const $$typeof = type.$$typeof;
      return $$typeof === 0xeac7 || $$typeof === 0xeac8 || $$typeof === 0xeaa1;
    }
    return false;
  }

  /**
   * Patched createElement
   */
  function patchedCreateElement(type, props, ...children) {
    // 只处理React组件
    if (isReactComponent(type) && props && typeof props === 'object') {
      let info = componentCache.get(type);

      if (!info) {
        info = extractComponentInfo();
        if (info) {
          componentCache.set(type, info);
        }
      }

      // 添加data-code属性
      if (info && !props['data-code']) {
        props = {
          ...props,
          'data-code': \`\${info.filePath}:\${info.line}\`
        };
      }
    }

    return originalCreateElement.call(react, type, props, ...children);
  }

  // 应用patch
  react.createElement = patchedCreateElement;
  console.log('[vite-plugin-airiot] React patch applied successfully');

  // 导出供外部使用
  window.__AIRIOT_REACT_PATCH__ = {
    applied: true,
    remove: function() {
      if (originalCreateElement.__original) {
        react.createElement = originalCreateElement.__original;
        console.log('[vite-plugin-airiot] React patch removed');
      }
    },
    isPatched: function() {
      return react.createElement !== originalCreateElement;
    }
  };
})();
`;
}

/**
 * 生成客户端入口脚本
 */
export function generateClientEntryCode(): string {
  return `
import { applyReactPatch } from '/@vite-plugin-airiot/reactPatchRuntime';

// 在应用启动时应用patch
applyReactPatch();

console.log('[vite-plugin-airiot] React patch initialized');
`;
}

/**
 * 生成HTML注入代码
 */
export function generateHtmlInjectScript(): string {
  return `
<script type="module">
${generateReactPatchCode()}
</script>
`;
}
