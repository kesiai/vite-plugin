import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from './editorApi';

type Method = 'GET' | 'POST' | 'DELETE';

interface Entry {
  label: string;
  method: Method;
  path: string;
  hint: string;
  pageParam?: boolean; // 自动替换 {page}
}

const ENTRIES: Entry[] = [
  { label: '页面列表', method: 'GET', path: '/__editor/pages', hint: '', pageParam: false },
  { label: '页面树', method: 'GET', path: '/__editor/pages/{page}/tree', hint: '', pageParam: true },
  { label: '页面源码', method: 'GET', path: '/__editor/pages/{page}', hint: '', pageParam: true },
  { label: '覆盖页面(POST)', method: 'POST', path: '/__editor/pages/{page}/content', hint: '{ "content": "<完整源码>" }', pageParam: true },
  { label: '页面历史', method: 'GET', path: '/__editor/pages/{page}/history', hint: '', pageParam: true },
  { label: '撤销', method: 'POST', path: '/__editor/pages/{page}/undo', hint: '{}', pageParam: true },
  { label: '重做', method: 'POST', path: '/__editor/pages/{page}/redo', hint: '{}', pageParam: true },
  { label: '新建页面', method: 'POST', path: '/__editor/pages', hint: '{ "path": "pages/new/NewPage" }', pageParam: false },
  { label: '删除页面', method: 'DELETE', path: '/__editor/pages/{page}', hint: '', pageParam: true },
  { label: '节点信息', method: 'GET', path: '/__editor/node/{nodeId}', hint: '', pageParam: false },
  { label: '节点 schema', method: 'GET', path: '/__editor/node/{nodeId}/schema', hint: '', pageParam: false },
  { label: '改属性(POST)', method: 'POST', path: '/__editor/node/{nodeId}/props', hint: '{ "props": [{ "name": "onClick", "type": "expression", "value": "() => save()" }] }', pageParam: false },
  { label: '改children(POST)', method: 'POST', path: '/__editor/node/{nodeId}/children/source', hint: '{ "source": "<b>bold</b>{n}" }', pageParam: false },
  { label: '插入子组件', method: 'POST', path: '/__editor/node/{nodeId}/children', hint: '{ "nodeName": "Badge", "nodeFile": "src/components/ui/badge.tsx" }', pageParam: false },
  { label: '页面根插入', method: 'POST', path: '/__editor/pages/{page}/children', hint: '{ "nodeName": "Badge", "nodeFile": "src/components/ui/badge.tsx" }', pageParam: true },
  { label: '删除节点', method: 'DELETE', path: '/__editor/node/{nodeId}', hint: '', pageParam: false },
  { label: '组件schema(查)', method: 'GET', path: '/__editor/component-schemas?nodeName=Button&nodeFile=src%2Fcomponents%2Fui%2Fbutton.tsx', hint: '', pageParam: false },
  { label: '剪贴板状态', method: 'GET', path: '/__editor/clipboard', hint: '', pageParam: false },
  { label: '复制到剪贴板', method: 'POST', path: '/__editor/clipboard', hint: '{ "nodeId": "node-..." }', pageParam: false },
  { label: '粘贴', method: 'POST', path: '/__editor/clipboard/apply', hint: '{ "parentNodeId": "node-..." }', pageParam: false },
  { label: '组件扫描', method: 'GET', path: '/__editor/components', hint: '', pageParam: false },
  { label: '运行状态', method: 'GET', path: '/__editor/status', hint: '', pageParam: false },
];

export default function ApiConsole() {
  const [page, setPage] = useState('dashboard/Dashboard');
  const [nodeId, setNodeId] = useState('');
  const [idx, setIdx] = useState(0);
  const [body, setBody] = useState('{}');
  const [out, setOut] = useState('REST 端点浏览器：选择接口 -> 替换参数 -> 发送');

  const entry = ENTRIES[idx];

  const buildUrl = (raw: string) =>
    raw.replaceAll('{page}', page).replaceAll('{nodeId}', nodeId || 'node-EMPTY');

  const call = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (e: any) {
      setOut(`[INVALID_JSON] ${e.message}`);
      return;
    }
    const hasBody = entry.method === 'POST' || entry.method === 'DELETE';
    try {
      const data = await api(buildUrl(entry.path), hasBody ? parsed : undefined, entry.method);
      setOut(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setOut(String(e.message));
    }
  };

  const choose = (i: number) => {
    setIdx(i);
    setBody(ENTRIES[i].hint || '{}');
  };

  return (
    <div className="grid h-full grid-cols-[300px_1fr] gap-4">
      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">REST /__editor 端点浏览器</CardTitle>
          <CardDescription className="text-xs">GET 查询 / POST 新增与修改 / DELETE 删除</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          <label className="text-xs font-medium">page（{'{page}'}）</label>
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={page} onChange={(e) => setPage(e.target.value)}>
            <option value="dashboard/Dashboard">dashboard/Dashboard</option>
            <option value="users/Users">users/Users</option>
          </select>
          <label className="text-xs font-medium">nodeId（{'{nodeId}'}）</label>
          <Input className="h-8 text-xs" value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="node-...（从节点资源或 data-node-id 复制）" />
          <label className="mt-1 text-xs font-medium">接口（点击选中）</label>
          <div className="flex flex-wrap gap-1">
            {ENTRIES.map((e, i) => (
              <Button key={i} size="xs" variant={idx === i ? 'default' : 'outline'} onClick={() => choose(i)}>
                {e.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BadgeInline method={entry.method} />
            <span className="font-mono text-xs">{buildUrl(entry.path)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
          <textarea
            className="h-28 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div>
            <Button size="sm" onClick={call}>
              {entry.method} 发送
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-4">{out}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

function BadgeInline({ method }: { method: Method }) {
  const color =
    method === 'GET'
      ? 'bg-emerald-100 text-emerald-700'
      : method === 'POST'
        ? 'bg-sky-100 text-sky-700'
        : 'bg-rose-100 text-rose-700';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${color}`}>{method}</span>;
}
