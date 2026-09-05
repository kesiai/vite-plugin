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
import { api, loadCatalog, NodeSourceInfo, SchemaProp, CatComp, pageApi, nodeApi, clipboardApi, addChildToPageRoot, componentSchemaOf } from './editorApi';

function coerceValue(key: string, raw: string, schema: SchemaProp[] | null): unknown {
  if (raw === '') return '';
  const sp = schema?.find((x) => x.key === key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (sp?.type === 'boolean') return raw === 'true';
  if (sp?.type === 'number' && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

const EVENT_TEMPLATES: Array<[string, string]> = [
  ['onClick', "() => console.log('click')"],
  ['onChange', "(e) => console.log(e.target.value)"],
  ['onSubmit', "(e) => { e.preventDefault(); }"],
];

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
  const [schema, setSchema] = useState<SchemaProp[] | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formKeys, setFormKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [undoable, setUndoable] = useState({ canUndo: false, canRedo: false });
  const [showSource, setShowSource] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [catalog, setCatalog] = useState<CatComp[]>([]);
  const [addName, setAddName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newMode, setNewMode] = useState<'literal' | 'expr'>('literal');
  /** 每个属性键的值模式：literal（原值）或 expr（表达式） */
  const [valueModes, setValueModes] = useState<Record<string, 'literal' | 'expr'>>({});
  const [hasClipboard, setHasClipboard] = useState(false);
  const [childrenText, setChildrenText] = useState('');
  const [canEditText, setCanEditText] = useState(false);

  const notify = (m: string, t: 'success' | 'error' | 'info' = 'success') =>
    toast.add({ type: t, title: t === 'error' ? '操作失败' : t === 'info' ? '提示' : '成功', description: m });

  const refreshHistory = useCallback(async () => {
    try {
      setUndoable(await pageApi(page).history());
    } catch {
      /* ignore */
    }
  }, [page]);

  // 每次选中变化重新拉取节点信息 + schema
  useEffect(() => {
    if (!selectedId) {
      setNode(null);
      setSchema(null);
      setForm({});
      setFormKeys([]);
      setValueModes({});
      setChildrenText('');
      setCanEditText(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const info = (await nodeApi(selectedId).get()) as NodeSourceInfo;
        if (cancelled) return;
        setNode(info);
        setCanEditText(!!info.canEditText);
        if (info.canEditText) {
          const raw = (info.children ?? [])
            .filter((c) => c.kind === 'text')
            .map((c) => c.text ?? '')
            .join('');
          setChildrenText(raw);
        }
        const init: Record<string, string> = {};
        const modes: Record<string, 'literal' | 'expr'> = {};
        const stripBraces = (t?: string) =>
          (t ?? '').replace(/^\{\s*/, '').replace(/\s*\}$/, '');
        for (const p of info.props) {
          if (p.kind === 'literal' && p.value !== undefined) {
            init[p.name] = String(p.value);
            modes[p.name] = 'literal';
          } else if (p.kind === 'boolean') {
            init[p.name] = 'true';
            modes[p.name] = 'literal';
          } else if (p.kind === 'expression') {
            init[p.name] = stripBraces(p.valueText);
            modes[p.name] = 'expr';
          }
        }
        setForm(init);
        setFormKeys(Object.keys(init));
        setValueModes(modes);
        setSchema(null);
        if (info.componentName && info.componentFile) {
          try {
            const sc = await componentSchemaOf(info.componentFile, info.componentName);
            if (cancelled) return;
            setSchema(sc.properties);
            setForm((prev) => {
              const next = { ...prev };
              for (const p of sc.properties) {
                if (p.defaultValue !== undefined && next[p.key] === undefined && p.type !== 'boolean') {
                  next[p.key] = String(p.defaultValue);
                }
              }
              return next;
            });
          } catch {
            /* 无 schema 时自由编辑 */
          }
        }
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
    const changes: any[] = [];
    for (const key of Object.keys(form)) {
      if (valueModes[key] === 'expr') {
        if (form[key] === '') changes.push({ name: key, remove: true });
        else changes.push({ name: key, type: 'expr', value: form[key] });
      } else {
        changes.push({ name: key, value: coerceValue(key, form[key], schema) });
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

  const saveChildrenText = async () => {
    if (!node) return;
    setBusy(true);
    try {
      const data = (await nodeApi(node.nodeId).postChildrenText(childrenText)) as { nodeId: string };
      notify(childrenText ? 'children 文本已更新' : 'children 已清空');
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

  const removeProp = (key: string) => {
    setForm((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
    setFormKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
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
      const data = mode === 'undo' ? await pageApi(page).undo() : await pageApi(page).redo();
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

  const keyList = Array.from(new Set([...(schema?.map((p) => p.key) ?? []), ...Object.keys(form)]));

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
              ? `${node.componentFile} · 组件属性`
              : `原生元素 <${node.tag}>（页面内）`
            : '点击右侧页面元素进行编辑'}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto pb-4">
        {!node ? (
          <p className="p-2 text-xs text-muted-foreground">
            未选中节点。点击右侧预览页中的任意组件/元素即可在此编辑属性、插入/删除组件或查看代码。
          </p>
        ) : (
          <>
            {/* 操作条 */}
            <div className="flex flex-wrap items-center gap-1">
              <Button size="xs" variant="outline" onClick={doUndoRedo.bind(null, 'undo')} disabled={!undoable.canUndo} title="撤销">
                <Undo2Icon />
                撤销
              </Button>
              <Button size="xs" variant="outline" onClick={doUndoRedo.bind(null, 'redo')} disabled={!undoable.canRedo} title="重做">
                <Redo2Icon />
                重做
              </Button>
              <Button size="xs" variant="outline" onClick={doCopy} title="复制该组件">
                <CopyIcon />
                复制
              </Button>
              <Button size="xs" variant="outline" onClick={doPaste} disabled={!hasClipboard && !catalog.length} title="粘贴到选中节点（或页面根）">
                <ClipboardPasteIcon />
                粘贴
              </Button>
              <Button size="xs" variant="outline" onClick={() => setShowSource(true)} title="查看该节点源码">
                <Code2Icon />
                代码
              </Button>
              <Button size="xs" variant="destructive" onClick={() => setConfirmDel(true)} title="删除该节点">
                <Trash2Icon />
              </Button>
            </div>

            <Separator />

            <Separator />

            {/* children 编辑 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Children 内容</span>
                {node && !canEditText && (
                  <span className="text-[10px] text-muted-foreground">含 JSX 元素子节点：点击可下钻或移除</span>
                )}
              </div>
              {canEditText ? (
                <>
                  <textarea
                    className="h-16 w-full resize-y rounded-md border bg-background p-2 text-xs"
                    value={childrenText}
                    onChange={(e) => setChildrenText(e.target.value)}
                    placeholder="输入该组件的文本内容（空则移除 children）…"
                  />
                  <Button size="sm" variant="outline" className="self-start" onClick={saveChildrenText} disabled={busy}>
                    保存文本
                  </Button>
                </>
              ) : (
                (node?.children ?? []).length > 0 && (
                  <div className="flex flex-col gap-1">
                    {(node.children ?? [])
                      .filter((c) => c.kind === 'element')
                      .map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1">
                          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs">
                            <span className="text-muted-foreground">{'<'}</span>
                            <span className="truncate">{c.componentName || c.tag}</span>
                            <span className="text-muted-foreground">{'>'}</span>
                            {c.componentFile && (
                              <span className="max-w-40 truncate font-mono text-[9px] text-muted-foreground">
                                {c.componentFile}
                              </span>
                            )}
                          </span>
                          {c.nodeId && (
                            <>
                              <button
                                className="rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                                onClick={() => drillInto(c.nodeId!)}
                                title="下钻编辑该子节点"
                              >
                                编辑
                              </button>
                              <button
                                className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                                onClick={() => removeChild(c.nodeId!)}
                                title="移除该子节点"
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                  </div>
                )
              )}
            </div>

            {/* 属性表单 */}
            <div className="flex flex-col gap-1.5">
              {keyList.map((key) => {
                const sp = schema?.find((x) => x.key === key);
                const removed = !(key in form);
                const mode = valueModes[key] ?? 'literal';
                const setMode = (m: 'literal' | 'expr') =>
                  setValueModes((prev) => ({ ...prev, [key]: m }));
                const isEnum = !!sp?.options?.length;
                const isBool = sp?.type === 'boolean' || form[key] === 'true' || form[key] === 'false';
                return (
                  <div key={key} className="flex items-center gap-2">
                    <div className="w-28 shrink-0">
                      <div className="flex items-center gap-1 text-xs font-medium">
                        {key}
                        {sp?.required ? <span className="text-destructive">*</span> : null}
                        {mode === 'expr' && !isEnum && !isBool ? (
                          <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700">expr</span>
                        ) : null}
                      </div>
                      {sp && (
                        <div className="text-[9px] text-muted-foreground">
                          {isEnum ? 'enum' : sp.type}
                          {sp.defaultValue !== undefined ? ` =${String(sp.defaultValue)}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      {!removed && (isEnum || isBool) ? (
                        isEnum ? (
                          <select
                            className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
                            value={form[key]}
                            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                          >
                            {sp!.options!.map((o) => (
                              <option key={String(o.value)} value={String(o.value)}>
                                {o.label}
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
                            onChange={(e) => setMode(e.target.value as 'literal' | 'expr')}
                            title="值模式：值（普通输入）或表达式（字符串/AST 转表达式写回）"
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
              {keyList.length === 0 && <p className="text-xs text-muted-foreground">没有可编辑属性，用下方“新增属性”添加。</p>}
            </div>

            {/* 新增属性 + 事件模板 */}
            <div className="flex items-end gap-1.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <Label className="text-[10px]">属性名</Label>
                <Input className="h-7 text-xs" placeholder="variant / onClick / className" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              </div>
              <div className="w-20 shrink-0 flex-col">
                <Label className="text-[10px]">类型</Label>
                <select
                  className="h-7 w-full rounded-md border bg-background px-1 text-[10px]"
                  value={newMode}
                  onChange={(e) => setNewMode(e.target.value as 'literal' | 'expr')}
                >
                  <option value="literal">值</option>
                  <option value="expr">expr</option>
                </select>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <Label className="text-[10px]">属性值</Label>
                <Input className="h-7 text-xs" placeholder="值（字符串/true/false/数字）" value={newVal} onChange={(e) => setNewVal(e.target.value)} />
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
                    title={`填入模板：${v}`}
                  >
                    {k} 模板
                  </Button>
                ))}
              </div>
            )}

            <Separator />

            {/* 插入组件（拖拽或选择） */}
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                onClick={async () => {
                  await ensureCatalog();
                }}
              >
                插入组件…
              </Button>
              <Button size="sm" variant="default" disabled={busy} onClick={save}>
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
                    title={`拖到右侧页面元素上插入；或点选添加：${c.file}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAddName(c.name);
                        doAdd(c.name, c.file);
                      }}
                    >
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

      {/* 查看代码 */}
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

      {/* 删除确认 */}
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
