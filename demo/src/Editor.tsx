import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutDashboardIcon, TerminalSquareIcon, UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Toaster, toast } from '@/components/ui/toast';
import { nodeApi, addChildToPageRoot } from './editorApi';
import { decodeNodeId } from './decodeNodeId';
import PageView from './PageView';
import ApiConsole from './ApiConsole';
import PropPanel from './PropPanel';

// ===== react-router 路由配置（页面下拉列表的数据来源） =====
interface AppRoute {
  path: string;
  label: string;
  file: string; // /__editor API 使用的页面相对路径
  icon: typeof LayoutDashboardIcon;
}

const APP_ROUTES: AppRoute[] = [
  { path: '/dashboard', label: '总览', file: 'dashboard/Dashboard', icon: LayoutDashboardIcon },
  { path: '/users', label: '用户', file: 'users/Users', icon: UsersIcon },
  { path: '/api', label: 'API', file: 'api', icon: TerminalSquareIcon },
];

interface SelInfo {
  id: string;
  label: string;
  sub?: string;
}

interface BoxRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function App() {
  const location = useLocation();
  const pathname = location.pathname;
  const route = APP_ROUTES.find((r) => r.path === pathname) ?? APP_ROUTES[0];
  const isApi = pathname === '/api';
  const pageFile = route?.file && !isApi ? route.file : 'dashboard/Dashboard';

  const [dropOpen, setDropOpen] = useState(false);
  const [selected, setSelected] = useState<SelInfo | null>(null);
  const [tick, setTick] = useState(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  /** 点中的那个 DOM 实例（迭代渲染时同 id 会有多个元素，必须记住具体是第几个） */
  const anchorRef = useRef<HTMLElement | null>(null);
  /** 点中的实例在同 id 元素列表中的序号（HMR 重挂载后按序号找回同一个实例） */
  const selIndexRef = useRef<number | null>(null);
  const [box, setBox] = useState<BoxRect | null>(null);
  const metaSeqRef = useRef(0);

  const refreshTick = () => setTick((t) => t + 1);

  const clearSelection = () => {
    anchorRef.current = null;
    selIndexRef.current = null;
    setSelected(null);
    setBox(null);
  };

  // 路由切换（react-router）时清空选中状态
  useEffect(() => {
    clearSelection();
    setDropOpen(false);
  }, [pathname]);

  const measure = useCallback(() => {
    if (!selected || isApi || !previewRef.current) {
      setBox(null);
      return;
    }
    const container = previewRef.current;
    let el = anchorRef.current && anchorRef.current.isConnected ? anchorRef.current : null;
    if (!el) {
      const matches = container.querySelectorAll<HTMLElement>(`[data-node-id="${selected.id}"]`);
      if (matches.length > 0) {
        const idx = selIndexRef.current ?? 0;
        el = matches[Math.min(idx, matches.length - 1)];
      }
    }
    if (!el) {
      setBox(null);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setBox({
      top: r.top - cRect.top + container.scrollTop,
      left: r.left - cRect.left + container.scrollLeft,
      width: r.width,
      height: r.height,
    });
  }, [selected, isApi]);

  useEffect(() => {
    if (isApi) {
      setBox(null);
      return;
    }
    measure();
    const onResize = () => requestAnimationFrame(measure);
    window.addEventListener('resize', onResize);
    previewRef.current?.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      previewRef.current?.removeEventListener('scroll', onResize, true);
    };
  }, [measure, isApi, selected?.id, tick]);

  // HMR 重挂载后重试定位外框
  useEffect(() => {
    if (!selected) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      measure();
      if (tries >= 10) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, [selected, measure]);

  const onPreviewClick = (e: any) => {
    const target = e.target as HTMLElement;
    const el = target.closest('[data-node-id]') as HTMLElement | null;
    if (!el) return;
    const id = el.dataset.nodeId ?? '';
    const span = decodeNodeId(id);
    anchorRef.current = el;
    const list = previewRef.current?.querySelectorAll<HTMLElement>(`[data-node-id="${id}"]`);
    selIndexRef.current = list ? Array.from(list).indexOf(el) : null;
    if (selIndexRef.current !== null && selIndexRef.current < 0) selIndexRef.current = null;
    // 先以 DOM 标签占位，随后 GET /__editor/node/{id} 拉取组件名/文件（DOM 不再注入 name/file）
    setSelected({ id, label: el.tagName.toLowerCase(), sub: span?.file });
    refreshTick();
    const seq = ++metaSeqRef.current;
    nodeApi(id)
      .get()
      .then((info: any) => {
        if (seq !== metaSeqRef.current) return;
        setSelected({
          id,
          label: info.componentName || info.tag || el.tagName.toLowerCase(),
          sub: info.componentFile || span?.file,
        });
      })
      .catch(() => {
        /* 接口不可用时保留占位标签 */
      });
  };

  const onDropAdd = async (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    let comp: { name: string; file: string };
    try {
      comp = JSON.parse(raw);
    } catch {
      return;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const host = under?.closest?.('[data-node-id]') as HTMLElement | null;
    try {
      const data = host?.dataset.nodeId
        ? ((await nodeApi(host.dataset.nodeId).postChild({ nodeName: comp.name, nodeFile: comp.file, props: [] })) as { nodeId: string })
        : await addChildToPageRoot(pageFile, { nodeName: comp.name, nodeFile: comp.file, props: [] });
      toast.add({ type: 'success', title: '已插入组件', description: `${comp.name} → ${host ? '目标元素内' : '页面根'}` });
      anchorRef.current = null;
      setSelected({ id: data.nodeId, label: comp.name, sub: comp.file });
      refreshTick();
    } catch (err: any) {
      toast.add({ type: 'error', title: '插入失败', description: err.message });
    }
  };

  const onSelectionChange = (id: string | null) => {
    anchorRef.current = null;
    if (id) {
      setSelected((prev) => (prev ? { ...prev, id } : { id, label: '节点' }));
    } else {
      selIndexRef.current = null;
      setSelected(null);
    }
    refreshTick();
  };

  const renderPreview = (page: 'dashboard' | 'users') => (
    <div
      ref={previewRef}
      onClick={onPreviewClick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropAdd}
      className="relative h-full overflow-auto p-6"
      style={{ scrollBehavior: 'smooth' }}
    >
      <PageView page={page} />
      {box && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border-2 border-sky-500 shadow-[0_0_0_3px_rgba(14,165,233,0.25)]"
          style={{ top: box.top - 3, left: box.left - 3, width: box.width + 6, height: box.height + 6 }}
        >
          <div className="absolute -top-6 left-0 flex items-center gap-1 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] text-white">
            {selected?.label}
            {selected?.sub && <span className="max-w-52 truncate font-mono opacity-80">{selected.sub}</span>}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-screen bg-muted/40 text-foreground">
      ===== 左侧 =====
      <aside className="relative flex w-96 shrink-0 flex-col gap-2 border-r bg-card p-3">
        <div>
          <div className="flex items-center justify-between">
            <h1 className="font-heading text-base font-semibold tracking-tight">@kesi/vite-plugin</h1>
            <Badge variant="secondary">组件编辑器</Badge>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            react-router 驱动页面切换；点击右侧页面元素即可在下方编辑属性/插入/删除/查看代码。
          </p>
        </div>

        {/* 路由下拉列表 */}
        <div className="relative">
          <button
            onClick={() => setDropOpen((o) => !o)}
            className="flex h-9 w-full items-center justify-between rounded-lg border bg-background px-3 text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-2">
              {(() => {
                const Icon = route.icon;
                return <Icon className="size-4" />;
              })()}
              {route.label}
              <span className="font-mono text-xs text-muted-foreground">{route.path}</span>
            </span>
            <span className="text-muted-foreground">{dropOpen ? '▴' : '▾'}</span>
          </button>
          {dropOpen && (
            <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
              {APP_ROUTES.map((r) => {
                const Icon = r.icon;
                const active = pathname === r.path;
                return (
                  <Link
                    key={r.path}
                    to={r.path}
                    onClick={() => setDropOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted ${
                      active ? 'bg-primary/10 font-medium text-primary' : ''
                    }`}
                  >
                    <Icon className="size-4" />
                    <span>{r.label}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">{r.path}</span>
                    {active && <Badge className="text-[9px]">当前</Badge>}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {!isApi && <PropPanel page={pageFile} selectedId={selected?.id ?? null} onSelectionChange={onSelectionChange} />}
        {isApi && (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            当前路由 /api → API 调试台。用上方下拉切到页面路由即可可视化编辑组件。
          </p>
        )}
      </aside>

      {/* ===== 右侧（react-router 路由出口） ===== */}
      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/dashboard" element={renderPreview('dashboard')} />
          <Route path="/users" element={renderPreview('users')} />
          <Route
            path="/api"
            element={
              <div className="h-full p-4">
                <ApiConsole />
              </div>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      <Toaster />
    </div>
  );
}
