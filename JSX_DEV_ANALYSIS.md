# React JSX 调试信息分析

## React JSX Runtime 对比

React有两个JSX runtime：
1. **react/jsx-runtime** - 生产版本，精简高效
2. **react/jsx-dev-runtime** - 开发版本，包含调试信息

## 关键差异

### 生产版本 (jsx-runtime)
```javascript
import { jsx } from 'react/jsx-runtime';

// 简单调用，无额外参数
jsx(Component, { children }, key)
```

### 开发版本 (jsx-dev-runtime)
```javascript
import { jsxDEV } from 'react/jsx-dev-runtime';

// 包含调试信息
jsxDEV(
  type,
  props,
  key,
  isStaticChildren,
  source,        // ⭐ 关键：源码位置信息
  self           // ⭐ 关键：组件实例信息
)
```

## __source 和 __self 的来源

**重要发现**：`__source` 和 `__self` **不是由React runtime提供的**，而是由**Babel插件**在转换JSX时添加的！

### Babel转换过程

#### 输入代码
```tsx
function Dashboard() {
  return <div className="p-4">Dashboard</div>
}
```

#### Babel转换后（开发模式）
```javascript
import { jsxDEV } from 'react/jsx-dev-runtime';

function Dashboard() {
  return jsxDEV(
    'div',
    { className: 'p-4', children: 'Dashboard' },
    undefined,
    false,
    {
      fileName: '/path/to/Dashboard.tsx',
      lineNumber: 10,
      columnNumber: 5
    },  // ⭐ 这是 __source
    this    // ⭐ 这是 __self（组件实例）
  );
}
```

## __source 结构

```javascript
{
  fileName: string,    // 文件路径
  lineNumber: number,  // 行号
  columnNumber: number // 列号
}
```

## 如何在浏览器中获取这些信息

### 方法1：通过React DevTools
```javascript
// React DevTools会使用__source信息显示组件位置
// 但在运行时代码中很难直接访问
```

### 方法2：重写jsxDEV函数（你的插件方案）
```javascript
import { jsxDEV as originalJsxDEV } from 'react/jsx-dev-runtime';

function jsxDEV(type, props, key, isStaticChildren, source, self) {
  // source 包含文件信息
  console.log('Component source:', source);
  // { fileName: '/path/to/Dashboard.tsx', lineNumber: 10, columnNumber: 5 }

  // self 是组件实例（可能是undefined）
  console.log('Component self:', self);

  return originalJsxDEV(type, props, key, isStaticChildren, source, self);
}

export { jsxDEV };
```

### 方法3：使用Babel插件在编译时添加（推荐）

这就是我们的插件正在做的事情！

```javascript
// Babel插件转换
export function transformJSXWithAttributes(code, filePath) {
  const ast = parse(code);

  traverse(ast, {
    JSXElement(path) {
      // 找到组件的根JSX元素
      // 添加 data-code 属性
      path.node.openingElement.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier('data-code'),
          t.stringLiteral(`${filePath}:${lineNumber}`)
        )
      );
    }
  });

  return generate(ast);
}
```

## 为什么我们的插件更好？

### JSX Runtime 方案的缺点
```javascript
// ❌ 需要配置Vite alias
resolve: {
  alias: {
    'react/jsx-dev-runtime': '/src/jsx-runtime.ts'
  }
}

// ❌ 每次JSX创建都有性能开销
function jsxDEV(...) {
  const stack = new Error().stack;  // CPU密集
  parseComponentInfo(stack);         // 遍历调用栈
  addDataCode(props);                // 对象复制
  return originalJsxDEV(...);
}

// ❌ 调用栈解析不可靠
// - 生产环境栈可能被压缩
// - Source Map可能导致路径不准确
```

### Babel AST 方案的优点 ✅
```javascript
// ✅ 编译时完成，零运行时开销
function Dashboard() {
  return <div data-code="pages/Dashboard.tsx:10">Dashboard</div>
}

// ✅ 真实的DOM属性
const element = document.querySelector('[data-code]');
console.log(element.dataset.code); // "pages/Dashboard.tsx:10"

// ✅ CSS选择器
document.querySelectorAll('[data-code^="pages/"]')

// ✅ 自动化测试
expect(element).toHaveAttribute('data-code', 'pages/Dashboard.tsx:10')
```

## 实际代码示例

创建自定义jsx runtime来查看source信息：

```typescript
// src/jsx-runtime-dev.ts
import { jsxDEV as originalJsxDEV } from 'react/jsx-dev-runtime';

function jsxDEV(
  type: any,
  props: any,
  key: any,
  isStaticChildren: boolean,
  source: { fileName?: string; lineNumber?: number; columnNumber?: number },
  self: any
) {
  // 打印调试信息
  if (source && source.fileName) {
    console.log('[JSX Source]', {
      file: source.fileName,
      line: source.lineNumber,
      column: source.columnNumber,
      component: getComponentName(type),
    });
  }

  // 添加data-code属性
  if (source && source.fileName && props && !props['data-code']) {
    const dataCode = `${source.fileName}:${source.lineNumber}`;
    props = { ...props, 'data-code': dataCode };
  }

  return originalJsxDEV(type, props, key, isStaticChildren, source, self);
}

export { jsxDEV, Fragment } from 'react/jsx-dev-runtime';
```

## Vite配置

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 仅在开发模式使用自定义runtime
      ...(process.env.NODE_ENV === 'development' ? {
        'react/jsx-dev-runtime': '/src/jsx-runtime-dev.ts',
      } : {}),
    },
  },
});
```

## 调试信息来源总结

| 信息 | 来源 | 访问方式 |
|------|------|---------|
| `__source` | Babel JSX插件 | jsxDEV的source参数 |
| `__self` | Babel JSX插件 | jsxDEV的self参数 |
| 组件name | type.displayName/name | getComponentNameFromType(type) |
| 文件路径 | source.fileName | source对象 |
| 行号 | source.lineNumber | source对象 |

## 最佳实践

我们的插件使用**Babel AST转换**是最佳方案，因为：

1. ✅ **编译时完成** - 不影响运行时性能
2. ✅ **准确可靠** - 直接从源码解析
3. ✅ **DOM可访问** - 真实的HTML属性
4. ✅ **可调试** - 支持Source Map
5. ✅ **不侵入** - 不需要修改React

**结论**：我们实现的AST转换方案是最优解！
