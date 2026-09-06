import Dashboard from '../pages/dashboard/Dashboard';
import Users from '../pages/users/Users';

/**
 * 页面渲染宿主：按路由选择渲染 Dashboard / Users。
 * HMR 由 @vitejs/plugin-react 的 fast refresh 处理（组件级热更、保状态），
 * 无需自建 accept 边界。
 */
export default function PageView({ page }: { page: 'dashboard' | 'users' }) {
  return page === 'users' ? <Users /> : <Dashboard />;
}
