/**
 * 页面编辑历史（内存，单 dev server 生命周期）。
 * 每次写文件前把“旧文本”入栈；undo 把当前文本压入 redo 栈并回退；redo 反向。
 */
export class PageHistory {
  private readonly max: number;
  private past = new Map<string, string[]>();
  private future = new Map<string, string[]>();

  constructor(max = 50) {
    this.max = max;
  }

  /** 在一次修改前调用：记录当前快照 */
  push(rel: string, text: string): void {
    const stack = this.past.get(rel) ?? [];
    stack.push(text);
    if (stack.length > this.max) stack.shift();
    this.past.set(rel, stack);
    this.future.set(rel, []); // 新修改清空 redo
  }

  private pop(map: Map<string, string[]>): { rel: string; text: string } | null {
    for (const [rel, stack] of map) {
      const text = stack.pop();
      if (text !== undefined) {
        if (stack.length === 0) map.delete(rel);
        else map.set(rel, stack);
        return { rel, text };
      }
      map.delete(rel);
    }
    return null;
  }

  /** 当前文本推入 redo，返回上一个快照；无历史返回 null */
  undo(rel: string, currentText: string): string | null {
    const stack = this.past.get(rel);
    const prev = stack?.pop();
    if (prev === undefined) return null;
    if (stack && stack.length === 0) this.past.delete(rel);
    const redos = this.future.get(rel) ?? [];
    redos.push(currentText);
    this.future.set(rel, redos);
    return prev;
  }

  redo(rel: string, currentText: string): string | null {
    const stack = this.future.get(rel);
    const next = stack?.pop();
    if (next === undefined) return null;
    if (stack && stack.length === 0) this.future.delete(rel);
    const pasts = this.past.get(rel) ?? [];
    pasts.push(currentText);
    this.past.set(rel, pasts);
    return next;
  }

  canUndo(rel: string): boolean {
    return (this.past.get(rel)?.length ?? 0) > 0;
  }

  canRedo(rel: string): boolean {
    return (this.future.get(rel)?.length ?? 0) > 0;
  }

  stats(rel: string): { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number } {
    return {
      canUndo: this.canUndo(rel),
      canRedo: this.canRedo(rel),
      undoCount: this.past.get(rel)?.length ?? 0,
      redoCount: this.future.get(rel)?.length ?? 0,
    };
  }
}
