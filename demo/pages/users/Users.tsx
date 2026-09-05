import { useMemo, useState } from 'react';
import { PencilIcon, SearchIcon, Trash2Icon, UserRoundIcon } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import Clock from "../../components/Clock";
interface User {
  id: number;
  name: string;
  role: string;
  city: string;
  email: string;
  online: boolean;
}
const initialUsers: User[] = [{ id: 1, name: '张伟', role: '运维工程师', city: '北京', email: 'zhangwei@kesi.local', online: true }, { id: 2, name: '李娜', role: '平台管理员', city: '上海', email: 'lina@kesi.local', online: true }, { id: 3, name: '王强', role: '数据分析师', city: '深圳', email: 'wangqiang@kesi.local', online: false }, { id: 4, name: '赵敏', role: '设备巡检员', city: '成都', email: 'zhaomin@kesi.local', online: true }, { id: 5, name: '陈晨', role: '安全审计员', city: '武汉', email: 'chenchen@kesi.local', online: false }];
export default function Users() {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [keyword, setKeyword] = useState('');
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return users;
    return users.filter((u) => [u.name, u.role, u.city, u.email].some((v) => v.toLowerCase().includes(kw)));
  }, [users, keyword]);
  const confirmDelete = () => {
    if (!pendingDelete) return;
    setUsers((prev) => prev.filter((u) => u.id !== pendingDelete.id));
    toast.add({ type: 'success', title: '已删除用户', description: `${pendingDelete.name} 已从列表中移除（演示）。` });
    setPendingDelete(null);
  };
  const editDemo = (u: User) => {
    toast.add({ type: 'info', title: u.name, description: '编辑功能为演示占位，未真正保存。' });
  };
  return (<div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">用户与权限</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            pages/users/Users.tsx · 搜索 / 删除均调用 shadcn/ui 组件
          </p>
        </div>
        <Badge className="gap-1.5">
          <span className="size-1.5 rounded-full bg-current" />
          共 {users.length} 人
        </Badge>
      </header>

      {}
      <Card>
        <CardContent className="py-3">
          <div className="flex items-center gap-3">
            <Label htmlFor="user-search" className="sr-only">
              搜索用户
            </Label>
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="user-search" className="pl-8" placeholder="按姓名 / 角色 / 城市 / 邮箱搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => {
    setKeyword('');
    toast.add({ type: 'info', title: '已清空搜索条件' });
  }}>
              重置
            </Button>
          </div>
        </CardContent>
      <Clock label="服务器时间" className="p-4" /></Card>

      {filtered.length === 0 ? (<Empty className="min-h-64">
          <EmptyMedia>
            <SearchIcon className="size-8" />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>未找到匹配用户</EmptyTitle>
            <EmptyDescription>
              没有与「{keyword.trim()}」匹配的用户，请尝试更换关键词。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setKeyword('')}>
              清空搜索
            </Button>
          </EmptyContent>
        </Empty>) : (<div className="flex flex-col gap-3">
          {filtered.map((u) => (<Card key={u.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <UserRoundIcon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{u.name}</span>
                      <Badge variant={u.online ? 'default' : 'secondary'} className={u.online ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : undefined}>
                        <span className={`size-1.5 rounded-full ${u.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                        {u.online ? '在线' : '离线'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {u.role} · {u.city} · {u.email}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="lg" onClick={() => editDemo(u)}>
                    <PencilIcon />
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPendingDelete(u)}>
                    <Trash2Icon />
                    删除
                  </Button>
                </div>
              </CardContent>
            </Card>))}
        </div>)}

      <Separator />
      <p className="text-xs text-muted-foreground">
        删除操作使用 AlertDialog 确认，操作结果通过 Toast 反馈。
      </p>

      {}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除用户？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.name}（{pendingDelete?.role}）将被移出列表，该操作仅在本演示中生效，
              不会真正修改后端数据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              <Trash2Icon />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>);
}