# vite-plugin-airiot

一个强大的 Vite 开发插件，为 React 项目提供组件代码追踪、可视化展示和丰富的开发工具 API。

## 功能特性

### 1. 自动添加 data-code 属性
在开发模式下，自动为每个 React 组件的根元素添加 `data-code` 属性：
- 使用 Babel AST 在编译时转换代码
- 零运行时开销
- 包含组件文件的相对路径和起始行号
- 格式：`"relative/path/to/Component.jsx:lineNumber"`

**转换示例：**
```tsx
// 转换前
export function Dashboard() {
  return <div className="p-4">Dashboard</div>
}

// 转换后
export function Dashboard() {
  return <div className="p-4" data-code="pages/Dashboard.tsx:1">Dashboard</div>
}
```

### 2. 组件展示路由
为 `pages` 和 `blocks` 目录下的 TSX 组件自动生成展示页面：
- 使用 React Router 管理路由
- 路由格式：`/airiot/components/{relative/path/to/Component}`
- 支持组件预览和调试
- 内置组件浏览器和查看器

### 3. HTTP API 接口

| API路径 | 方法 | 功能 |
|---------|------|------|
| `/__airiot/components` | GET | 获取所有组件的data-code信息 |
| `/__airiot/ui` | GET | 获取组件的路由列表 |
| `/__airiot/status` | GET | 获取服务器运行状态 |
| `/__airiot/routers` | GET/POST | 获取/更新路由配置 |
| `/__airiot/install-package` | POST | 安装npm包 |
| `/__airiot/install-shadcn` | POST | 安装shadcn/ui组件 |
| `/__airiot/modify-code` | POST | 修改组件代码 |
| `/__airiot/build` | POST | 执行项目构建 |

## 安装

```bash
npm install vite-plugin-airiot -D
```

## 使用

### 基本配置

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import airiot from 'vite-plugin-airiot'

export default defineConfig({
  plugins: [
    react(),
    airiot({
      // 可选配置
      enableDataCode: true,              // 启用 data-code 属性（默认：true）
      enableComponentRoutes: true,        // 启用组件展示路由（默认：true）
      scanDirectories: ['pages', 'blocks'] // 要扫描的目录（默认：['pages', 'blocks']）
    })
  ]
})
```

### 项目结构

```
project-root/
├── pages/              # 页面组件目录
│   ├── dashboard/
│   │   └── Dashboard.tsx
│   └── users/
│       └── Users.tsx
├── blocks/             # UI组件目录
│   └── ui/
│       ├── Button.tsx
│       └── Card.tsx
├── src/
│   └── App.tsx
├── vite.config.ts
└── package.json
```

**重要：** `pages` 和 `blocks` 目录应在项目根目录下，不在 `src` 目录内。

## API 使用示例

### 1. 获取所有组件

```bash
curl http://localhost:5173/__airiot/components
```

**响应：**
```json
{
  "success": true,
  "data": [
    {
      "name": "Dashboard",
      "dataCode": "pages/dashboard/Dashboard.tsx:1",
      "filePath": "pages/dashboard/Dashboard.tsx",
      "lineNumber": 1
    }
  ]
}
```

### 2. 获取组件路由

```bash
curl http://localhost:5173/__airiot/ui
```

**响应：**
```json
{
  "success": true,
  "data": [
    {
      "component": "Dashboard",
      "route": "/airiot/components/dashboard/Dashboard",
      "filePath": "pages/dashboard/Dashboard.tsx",
      "lineNumber": 1
    }
  ]
}
```

### 3. 修改组件代码

```bash
curl -X POST http://localhost:5173/__airiot/modify-code \
  -H "Content-Type: application/json" \
  -d '{
    "componentName": "Dashboard",
    "modifications": [
      {
        "type": "append",
        "content": "// Modified by API"
      }
    ]
  }'
```

**修改类型：**
- `append`: 在文件末尾添加内容
- `prepend`: 在文件开头添加内容
- `insert`: 在指定行插入内容
- `replace`: 替换匹配的内容（支持正则）

### 4. 安装npm包

```bash
curl -X POST http://localhost:5173/__airiot/install-package \
  -H "Content-Type: application/json" \
  -d '{"packageName":"axios"}'
```

### 5. 安装shadcn/ui组件

```bash
curl -X POST http://localhost:5173/__airiot/install-shadcn \
  -H "Content-Type: application/json" \
  -d '{"componentName":"button"}'
```

### 6. 执行构建

```bash
curl -X POST http://localhost:5173/__airiot/build
```

### 7. 检查运行状态

```bash
curl http://localhost:5173/__airiot/status
```

## 组件展示UI

启动开发服务器后，访问：
```
http://localhost:5173/airiot/components
```

### 功能
- 🔍 实时搜索过滤组件
- 📊 卡片式布局展示
- 📝 显示组件详细信息（文件路径、行号、data-code）
- 🔗 点击预览组件
- ⬅️ 返回导航

## 技术实现

### data-code 属性添加

使用 **Babel AST 转换**在编译时完成：

1. 解析代码为AST（@babel/parser）
2. 遍历AST识别组件定义（@babel/traverse）
3. 在组件的根JSX元素添加data-code属性
4. 重新生成代码（@babel/generator）

**优点：**
- ✅ 编译时完成，零运行时开销
- ✅ 真实的DOM属性，浏览器可访问
- ✅ 支持CSS选择器：`[data-code="pages/Dashboard.tsx:1"]`
- ✅ 支持JavaScript访问：`element.dataset.code`
- ✅ 调试友好，支持Source Map

## 组件命名规范

插件会自动识别以下格式的组件定义：

1. **函数声明**
```typescript
export function Dashboard() {}
function Dashboard() {}
```

2. **箭头函数**
```typescript
export const Dashboard = () => {}
const Dashboard = () => {}
```

3. **函数表达式**
```typescript
export const Dashboard = function() {}
const Dashboard = function() {}
```

**要求：** 组件名必须以大写字母开头才会被识别。

## 工作原理

### 1. 组件扫描
- 扫描 `pages` 和 `blocks` 目录
- 识别 React 组件定义
- 提取组件名称、文件路径、行号
- 支持热更新自动重新扫描

### 2. 代码转换
- 使用 Vite 的 `transform` 钩子
- 仅处理 `.jsx` 和 `.tsx` 文件
- 仅在开发模式下生效
- 不影响生产构建

### 3. HTTP API
- 在开发服务器中注入API中间件
- 提供RESTful API接口
- 支持CORS跨域访问

## 注意事项

1. **仅开发模式**：插件仅在开发模式下生效，不影响生产构建
2. **性能影响**：AST转换在编译时完成，运行时零开销
3. **安全性**：API接口未做身份验证，仅在本地开发使用
4. **目录要求**：`pages` 和 `blocks` 目录应在项目根目录

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听模式
npm run dev

# 类型检查
npm run typecheck
```

## 依赖

- `@babel/parser` - 解析代码为AST
- `@babel/traverse` - 遍历AST
- `@babel/types` - AST节点类型
- `@babel/generator` - 从AST生成代码
- `express` - HTTP服务器（仅开发时）

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
