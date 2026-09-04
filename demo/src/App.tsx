import { useState } from 'react';
import { LayoutDashboardIcon, MousePointerClickIcon, UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/toast';
import { decodeNodeId } from './decodeNodeId';
import Dashboard from '../pages/dashboard/Dashboard';
import Users from '../pages/users/Users';

const API_ENDPOINTS: Array<[string, string]> = [
  ['components', '组件扫描'],
  ['ui', '页面路由'],
  ['status', '状态'],
  ['file', 'pages 文件'],
  ['package-json', 'package.json'],
  ['plugin-check', '插件自检'],
];

export default function App() {
  const [page, setPage] = useState<'dashboard' | 'users'>('dashboard');
  const [nodeInfo, setNodeInfo] = useState('点击右侧页面中的任意元素，查看它的 data-node-id 与源码定位');
  const [apiOut, setApiOut] = useState('');

  const handleClick = (e: any) => {
    const el = (e.target as HTMLElement).closest('[data-node-id]') as HTMLElement | null;
    if (!el) return;
    const id = el.dataset.nodeId ?? '';
    const span = decodeNodeId(id);
    setNodeInfo(
      span
        ? `${id}\n\n→ ${span.file}\n→ ${span.startLine}:${span.startCol} ~ ${span.endLine}:${span.endCol}`
        : id
    );
  };

  const callApi = async (path: string) => {
    try {
      const res = await fetch(`/__editor/${path}`);
      setApiOut(JSON.stringify(await res.json(), null, 2));
    } catch (err: any) {
      setApiOut(String(err));
    }
  };

  return (
    <div className="flex min-h-screen bg-muted/40 text-foreground">
      {/* 左侧：调试面板 */}
      <aside className="flex w-80 shrink-0 flex-col gap-3 border-r bg-card p-4">
        <div>
          <div className="flex items-center justify-between">
            <h1 className="font-heading text-lg font-semibold tracking-tight">@kesi/vite-plugin</h1>
            <Badge variant="secondary">shadcn/ui</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            页面元素被编译期注入 <code>data-node-id</code>（node- + base64url JSON）。点击元素可查看其
            源码位置（file + 起止标签行列）。
          </p>
        </div>

        <Separator />

        <Tabs value={page} onValueChange={(v) => setPage(v as 'dashboard' | 'users')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="dashboard">
              <LayoutDashboardIcon />
              总览
            </TabsTrigger>
            <TabsTrigger value="users">
              <UsersIcon />
              用户
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <MousePointerClickIcon className="size-4" />
              选中节点
            </CardTitle>
            <CardDescription className="text-xs">解码后的 data-node-id</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-40 overflow-auto text-[11px] leading-4 whitespace-pre-wrap break-all text-muted-foreground">
              {nodeInfo}
            </pre>
          </CardContent>
        </Card>

        <div>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            /__editor/* API
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {API_ENDPOINTS.map(([path, label]) => (
              <Button key={path} variant="outline" size="xs" onClick={() => callApi(path)}>
                {label}
              </Button>
            ))}
          </div>
        </div>

        <Card>
          <CardContent className="py-3">
            <pre className="max-h-72 overflow-auto text-[10px] leading-4 text-muted-foreground">
              {apiOut || '点击上方按钮调用接口，响应显示在这里。'}
            </pre>
          </CardContent>
        </Card>

        <p className="mt-auto text-[11px] text-muted-foreground">
          提示：只有 pages/ 目录下的组件会被注入 data-node-id；components/ 与 src/ 不会。
        </p>
      </aside>

      {/* 右侧：页面预览 */}
      <main className="min-w-0 flex-1 overflow-auto p-6" onClick={handleClick}>
        {page === 'dashboard' ? <Dashboard /> : <Users />}
      </main>

      <Toaster />
    </div>
  );
}
