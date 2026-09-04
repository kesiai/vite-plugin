# AIRIOT JSX 调试钩子系统 - 使用指南

## 概述

这是一个完整的 JSX 调试系统，通过复写 `react/jsx-dev-runtime` 来捕获所有 JSX 元素的创建，提供详细的调试信息和统计数据。

## 功能特性

### 1. 自动捕获 JSX 元素
- 拦截所有 JSX 元素的创建
- 记录组件名称、props、时间戳
- 自动添加 `data-code` 属性指向源文件位置
- 使用 WeakMap 缓存组件信息，避免性能损耗

### 2. 完整的调试信息
- **组件名称**: 识别函数组件、类组件、Memo、ForwardRef 等
- **Props 序列化**: 安全地序列化 props，处理函数、React 元素等特殊类型
- **源码位置**: 从调用栈提取文件路径和行号
- **时间戳**: 记录每次创建的时间
- **渲染统计**: 统计每个组件的渲染次数

### 3. 全局调试 API
在浏览器控制台中使用 `window.__AIRIOT_HOOK__` 访问调试功能。

## 使用方法

### 1. 安装和配置

#### vite.config.ts

```typescript
import { defineConfig } from 'vite';
import airiot from 'vite-plugin-airiot';

export default defineConfig({
  plugins: [
    airiot({
      dataCodeImplementation: 'jsxDev', // 使用 jsxDev 方式
      enableDataCode: true,              // 启用 data-code 属性
      enableComponentRoutes: true,       // 启用组件路由
      scanDirectories: ['pages', 'blocks'], // 扫描目录
    })
  ]
});
```

### 2. 控制台 API

#### 获取统计信息

```javascript
// 查看整体统计
window.__AIRIOT_HOOK__.getStats();

// 返回示例:
{
  totalJsxElements: 150,
  totalRenders: 150,
  totalComponents: 25,
  components: [
    { name: 'App', renderCount: 1, instanceCount: 1 },
    { name: 'Dashboard', renderCount: 45, instanceCount: 15 },
    { name: 'Button', renderCount: 80, instanceCount: 80 }
  ],
  recentRenders: [
    { id: 'jsx_1234567890_abc123', componentName: 'Button', timestamp: 1234567890, ... }
  ]
}
```

#### 查找特定组件

```javascript
// 查找所有 Button 组件
window.__AIRIOT_HOOK__.findComponent('Button');

// 查找所有 Dashboard 组件
window.__AIRIOT_HOOK__.findComponent('Dashboard');
```

#### 获取元素树

```javascript
// 获取最近 50 个 JSX 元素
window.__AIRIOT_HOOK__.getElementTree(50);

// 返回示例:
[
  {
    id: 'jsx_1234567890_abc123',
    name: 'Button',
    time: '14:23:45.123',
    props: ['onClick', 'children', 'disabled'],
    source: { fileName: '/src/Button.tsx', lineNumber: 10 }
  },
  ...
]
```

#### 导出数据

```javascript
// 导出完整的调试数据
window.__AIRIOT_HOOK__.exportData();

// 返回示例:
{
  config: { enabled: true, maxRecords: 1000, captureProps: true, captureStack: true },
  stats: { ... },
  elements: [[id, { ... }], ...],
  renders: [ ... ],
  timestamp: 1234567890
}
```

#### 控制钩子

```javascript
// 禁用钩子（停止记录）
window.__AIRIOT_HOOK__.disable();

// 启用钩子（恢复记录）
window.__AIRIOT_HOOK__.enable();

// 清空所有记录
window.__AIRIOT_HOOK__.clear();
```

### 3. 在组件中使用

#### 检查 data-code 属性

```jsx
// 每个组件都会自动获得 data-code 属性
function MyComponent() {
  return <div className="container">Content</div>;
}

// 渲染后的 HTML:
// <div class="container" data-code="/src/MyComponent.tsx:10">Content</div>
```

#### 在 CSS 中使用

```css
/* 高亮显示有 data-code 的元素 */
[data-code] {
  outline: 1px solid blue;
}

/* 显示 data-code 内容 */
[data-code]:hover::after {
  content: attr(data-code);
  position: fixed;
  bottom: 10px;
  right: 10px;
  background: rgba(0,0,0,0.8);
  color: white;
  padding: 5px 10px;
  border-radius: 5px;
  font-family: monospace;
  font-size: 12px;
}
```

#### 在 JavaScript 中访问

```javascript
// 查找所有有 data-code 的元素
document.querySelectorAll('[data-code]');

// 获取特定组件的元素
document.querySelectorAll('[data-code*="Button"]');

// 点击元素时显示其位置
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-code]');
  if (target) {
    console.log('Component location:', target.dataset.code);
  }
});
```

### 4. 自定义事件监听

```javascript
// 监听 JSX 创建事件
window.__AIRIOT_HOOK__.onJsxCreate = (debugInfo) => {
  console.log('New JSX element created:', {
    component: debugInfo.componentName,
    location: debugInfo.dataCode,
    props: debugInfo.props
  });
};

// 取消监听
window.__AIRIOT_HOOK__.onJsxCreate = undefined;
```

## 配置选项

### 插件配置

```typescript
interface PluginOptions {
  enableDataCode?: boolean;              // 默认: true - 是否添加 data-code 属性
  enableComponentRoutes?: boolean;       // 默认: true - 是否启用组件路由
  scanDirectories?: string[];            // 默认: ['pages', 'blocks'] - 扫描的目录
  dataCodeImplementation?: 'jsxDev'      // 默认: 'jsxDev' - 实现方式
    | 'ast'                              // 'ast': 编译时转换
    | 'patch';                           // 'patch': 运行时 patch
}
```

### 运行时配置

```javascript
// 修改运行时行为
window.__AIRIOT_HOOK__.config = {
  enabled: true,           // 是否启用钩子
  maxRecords: 1000,        // 最大记录数
  captureProps: true,      // 是否捕获 props
  captureStack: true       // 是否捕获调用栈
};
```

## 性能考虑

### 内存管理
- 使用 **WeakMap** 缓存组件信息，自动垃圾回收
- 默认最多记录 **1000** 条渲染历史
- 超过限制时自动清理旧记录

### 性能开销
- **首次渲染**: 解析调用栈，~1-2ms
- **后续渲染**: 从缓存读取，<0.1ms
- **建议**: 生产环境禁用或使用 AST 方式

### 生产环境配置

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [
    airiot({
      dataCodeImplementation: process.env.NODE_ENV === 'development' ? 'jsxDev' : 'ast',
      enableDataCode: process.env.NODE_ENV === 'development',
    })
  ]
});
```

## 调试技巧

### 1. 追踪组件渲染

```javascript
// 监控特定组件的渲染次数
const stats = window.__AIRIOT_HOOK__.getStats();
const component = stats.components.find(c => c.name === 'MyComponent');
console.log(`MyComponent rendered ${component.renderCount} times`);
```

### 2. 性能分析

```javascript
// 记录渲染时间
const renders = window.__AIRIOT_HOOK__.renders;
const timeDiff = renders[renders.length - 1].timestamp - renders[0].timestamp;
console.log(`${renders.length} renders in ${timeDiff}ms`);
```

### 3. 查找重复渲染

```javascript
// 找出渲染次数最多的组件
const stats = window.__AIRIOT_HOOK__.getStats();
const frequentRenderers = stats.components
  .filter(c => c.renderCount > 10)
  .sort((a, b) => b.renderCount - a.renderCount);

console.table(frequentRenderers);
```

### 4. 源码定位

```javascript
// 点击元素自动打开编辑器
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-code]');
  if (target) {
    const [file, line] = target.dataset.code.split(':');
    console.log(`Open ${file} at line ${line}`);
    // 可以配置 VS Code 协议: vscode://file/${file}:${line}
  }
});
```

## 故障排除

### 问题 1: data-code 属性没有出现

**可能原因**:
- 插件没有正确配置
- 使用的是生产构建
- HTML 元素而不是 React 组件

**解决方法**:
```javascript
// 检查插件是否加载
console.log(window.__AIRIOT_HOOK__); // 应该存在

// 检查配置
console.log(window.__AIRIOT_HOOK__.config.enabled); // 应该是 true

// 确保是 React 组件（大写字母开头）
function MyComponent() { } // ✅ 会被捕获
function myComponent() { } // ❌ 不会被捕获（小写）
```

### 问题 2: 性能下降

**解决方法**:
```javascript
// 减少记录数
window.__AIRIOT_HOOK__.config.maxRecords = 100;

// 禁用 props 捕获
window.__AIRIOT_HOOK__.config.captureProps = false;

// 临时禁用钩子
window.__AIRIOT_HOOK__.disable();
```

### 问题 3: TypeScript 类型错误

**解决方法**:
```typescript
// 添加全局类型声明
declare global {
  interface Window {
    __AIRIOT_HOOK__?: AiriotHook;
  }
}

// 定义钩子类型
interface AiriotHook {
  jsxElements: Map<string, any>;
  components: Map<string, any>;
  renders: any[];
  version: string;
  config: {
    enabled: boolean;
    maxRecords: number;
    captureProps: boolean;
    captureStack: boolean;
  };
  enable(): void;
  disable(): void;
  clear(): void;
  getStats(): any;
  findComponent(name: string): any[];
  getElementTree(limit?: number): any[];
  exportData(): any;
}
```

## 进阶用法

### 与 React DevTools 集成

```javascript
// 结合 React DevTools 使用
window.__AIRIOT_HOOK__.onJsxCreate = (debugInfo) => {
  if (debugInfo.componentName === 'ProblematicComponent') {
    console.log('ProblematicComponent created:', {
      props: debugInfo.props,
      stack: new Error().stack
    });
  }
};
```

### 自动化测试

```javascript
// 测试组件渲染次数
expect(window.__AIRIOT_HOOK__.getStats().components.find(
  c => c.name === 'MyComponent'
).renderCount).toBe(1);
```

### 监控和告警

```javascript
// 设置渲染次数告警
setInterval(() => {
  const stats = window.__AIRIOT_HOOK__.getStats();
  stats.components.forEach(comp => {
    if (comp.renderCount > 100) {
      console.warn(`⚠️ Component ${comp.name} rendered ${comp.renderCount} times!`);
    }
  });
}, 5000);
```

## 总结

AIRIOT JSX 调试钩子系统提供了：

✅ **零配置使用** - 安装插件即可自动工作
✅ **完整的调试信息** - 组件名、props、源码位置
✅ **强大的控制台 API** - 统计、搜索、导出
✅ **自动 data-code 属性** - 直接在 DOM 中查看组件来源
✅ **性能优化** - WeakMap 缓存、自动清理
✅ **可配置** - 运行时控制开关和选项
✅ **生产环境友好** - 可禁用或使用 AST 方式

享受高效的 React 开发调试体验！🚀
