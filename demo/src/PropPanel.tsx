import { useCallback, useEffect, useState } from 'react';
import {
  Code2Icon,
  CopyIcon,
  ClipboardPasteIcon,
  PlusIcon,
  Redo2Icon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import {
  loadCatalog,
  NodeSourceInfo,
  SchemaDoc,
  SchemaPropDoc,
  CatComp,
  pageApi,
  nodeApi,
  clipboardApi,
  addChildToPageRoot,
} from './editorApi';

type ValueMode = 'literal' | 'expr';

function stripBraces(t?: string) {
  return (t ?? '').replace(/^\{\s*/, '').replace(/\s*}$/, '');
}

const EVENT_TEMPLATES: Array<[string, string]> = [
  ['onClick', "() => console.log('click')"],
  ['onChange', "(e) => console.log(e.target.value)"],
  ['onSubmit', "(e) => { e.preventDefault(); }"],
];

/** 把 JSON Schema 的属性对象变成有序行 */
function schemaList(doc: SchemaDoc | null) {
  if (!doc || !doc.properties) return [] as Array<{ key: string; spec: SchemaPropDoc; required: boolean }>;
  const order = doc['x-order'] ?? Object.keys(doc.properties);
  const required = doc.required ?? [];
  return order.map((key) => ({ key, spec: doc.properties[key] ?? {}, required: required.includes(key) }));
}

function coerceValue(key: string, raw: string, rows: Array<{ key: string; spec: SchemaPropDoc }>): unknown {
  if (raw === '') return '';
  const spec = rows.find((r) => r.key === key)?.spec;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (spec?.type === 'boolean') return raw === 'true';
  if (spec?.type === 'number' && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export default function PropPanel({
  page,
  selectedId,
  onSelectionChange,
}: {
  page: string;
  selectedId: string | null;
  onSelectionChange: (id: string | null) => void;
}) {
  const [node, setNode] = useState<NodeSourceInfo | null>(null);
  const [schema, setSchema] = useState<SchemaDoc | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formKeys, setFormKeys] = useState<string[]>([]);
  const [valueModes, setValueModes] = useState<Record<string, ValueMode>>({});
  const [busy, setBusy] = useState(false);
  const [undoable, setUndoable] = useState({ canUndo: false, canRedo: false });
  const [showSource, setShowSource] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [catalog, setCatalog] = useState<CatComp[]>([]);
  const [addName, setAddName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newMode, setNewMode] = useState<ValueMode>('literal');
  const [hasClipboard, setHasClipboard] = useState(false);
  const [childrenSource, setChildrenSource] = useState('');
  const [elementChildren, setElementChildren] = useState<NodeSourceInfo['elementChildren']>([]);

  const notify = (m: string, t: 'success' | 'error' | 'info' = 'success') =>
    toast.add({ type: t, title: t === 'error' ? '操作失败' : t === 'info' ? '提示' : '成功', description: m });

  const refreshHistory = useCallback(async () => {
    try {
      setUndoable(await pageApi(page).history());
    } catch {
      /* ignore */
    }
  }, [page]);

  useEffect(() => {
    if (!selectedId) {
      setNode(null);
      setSchema(null);
      setForm({});
      setFormKeys([]);
      setValueModes({});
      setChildrenSource('');
      setElementChildren([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const info = (await nodeApi(selectedId).get()) as NodeSourceInfo;
        if (cancelled) return;
        setNode(info);
        setSchema(info.schema ?? null);
        setChildrenSource(info.childrenValue ?? '');
        setElementChildren(info.elementChildren ?? []);

        const init: Record<string, string> = {};
        const modes: Record<string, ValueMode> = {};
        for (const p of info.props) {
          if (p.name === 'children') continue; // children 走源码编辑
          if (p.type === 'literal' && p.value !== undefined) {
            init[p.name] = String(p.value);
            modes[p.name] = 'literal';
          } else if (p.type === 'boolean') {
            init[p.name] = 'true';
            modes[p.name] = 'literal';
          } else if (p.type === 'expression') {
            init[p.name] = stripBraces(p.valueText);
            modes[p.name] = 'expr';
          }
        }
        setForm(init);
        setFormKeys(Object.keys(init));
        setValueModes(modes);

        try {
          const clip = await clipboardApi.check();
          setHasClipboard(!!clip.has);
        } catch {
          setHasClipboard(false);
        }
      } catch (e: any) {
        notify(e.message, 'error');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, page]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const ensureCatalog = async () => {
    if (catalog.length === 0) setCatalog(await loadCatalog().catch(() => []));
  };

  const afterWrite = async (message: string, newId?: string) => {
    notify(message);
    await refreshHistory();
    onSelectionChange(newId ?? null);
  };

  const save = async () => {
    if (!node) return;
    const rows = schemaList(schema);
    const changes: any[] = [];
    for (const key of Object.keys(form)) {
      if (valueModes[key] === 'expr') {
        if (form[key] === '') changes.push({ name: key, remove: true });
        else changes.push({ name: key, type: 'expression', value: form[key] });
      } else {
        changes.push({ name: key, value: coerceValue(key, form[key], rows) });
      }
    }
    for (const key of formKeys) {
      if (!(key in form) && key !== 'className') changes.push({ name: key, remove: true });
    }
    setBusy(true);
    try {
      const data = (await nodeApi(node.nodeId).postProps(changes)) as { nodeId: string };
      await afterWrite(`已保存 ${changes.length} 个属性`, data.nodeId);
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveChildrenSource = async () => {
    if (!node) return;
    setBusy(true);
    try {
      const data = (await nodeApi(node.nodeId).postChildrenSource(childrenSource)) as { nodeId: string };
      notify(childrenSource.trim() ? 'children 已更新' : 'children 已清空');
      onSelectionChange(data.nodeId ?? null);
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const drillInto = (childId: string) => onSelectionChange(childId);

  const removeChild = async (childId: string) => {
    setBusy(true);
    try {
      await nodeApi(childId).remove();
      notify('已移除该子节点');
      onSelectionChange(null);
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!node) return;
    setBusy(true);
    try {
      await nodeApi(node.nodeId).remove();
      setConfirmDel(false);
      await afterWrite('节点已删除');
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doUndoRedo = async (mode: 'undo' | 'redo') => {
    setBusy(true);
    try {
      if (mode === 'undo') await pageApi(page).undo();
      else await pageApi(page).redo();
      notify(mode === 'undo' ? '已撤销' : '已重做');
      onSelectionChange(null);
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    if (!node) return;
    try {
      await clipboardApi.copy(node.nodeId);
      setHasClipboard(true);
      notify('已复制到剪贴板');
    } catch (e: any) {
      notify(e.message, 'error');
    }
  };

  const doPaste = async () => {
    try {
      const data = await clipboardApi.paste({ page, parentNodeId: selectedId || undefined });
      await afterWrite('已粘贴', data.nodeId);
    } catch (e: any) {
      notify(e.message, 'error');
    }
  };

  const doAdd = async (name?: string, file?: string) => {
    const picked = catalog.find((c) => c.name === (name || addName));
    const cf = file || picked?.file;
    const cn = name || addName;
    if (!cn || !cf) {
      notify('请先选择要插入的组件', 'error');
      return;
    }
    setBusy(true);
    try {
      const data = selectedId
        ? ((await nodeApi(selectedId).postChild({ nodeName: cn, nodeFile: cf, props: [] })) as { nodeId: string })
        : await addChildToPageRoot(page, { nodeName: cn, nodeFile: cf, props: [] });
      setAddName('');
      await afterWrite(`已插入 ${cn}`, data.nodeId);
    } catch (e: any) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addProp = () => {
    if (!newKey.trim()) return;
    setForm((f) => ({ ...f, [newKey.trim()]: newVal }));
    setValueModes((prev) => ({ ...prev, [newKey.trim()]: newMode }));
    setFormKeys((prev) => (prev.includes(newKey.trim()) ? prev : [...prev, newKey.trim()]));
    setNewKey('');
    setNewVal('');
    setNewMode('literal');
  };

  const removeProp = (key: string) => {
    setForm((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setFormKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const rows = schemaList(schema);
  const keyList = Array.from(new Set([...rows.map((r) => r.key), ...Object.keys(form)]));

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader className="flex-none py-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          属性编辑
          {node && <Badge className="ml-1 text-[10px]">{node.componentName || `<${node.tag}>`}</Badge>}
        </CardTitle>
        <CardDescription className="text-[11px]">
          {node
            ? node.componentFile
              ? `${node.componentFile} · 组件属性（node 已内嵌 JSON Schema）`
              : `原生元素 <${node.tag}>（页面内）`
            : '点击右侧页面元素进行编辑'}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto pb-4">
        {!node ? (
          <p className="p-2 text-xs text-muted-foreground">
            未选中节点。点击右侧预览页中的任意组件/元素即可编辑属性、children、插入/删除或查看代码。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <Button size="xs" variant="outline" onClick={() => doUndoRedo('undo')} disabled={!undoable.canUndo}>
                <Undo2Icon />
                撤销
              </Button>
              <Button size="xs" variant="outline" onClick={() => doUndoRedo('redo')} disabled={!undoable.canRedo}>
                <Redo2Icon />
                重做
              </Button>
              <Button size="xs" variant="outline" onClick={doCopy}>
                <CopyIcon />
                复制
              </Button>
              <Button size="xs" variant="outline" onClick={doPaste} disabled={!hasClipboard}>
                <ClipboardPasteIcon />
                粘贴
              </Button>
              <Button size="xs" variant="outline" onClick={() => setShowSource(true)}>
                <Code2Icon />
                代码
              </Button>
              <Button size="xs" variant="destructive" onClick={() => setConfirmDel(true)}>
                <Trash2Icon />
              </Button>
            </div>

            <Separator />

            {/* 属性列表（含表达式支持） */}
            <div className="flex flex-col gap-1.5">
              {keyList.map((key) => {
                const row = rows.find((r) => r.key === key);
                const sp = row?.spec;
                const isEnum = !!sp?.enum?.length;
                const isBool = sp?.type === 'boolean' || form[key] === 'true' || form[key] === 'false';
                const mode = valueModes[key] ?? 'literal';
                const removed = !(key in form);
                return (
                  <div key={key} className="flex items-center gap-2">
                    <div className="w-28 shrink-0">
                      <div className="flex items-center gap-1 text-xs font-medium">
                        {key}
                        {row?.required ? <span className="text-destructive">*</span> : null}
                        {mode === 'expr' && !isEnum && !isBool ? (
                          <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700">expr</span>
                        ) : null}
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {isEnum ? 'enum' : sp?.type ?? (mode === 'expr' ? 'expression' : 'any')}
                        {sp?.default !== undefined ? ` =${String(sp.default)}` : ''}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      {!removed && (isEnum || isBool) ? (
                        isEnum ? (
                          <select
                            className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
                            value={form[key]}
                            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                          >
                            {sp!.enum!.map((v) => (
                              <option key={String(v)} value={String(v)}>
                                {String(v)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <select
                            className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
                            value={form[key] ?? 'true'}
                            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        )
                      ) : (
                        <>
                          <select
                            className="h-7 w-14 shrink-0 rounded-md border bg-background px-1 text-[10px]"
                            value={mode}
                            onChange={(e) => setValueModes((prev) => ({ ...prev, [key]: e.target.value as ValueMode }))}
                            title="值模式：值 或 表达式（expression）"
                          >
                            <option value="literal">值</option>
                            <option value="expr">expr</option>
                          </select>
                          {!removed &&
                            (mode === 'expr' ? (
                              <Input
                                className="h-7 min-w-0 flex-1 font-mono text-xs"
                                value={form[key] ?? ''}
                                placeholder={'如 () => save() / { "type": "Literal", ... }'}
                                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                              />
                            ) : (
                              <Input
                                className="h-7 min-w-0 flex-1 text-xs"
                                value={form[key] ?? ''}
                                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                              />
                            ))}
                        </>
                      )}
                    </div>
                    <Button variant="ghost" size="icon-xs" disabled={key === 'className'} onClick={() => removeProp(key)} title="删除属性">
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
              {keyList.length === 0 && <p className="text-xs text-muted-foreground">没有可编辑属性，可用下方“新增属性”添加。</p>}
            </div>

            {/* 新增属性 */}
            <div className="flex items-end gap-1.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <Label className="text-[10px]">属性名</Label>
                <Input className="h-7 text-xs" placeholder="variant / onClick / className" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              </div>
              <div className="w-20 shrink-0">
                <Label className="text-[10px]">类型</Label>
                <select
                  className="h-7 w-full rounded-md border bg-background px-1 text-[10px]"
                  value={newMode}
                  onChange={(e) => setNewMode(e.target.value as ValueMode)}
                >
                  <option value="literal">值</option>
                  <option value="expr">expr</option>
                </select>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <Label className="text-[10px]">属性值 / 表达式</Label>
                <Input className="h-7 text-xs" placeholder="值或 () => …" value={newVal} onChange={(e) => setNewVal(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" onClick={addProp}>
                <PlusIcon />
                添加
              </Button>
            </div>
            {keyList.some((k) => k.startsWith('on')) && (
              <div className="flex flex-wrap gap-1">
                {EVENT_TEMPLATES.map(([k, v]) => (
                  <Button
                    key={k}
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setValueModes((prev) => ({ ...prev, [k]: 'expr' }));
                      setForm((f) => ({ ...f, [k]: v }));
                    }}
                  >
                    {k} 模板
                  </Button>
                ))}
              </div>
            )}

            <Separator />

            {/* children（特殊属性：源码级编辑） */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">children（源码）</span>
                {(elementChildren?.length ?? 0) > 0 && (
                  <span className="text-[10px] text-muted-foreground">含 {elementChildren!.length} 个子元素，可下钻/删除</span>
                )}
              </div>
              <textarea
                className="h-20 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
                value={childrenSource}
                onChange={(e) => setChildrenSource(e.target.value)}
                placeholder={'可包含文本 / JSX 表达式 / ReactNode 片段，如 <b>bold</b>{count} 或留空清空'}
              />
              <Button size="sm" variant="outline" className="self-start" onClick={saveChildrenSource} disabled={busy}>
                保存 children
              </Button>
              {elementChildren && elementChildren.length > 0 && (
                <div className="flex flex-col gap-1">
                  {elementChildren.map((c, i) => (
                    <div key={i} className="flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1">
                      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs">
                        <span className="text-muted-foreground">{'<'}</span>
                        <span className="truncate">{c.componentName || c.tag}</span>
                        <span className="text-muted-foreground">{'>'}</span>
                        {c.componentFile && (
                          <span className="max-w-40 truncate font-mono text-[9px] text-muted-foreground">{c.componentFile}</span>
                        )}
                      </span>
                      <button className="rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10" onClick={() => drillInto(c.nodeId)}>
                        编辑
                      </button>
                      <button className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10" onClick={() => removeChild(c.nodeId)}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* 组件库插入 */}
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1" onClick={ensureCatalog}>
                插入组件…
              </Button>
              <Button size="sm" disabled={busy} onClick={save}>
                保存属性
              </Button>
            </div>
            {catalog.length > 0 && (
              <div className="flex max-h-36 flex-wrap gap-1 overflow-auto rounded-md border p-1.5">
                {catalog.map((c) => (
                  <div
                    key={c.name}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ name: c.name, file: c.file }))}
                    className="cursor-grab rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] hover:bg-muted"
                  >
                    <button type="button" onClick={() => doAdd(c.name, c.file)}>
                      {c.name}
                    </button>
                    <span className="ml-1 text-[9px] text-muted-foreground">{c.file.replace(/^src\/components\//, '')}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={showSource} onOpenChange={setShowSource}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>节点源码</DialogTitle>
            <DialogDescription>
              {node?.file} · {node ? `${node.startLine}:${node.startCol}` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">{node?.source ?? ''}</pre>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除该节点？</AlertDialogTitle>
            <AlertDialogDescription>将把选中节点从页面源码中移除（可通过撤销恢复）。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
