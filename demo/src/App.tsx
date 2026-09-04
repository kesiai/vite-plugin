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
    const target = e.target as HTMLElement;

    // “选中节点” = 最近的带 data-node-id 的元素（源码定位的锚点）
    const idEl = target.closest('[data-node-id]') as HTMLElement | null;
    if (!idEl) {
      setNodeInfo('该元素没有注入标记（可能来自 node_modules 内部渲染）');
      return;
    }

    const id = idEl.dataset.nodeId ?? '';
    const span = decodeNodeId(id);

    // 组件解析：以选中节点自身为准
    const name = idEl.dataset.nodeName ?? '';
    const file = idEl.dataset.nodeFile ?? '';
    const tag = idEl.tagName.toLowerCase();

    const parts: string[] = [];
    if (name) {
      // 有 data-node-name：自定义组件（Button、Card…）
      parts.push(`组件: ${name}  (${file})`);
    } else {
      // 无 data-node-name：原生元素（div、span…），直接显示 DOM tag 名
      parts.push(`元素: <${tag}>`);
    }
    if (span) parts.push(`定位: ${span.file}  [${span.startLine}:${span.startCol} ~ ${span.endLine}:${span.endCol}]`);
    parts.push(`id: ${id}`);
    setNodeInfo(parts.join('\n\n'));
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
            只有 pages/ 下的 JSX 会被编译期转换：每个元素注入 <code>data-node-id</code>，页面里用到的
            组件（Button/Card…）额外注入 <code>data-node-name / data-node-file</code>（组件定义文件）。
            点击元素即可查看。
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
          提示：只有 pages/ 目录下的文件会被转换并注入标记，其它目录的 tsx 不会。组件的
          name/file 标注需组件把 props 转发到自己的根 DOM 才会显示在真实节点上。
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
