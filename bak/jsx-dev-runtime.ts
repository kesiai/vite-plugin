/**
 * 自定义 JSX Development Runtime
 * 基于 React 官方 jsx-dev-runtime，添加 data-code 属性
 *
 * @license React
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 */

// React 内部类型常量
const REACT_ELEMENT_TYPE = Symbol.for('react.transitional.element');
const REACT_PORTAL_TYPE = Symbol.for('react.portal');
const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');
const REACT_STRICT_MODE_TYPE = Symbol.for('react.strict_mode');
const REACT_PROFILER_TYPE = Symbol.for('react.profiler');
const REACT_CONSUMER_TYPE = Symbol.for('react.consumer');
const REACT_CONTEXT_TYPE = Symbol.for('react.context');
const REACT_FORWARD_REF_TYPE = Symbol.for('react.forward_ref');
const REACT_SUSPENSE_TYPE = Symbol.for('react.suspense');
const REACT_SUSPENSE_LIST_TYPE = Symbol.for('react.suspense_list');
const REACT_MEMO_TYPE = Symbol.for('react.memo');
const REACT_LAZY_TYPE = Symbol.for('react.lazy');
const REACT_CLIENT_REFERENCE = Symbol.for('react.client.reference');
function isReactComponent(type: any): boolean {
  if (typeof type === 'function') {
    const name = type.displayName || type.name;
    return name && /^[A-Z]/.test(name);
  }
  if (typeof type === 'object' && type !== null) {
    const $$typeof = type.$$typeof;
    return $$typeof === REACT_MEMO_TYPE ||
           $$typeof === REACT_FORWARD_REF_TYPE;
  }
  return false;
}

/**
 * 从类型获取组件名称
 */
function getComponentNameFromType(type: any): string | null {
  if (type == null) return null;
  if (typeof type === 'function') {
    if ((type as any).$$typeof === REACT_CLIENT_REFERENCE) {
      return null;
    }
    return type.displayName || type.name || null;
  }
  if (typeof type === 'string') return type;

  switch (type) {
    case REACT_FRAGMENT_TYPE:
      return 'Fragment';
    case REACT_PROFILER_TYPE:
      return 'Profiler';
    case REACT_STRICT_MODE_TYPE:
      return 'StrictMode';
    case REACT_SUSPENSE_TYPE:
      return 'Suspense';
    case REACT_SUSPENSE_LIST_TYPE:
      return 'SuspenseList';
  }

  if (typeof type === 'object' && type !== null) {
    switch (type.$$typeof) {
      case REACT_PORTAL_TYPE:
        return 'Portal';
      case REACT_CONTEXT_TYPE:
        return type.displayName || 'Context';
      case REACT_CONSUMER_TYPE:
        return ((type as any)._context.displayName || 'Context') + '.Consumer';
      case REACT_FORWARD_REF_TYPE:
        const innerType = (type as any).render;
        let displayName = type.displayName;
        if (!displayName) {
          displayName = innerType.displayName || innerType.name || '';
          displayName = displayName !== '' ? `ForwardRef(${displayName})` : 'ForwardRef';
        }
        return displayName;
      case REACT_MEMO_TYPE:
        const memoDisplayName = type.displayName || null;
        return memoDisplayName !== null
          ? memoDisplayName
          : getComponentNameFromType((type as any).type) || 'Memo';
      case REACT_LAZY_TYPE:
        return '<...>';
    }
  }
  return null;
}

// ReactSharedInternals 是 React 内部变量，在我们的独立实现中不需要
// 如果未来需要集成 React DevTools，可以从 react 包导入
const ReactSharedInternals = (typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {}).__REACT_DEVTOOLS_GLOBAL_HOOK__?.SharedInternals || null;

let specialPropKeyWarningShown = false;
const didWarnAboutElementRef: Record<string, boolean> = {};
const didWarnAboutKeySpread: Record<string, boolean> = {};

function defineKeyPropWarningGetter(props: any, displayName: string): void {
  function warnAboutAccessingKey() {
    if (!specialPropKeyWarningShown) {
      specialPropKeyWarningShown = true;
      console.error(
        '%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)',
        displayName
      );
    }
  }
  warnAboutAccessingKey.isReactWarning = true;
  Object.defineProperty(props, 'key', {
    get: warnAboutAccessingKey,
    configurable: true
  });
}

function elementRefGetterWithDeprecationWarning(this: any): any {
  const componentName = getComponentNameFromType(this.type) as string;
  if (!didWarnAboutElementRef[componentName]) {
    didWarnAboutElementRef[componentName] = true;
    console.error(
      'Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release.'
    );
  }
  return this.props.ref !== undefined ? this.props.ref : null;
}

interface ReactElement {
  $$typeof: symbol;
  type: any;
  key: any;
  props: any;
  _owner: any;
  _store: any;
  _debugInfo: any;
  _debugStack: any;
  _debugTask: any;
}

function ReactElement(
  type: any,
  key: any,
  props: any,
  owner: any,
  debugStack: any,
  debugTask: any
): ReactElement {
  const refProp = props.ref;
  const element: any = {
    $$typeof: REACT_ELEMENT_TYPE,
    type: type,
    key: key,
    props: props,
    _owner: owner
  };

  // 为元素添加唯一 ID（用于追踪父子关系）
  element._airiotId = props['__airiot_id'];

  if (refProp !== undefined && refProp !== null) {
    Object.defineProperty(element, 'ref', {
      enumerable: false,
      get: elementRefGetterWithDeprecationWarning
    });
  } else {
    Object.defineProperty(element, 'ref', {
      enumerable: false,
      value: null
    });
  }

  element._store = {};
  Object.defineProperty(element._store, 'validated', {
    configurable: false,
    enumerable: false,
    writable: true,
    value: 0
  });

  Object.defineProperty(element, '_debugInfo', {
    configurable: false,
    enumerable: false,
    writable: true,
    value: null
  });

  Object.defineProperty(element, '_debugStack', {
    configurable: false,
    enumerable: false,
    writable: true,
    value: debugStack
  });

  Object.defineProperty(element, '_debugTask', {
    configurable: false,
    enumerable: false,
    writable: true,
    value: debugTask
  });

  if (Object.freeze) {
    Object.freeze(element.props);
    Object.freeze(element);
  }

  return element;
}

function validateChildKeys(node: any): void {
  if (node._store) {
    node._store.validated = 1;
  } else if (typeof node === 'object' && node !== null && node.$$typeof === REACT_LAZY_TYPE) {
    if (node._payload.status === 'fulfilled') {
      const fulfilledNode = node._payload.value;
      if (fulfilledNode._store) {
        fulfilledNode._store.validated = 1;
      }
    } else {
      node._store.validated = 1;
    }
  }
}

interface JsxDEVConfig {
  children?: any;
  [key: string]: any;
}

function jsxDEVImpl(
  type: any,
  config: JsxDEVConfig,
  maybeKey: any,
  _isStaticChildren: boolean,
  debugStack: any,
  debugTask: any
): ReactElement {
  const children = config.children;

  // ==================== 我们的修改：添加 data-code 属性并注册到 __AIRIOT_HOOK__ ====================
  if (typeof config === 'object') {
    const componentName = getComponentNameFromType(type) || (typeof type === 'string' ? type : 'Unknown');

    // 从 debugStack 解析文件位置信息
    // debugStack 格式: { fileName: string, lineNumber: number, columnNumber: number }
    let dataCode = '';
    if (debugStack && debugStack.fileName) {
      const { fileName, lineNumber, columnNumber } = debugStack;
      // 过滤掉 node_modules
      if (!fileName.includes('node_modules')) {
        // 在浏览器环境中，尝试转换为相对路径
        // Vite 开发服务器通常提供 /@fs/ 开头的路径或绝对路径
        // 我们需要提取相对于项目根目录的路径
        let relativePath = fileName;

        // 尝试移除常见的绝对路径前缀
        // 例如：/Users/xxx/project/src/App.tsx -> src/App.tsx
        const parts = fileName.split('/');
        const srcIndex = parts.findIndex((p: string) => p === 'src' || p === 'pages' || p === 'components' || p === 'blocks');
        if (srcIndex !== -1) {
          relativePath = parts.slice(srcIndex).join('/');
        }

        dataCode = `${relativePath}:${lineNumber}:${columnNumber}`;
      }
    }

    // 使用 data-code 作为元素 ID
    const elementId = dataCode || `${componentName}_unknown`;

    // 添加 data-code 属性
    if (dataCode && !config['data-code']) {
      config = { ...config, 'data-code': dataCode };
    }

    // 注册到 __AIRIOT_HOOK__
    if (typeof window !== 'undefined' && window.__AIRIOT_HOOK__) {
      const hook = window.__AIRIOT_HOOK__;

      // 记录 JSX 元素信息（初始化 children 数组）
      hook.jsxElements.set(elementId, {
        id: elementId,
        componentName,
        dataCode,
        type: type.name || type.displayName || typeof type,
        props: hook.config.captureProps ? { ...config } : undefined,
        timestamp: Date.now(),
        parentId: null,
        children: [],
      });

      // 更新组件统计（仅针对 React 组件）
      if (isReactComponent(type)) {
        if (!hook.components.has(componentName)) {
          hook.components.set(componentName, {
            name: componentName,
            renderCount: 0,
            instances: new Set(),
            firstSeen: Date.now(),
            lastSeen: Date.now(),
          });
        }

        const componentStat = hook.components.get(componentName);
        componentStat.renderCount++;
        componentStat.instances.add(elementId);
        componentStat.lastSeen = Date.now();
      }

      // 记录渲染历史（限制数量）
      hook.renders.push({
        id: elementId,
        componentName,
        dataCode,
        timestamp: Date.now(),
      });

      if (hook.renders.length > hook.config.maxRecords) {
        hook.renders.shift();
      }

      // 将 elementId 添加到 config 中，以便传递给 ReactElement
      (config as any)['__airiot_id'] = elementId;
    }
  }
  // ==================== 修改结束 ====================

  if (children !== undefined) {
    if (_isStaticChildren) {
      if (Array.isArray(children)) {
        for (let i = 0; i < children.length; i++) {
          children[i] && validateChildKeys(children[i]);
        }
        if (Object.freeze) {
          Object.freeze(children);
        }
      } else {
        console.error(
          'React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.'
        );
      }
    } else {
      children && validateChildKeys(children);
    }
  }

  if (Object.prototype.hasOwnProperty.call(config, 'key')) {
    const componentName = getComponentNameFromType(type);
    const keys = Object.keys(config).filter((k) => k !== 'key');
    const keysLength = keys.length > 0
      ? `{key: someKey, ${keys.join(': ..., ')}: ...}`
      : '{key: someKey}';

    if (!didWarnAboutKeySpread[componentName + keysLength]) {
      console.error(
        'A props object containing a "key" prop is being spread into JSX:\n' +
        '  let props = %s;\n' +
        '  <%s {...props} />\n' +
        'React keys must be passed directly to JSX without using spread:\n' +
        '  let props = %s;\n' +
        '  <%s key={someKey} {...props} />',
        keysLength,
        componentName,
        keys,
        componentName
      );
      didWarnAboutKeySpread[componentName + keysLength] = true;
    }
  }

  let key: any = null;
  if (maybeKey !== undefined) {
    key = '' + maybeKey;
  }

  if (Object.prototype.hasOwnProperty.call(config, 'key')) {
    key = '' + config.key;
  }

  let props: any = { ...config };
  if ('key' in props) {
    defineKeyPropWarningGetter(
      props,
      typeof type === 'function'
        ? type.displayName || type.name || 'Unknown'
        : type
    );
  }

  if (key !== undefined && key !== null) {
    defineKeyPropWarningGetter(
      props,
      typeof type === 'function'
        ? type.displayName || type.name || 'Unknown'
        : type
    );
  }

  // 获取 owner（React 内部）
  let owner: any = null;
  if (ReactSharedInternals && ReactSharedInternals.A) {
    owner = ReactSharedInternals.A.getOwner();
  }

  const element = ReactElement(
    type,
    key,
    props,
    owner,
    debugStack,
    debugTask
  ) as any;

  // ==================== 建立父子关系 ====================
  if (typeof window !== 'undefined' && window.__AIRIOT_HOOK__ && element._airiotId) {
    const hook = window.__AIRIOT_HOOK__;
    const currentElementId = element._airiotId;
    const currentElement = hook.jsxElements.get(currentElementId);

    if (currentElement) {
      // 处理 children，建立父子关系
      const processChildren = (children: any): void => {
        if (!children) return;

        // 单个子元素
        if (children && typeof children === 'object' && children.$$typeof === REACT_ELEMENT_TYPE) {
          // 这是一个 React 元素，读取其 _airiotId
          const childId = (children as any)._airiotId;
          if (childId) {
            const childElement = hook.jsxElements.get(childId);
            if (childElement) {
              // 设置子元素的 parentId
              (childElement as any).parentId = currentElementId;
              // 将子元素 ID 添加到当前元素的 children 数组中
              (currentElement as any).children.push(childId);
            }
          }
        }
        // 数组形式的 children
        else if (Array.isArray(children)) {
          for (const child of children) {
            processChildren(child);
          }
        }
      };

      // 递归处理 children
      processChildren(children);
    }
  }
  // ==================== 父子关系建立完成 ====================

  return element;
}

// 导出 Fragment
export const Fragment = REACT_FRAGMENT_TYPE;

// 导出 jsxDEV 函数
export function jsxDEV(
  type: any,
  config: JsxDEVConfig,
  maybeKey: any,
  isStaticChildren: boolean,
  debugStack?: any,
  debugTask?: any
): ReactElement {
  return jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask);
}

// 导出别名
export { jsxDEV as jsx };
export { jsxDEV as jsxs };

/**
 * 全局钩子初始化（用于调试）
 */
declare const window: any;

if (typeof window !== 'undefined') {
  if (!window.__AIRIOT_HOOK__) {
    window.__AIRIOT_HOOK__ = {
      jsxElements: new Map(),
      components: new Map(),
      renders: [],
      version: '1.0.0',
      config: {
        enabled: true,
        maxRecords: 1000,
        captureProps: true,
      },
      getStats() {
        return {
          totalJsxElements: this.jsxElements.size,
          totalRenders: this.renders.length,
          totalComponents: this.components.size,
          components: Array.from(this.components.values()).map((stat: any) => ({
            name: stat.name,
            renderCount: stat.renderCount,
            instanceCount: stat.instances.size,
          })),
          recentRenders: this.renders.slice(-10),
        };
      },
      clear() {
        this.jsxElements.clear();
        this.components.clear();
        this.renders = [];
      },
      findComponent(name: string) {
        const results: any[] = [];
        for (const [_id, info] of this.jsxElements) {
          if ((info as any).componentName?.includes(name)) {
            results.push(info);
          }
        }
        return results;
      },
      getComponentTree() {
        // 构建树形结构（使用已建立的父子关系）
        const roots: any[] = [];
        const elementMap = new Map<string, any>();

        // 第一遍：创建所有节点的映射
        for (const [id, element] of this.jsxElements) {
          elementMap.set(id, {
            ...(element as any),
            children: [],
          });
        }

        // 第二遍：根据 parentId 构建树形结构
        for (const element of elementMap.values()) {
          const elem = element as any;
          if (!elem.parentId) {
            // 没有父节点，作为根节点
            roots.push(elem);
          } else {
            // 有父节点，添加到父节点的 children 中
            const parent = elementMap.get(elem.parentId);
            if (parent) {
              parent.children.push(elem);
            }
          }
        }

        return roots;
      },
      getElementTree(id: string) {
        // 获取指定元素及其所有子孙（使用已建立的父子关系）
        const element = this.jsxElements.get(id);
        if (!element) return null;

        const buildTree = (elemId: string): any => {
          const elem = this.jsxElements.get(elemId);
          if (!elem) return null;

          const elemData: any = { ...(elem as any), children: [] };

          // 递归构建子树
          const childIds = (elem as any).children || [];
          elemData.children = childIds.map((childId: string) => buildTree(childId)).filter(Boolean);

          return elemData;
        };

        return buildTree(id);
      },
    };

    console.log('[AIRIOT HOOK] JSX Debug Hook initialized');
    console.log('Available commands:');
    console.log('  - window.__AIRIOT_HOOK__.getStats()');
    console.log('  - window.__AIRIOT_HOOK__.findComponent("ComponentName")');
    console.log('  - window.__AIRIOT_HOOK__.getComponentTree()');
    console.log('  - window.__AIRIOT_HOOK__.getElementTree("elementId")');
    console.log('  - window.__AIRIOT_HOOK__.clear()');
  }
}
