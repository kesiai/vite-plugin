// demo 编辑器与共享 API 客户端
export const PAGES = [
  { label: 'dashboard/Dashboard', value: 'dashboard/Dashboard' },
  { label: 'users/Users', value: 'users/Users' },
];

export interface ApiError {
  code: string;
  message: string;
  detail?: unknown;
}

interface ApiResp<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: ApiResp<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error(`[HTTP ${res.status}] 响应不是合法 JSON`);
  }
  if (!json.success || json.error) {
    throw new Error(`[${json.error?.code ?? 'ERROR'}] ${json.error?.message ?? `HTTP ${res.status}`}`);
  }
  return json.data as T;
}

export type CatComp = { name: string; file: string; schemaKeys?: string };

export async function loadCatalog(): Promise<CatComp[]> {
  const comps = await api<Array<{ name: string; filePath: string }>>('/__editor/components');
  const locals = comps.filter(
    (c) =>
      (c.filePath.startsWith('src/components/') || c.filePath.startsWith('components/')) &&
      !c.filePath.startsWith('pages/') &&
      !c.filePath.startsWith('src/App')
  );
  const seen = new Set<string>();
  return locals
    .map((c) => ({ name: c.name, file: c.filePath }))
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

export interface TreeEl {
  kind: 'element' | 'text';
  tag: string;
  id?: string;
  componentName?: string;
  componentFile?: string;
  attrs?: Array<{ name: string; kind: string }>;
  children?: TreeEl[];
  text?: string;
}

export interface SchemaProp {
  key: string;
  type: string;
  required?: boolean;
  defaultValue?: unknown;
  defaultRaw?: string;
  options?: Array<{ value: unknown; label: string }>;
}

export interface NodeSourceInfo {
  nodeId: string;
  file: string;
  tag: string;
  componentName?: string;
  componentFile?: string;
  source: string;
  startLine: number;
  startCol: number;
  props: Array<{
    /** 属性名；children 是特殊属性（type='children'） */
    name: string;
    /** 值类型：literal | boolean | expression | children | spread */
    type: string;
    value?: unknown;
    valueText?: string;
    ast?: unknown;
    childrenValue?: string;
  }>;
  /** children 完整源码（顶层快捷字段） */
  childrenValue?: string;
  /** 直接子 JSX 元素摘要（供下钻/删除） */
  elementChildren?: Array<{
    kind: 'element';
    nodeId: string;
    tag: string;
    componentName?: string;
    componentFile?: string;
  }>;
  /** 组件节点内嵌的 JSON Schema（服务端已附带，无需单独请求） */
  schema?: SchemaDoc;
}

/** JSON Schema 中单个属性描述 */
export interface SchemaPropDoc {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  'x-type'?: string;
}

/** 组件 props 的 JSON Schema */
export interface SchemaDoc {
  $schema?: string;
  type: 'object';
  title?: string;
  properties: Record<string, SchemaPropDoc>;
  required?: string[];
  'x-component'?: { name: string; file: string; exportKind: string };
  'x-order'?: string[];
}

export type SchemaProp = SchemaPropDoc & { key: string };

// ==================== REST 客户端封装 ====================

export const pageApi = (pageFile: string) => ({
  tree: () => api(`/__editor/pages/${pageFile}/tree`),
  history: () => api(`/__editor/pages/${pageFile}/history`),
  undo: () => api(`/__editor/pages/${pageFile}/undo`, {}, 'POST'),
  redo: () => api(`/__editor/pages/${pageFile}/redo`, {}, 'POST'),
});

export const nodeApi = (nodeId: string) => ({
  get: () => api(`/__editor/node/${nodeId}`),
  schema: () => api(`/__editor/node/${nodeId}/schema`),
  // 修改类统一 POST（兼容只支持 GET/POST 的服务器/代理）
  postProps: (props: unknown[]) => api(`/__editor/node/${nodeId}/props`, { props }, 'POST'),
  postChildrenSource: (source: string) => api(`/__editor/node/${nodeId}/children/source`, { source }, 'POST'),
  /** 兼容旧字段：文本即 children 源码 */
  postChildrenText: (text: string) => api(`/__editor/node/${nodeId}/children/source`, { source: text }, 'POST'),
  postChild: (comp: { nodeName: string; nodeFile: string; props?: unknown[]; childrenText?: string }) =>
    api(`/__editor/node/${nodeId}/children`, comp, 'POST'),
  remove: () => api(`/__editor/node/${nodeId}`, {}, 'DELETE'),
});

export function addChildToPageRoot(
  pageFile: string,
  comp: { nodeName: string; nodeFile: string; props?: unknown[] }
) {
  return api(`/__editor/pages/${pageFile}/children`, comp, 'POST');
}

export async function componentSchemaOf(file: string, name: string) {
  const q = new URLSearchParams({ nodeFile: file, nodeName: name });
  return api(`/__editor/component-schemas?${q.toString()}`);
}

export const clipboardApi = {
  check: () => api<{ has: boolean; file?: string | null; tag?: string | null }>('/__editor/clipboard'),
  copy: (nodeId: string) => api('/__editor/clipboard', { nodeId }, 'POST'),
  paste: (payload: { page?: string; parentNodeId?: string }) =>
    api<{ nodeId: string }>('/__editor/clipboard/apply', payload, 'POST'),
};

