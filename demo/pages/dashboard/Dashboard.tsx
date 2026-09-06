import { useState } from 'react';
import { ActivityIcon, AlertTriangleIcon, CpuIcon, PlusIcon, RefreshCwIcon, ServerIcon, WifiIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import Clock from '../../components/Clock';
type DeviceStatus = 'online' | 'offline' | 'warning';
interface Device {
  id: number;
  name: string;
  model: string;
  site: string;
  status: DeviceStatus;
}
const initialDevices: Device[] = [{ id: 1, name: '空压机 A-01', model: 'GA-37VSD', site: '一号车间', status: 'online' }, { id: 2, name: '循环泵 B-02', model: 'ISG80-160', site: '一号车间', status: 'warning' }, { id: 3, name: '空压机 A-03', model: 'GA-55VSD', site: '二号车间', status: 'online' }, { id: 4, name: '冷却塔 C-01', model: 'CT-200', site: '动力站', status: 'offline' }, { id: 5, name: '配电柜 D-01', model: 'GGD-800', site: '二号车间', status: 'online' }];
const statusMap: Record<DeviceStatus, {
  label: string;
  cls: string;
  dot: string;
}> = { online: { label: '在线', cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' }, warning: { label: '告警', cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' }, offline: { label: '离线', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400' } };
const stats = [{ key: 'devices', title: '在线设备', value: '1,284', trend: '+12.4%', up: true, icon: WifiIcon }, { key: 'alerts', title: '今日告警', value: '36', trend: '-8.1%', up: false, icon: AlertTriangleIcon }, { key: 'energy', title: '今日能耗', value: '8.6 MWh', trend: '+3.2%', up: true, icon: ActivityIcon }, { key: 'uptime', title: '系统可用率', value: '99.98%', trend: '+0.01%', up: true, icon: CpuIcon }];
export default function Dashboard() {
  const [tab, setTab] = useState('overview');
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  // 添加设备弹窗
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: '', model: '', site: '' });
  const openAddDialog = () => {
    setForm({ name: '', model: '', site: '' });
    setDialogOpen(true);
  };
  const submitAdd = () => {
    if (!form.name.trim()) {
      toast.add({ type: 'warning', title: '设备名称不能为空', description: '请填写设备名称后再提交。' });
      return;
    }
    setDevices((prev) => [...prev, { id: Date.now(), name: form.name.trim(), model: form.model.trim() || '未填写型号', site: form.site.trim() || '未分配位置', status: 'online' }]);
    toast.add({ type: 'success', title: '设备已添加', description: `${form.name.trim()} 已加入设备列表。` });
    setDialogOpen(false);
  };
  const fakeRefresh = () => {
    toast.add({ type: 'info', title: '数据刷新中', description: '演示环境：仅更新了时间戳。' });
  };
  return (<div className="mx-auto flex max-w-6xl flex-col gap-6">
      {}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">设备总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            pages/dashboard/Dashboard.tsx · 点击任意元素可查看 data-node-id
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Clock label="服务器时间" />
          <Separator orientation="vertical" className="h-6" />
          <Button variant="outline" size="sm" onClick={fakeRefresh}>
            <RefreshCwIcon />
            刷新
          </Button>
          <Button size="sm" onClick={openAddDialog}>
            <PlusIcon />
            添加设备
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="devices">设备列表</TabsTrigger>
        </TabsList>

        {}
        <TabsContent value="overview" className="flex flex-col gap-4">
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((s) => (<Card key={s.key}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <s.icon className="size-4" />
                    {s.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-2">
                  <div className="text-2xl tracking-tight border border-solid border-slate-500 shadow-lg rounded-md p-2 font-extrabold text-center text-blue-500 bg-amber-500">{s.value}</div>
                </CardContent>
                <CardFooter>
                  <Badge variant={s.up ? 'secondary' : 'destructive'} className={s.up ? 'bg-emerald-100 text-emerald-700' : ''}>
                    {s.trend}
                  </Badge>
                  <span className="ml-2 text-xs text-muted-foreground">较昨日</span>
                </CardFooter>
              </Card>))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>近 7 日运行趋势</CardTitle>
              <CardDescription>折线数据来自页面静态示例，仅用于演示</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex h-40 items-end gap-3">
                {[42, 58, 49, 72, 65, 88, 76].map((h, i) => (<div key={i} className="flex flex-1 flex-col items-center gap-2">
                    <div className="w-full rounded-md bg-gradient-to-t from-primary/70 to-primary" style={{ height: `${h}%` }} />
                    <span className="text-xs text-muted-foreground">
                      {['一', '二', '三', '四', '五', '六', '日'][i]}
                    </span>
                  </div>))}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                  </div></div>
            </CardContent>
          </Card>
        </TabsContent>

        {}
        <TabsContent value="devices" className="flex flex-col gap-3">
          {devices.map((d) => {
    const st = statusMap[d.status];
    return (<Card key={d.id}>
                <CardContent className="flex items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {d.status === 'online' ? (<WifiIcon className="size-4 text-emerald-600" />) : d.status === 'warning' ? (<AlertTriangleIcon className="size-4 text-amber-600" />) : (<ServerIcon className="size-4 text-slate-400" />)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{d.name}</span>
                        <Badge className={st.cls}>
                          <span className={`size-1.5 rounded-full ${st.dot}`} />
                          {st.label}
                        </Badge>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {d.model} · {d.site}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => toast.add({ type: 'info', title: d.name, description: `演示环境未连接真实设备（型号 ${d.model}）。` })}>
                    详情
                  </Button>
                </CardContent>
              </Card>);
  })}
        </TabsContent>
      </Tabs>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加设备</DialogTitle>
            <DialogDescription>填写设备基本信息，保存后即出现在设备列表中。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-name">设备名称 *</Label>
              <Input id="device-name" placeholder="例如：空压机 A-04" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-model">设备型号</Label>
              <Input id="device-model" placeholder="例如：GA-75VSD" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-site">安装位置</Label>
              <Input id="device-site" placeholder="例如：三号车间" value={form.site} onChange={(e) => setForm((f) => ({ ...f, site: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={submitAdd}>
              <PlusIcon />
              保存设备
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>);
}