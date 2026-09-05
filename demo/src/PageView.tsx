import { useEffect, useState } from 'react';
import Dashboard from '../pages/dashboard/Dashboard';
import Users from '../pages/users/Users';

/**
 * 页面渲染宿主：给 pages/ 下的组件建立 HMR accept 边界。
 * 属性/增删编辑会写回页面文件 → Vite 触发更新时，只在此边界热替换页面子树，
 * 不会整页 reload，App/左侧编辑面板/选中状态得以保留。
 */
type Comp = typeof Dashboard;
let current = { dashboard: Dashboard, users: Users };
const listeners = new Set<() => void>();

if (import.meta.hot) {
  import.meta.hot.accept(
    ['../pages/dashboard/Dashboard', '../pages/users/Users'],
    ([d, u]: [any, any]) => {
      if (d?.default) current = { ...current, dashboard: d.default };
      if (u?.default) current = { ...current, users: u.default };
      listeners.forEach((l) => l());
    }
  );
}

export default function PageView({ page }: { page: 'dashboard' | 'users' }) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const Comp = page === 'users' ? current.users : current.dashboard;
  return <Comp />;
}
