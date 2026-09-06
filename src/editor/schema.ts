import { EditorError, parseTsx, AnyNode, findNodes, unwrapExpr, collectBindings } from './common';
import { ResolveContext, resolveLocalModule, readProjectFile } from './paths';

/**
 * 组件属性 schema 生成器。
 * 输入组件名 + 组件文件，输出 JSON Schema 风格的属性描述，用于生成属性编辑表单：
 *   - 从函数参数解构（默认值）
 *   - 从本文件 interface/type（TS 类型注解，含字面量联合 -> enum）
 *   - 从 cva(...) 的 variants/defaultVariants（shadcn 变体）
 * 类型信息来自 yuku 解析出的 TS-ESTree AST。
 */

export interface PropSchema {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'function' | 'any' | 'unknown' | 'literal';
  required?: boolean;
  defaultValue?: unknown;
  defaultRaw?: string;
  options?: Array<{ value: unknown; label: string }>;
  items?: unknown;
  properties?: Record<string, unknown>;
  description?: string;
}

/** 每个属性的 JSON Schema 片段（extra keywords：x-type 保留原始语义、x-order 顶层提供） */
export type JsonPropSpec = Record<string, unknown>;

/** 组件 props 的 JSON Schema（Draft-07 风格；x-component/x-order 为扩展信息） */
export interface ComponentSchema {
  $schema: 'http://json-schema.org/draft-07/schema#';
  type: 'object';
  title?: string;
  description?: string;
  properties: Record<string, JsonPropSpec>;
  required?: string[];
  'x-component': { name: string; file: string; exportKind: 'named' | 'default' | 'member' };
  'x-order'?: string[];
}

// ============================ TS 类型 -> schema ============================

function typeNameOf(n: AnyNode): string {
  if (!n) return 'unknown';
  return n.type;
}

function resolveLiteralValue(n: AnyNode): { ok: boolean; value: unknown } {
  if (!n) return { ok: false, value: undefined };
  const node = unwrapExpr(n);
  if (node.type === 'Literal') return { ok: true, value: node.value };
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal') {
    return { ok: true, value: -(node.argument.value as number) };
  }
  if (node.type === 'TemplateLiteral') {
    return { ok: true, value: undefined };
  }
  return { ok: false, value: undefined };
}

function collectLiteralUnion(n: AnyNode): unknown[] | null {
  if (!n) return null;
  const node = unwrapExpr(n);
  if (node.type === 'TSUnionType') {
    const out: unknown[] = [];
    for (const member of node.types ?? []) {
      if (member.type === 'TSLiteralType') {
        const { ok, value } = resolveLiteralValue(member.literal);
        if (!ok) return null;
        out.push(value);
      } else if (member.type === 'TSStringKeyword' || member.type === 'TSNumberKeyword') {
        // 无界类型：返回 null 表示不是纯枚举
        return null;
      } else {
        return null;
      }
    }
    return out;
  }
  if (node.type === 'TSLiteralType') {
    const { ok, value } = resolveLiteralValue(node.literal);
    return ok ? [value] : null;
  }
  return null;
}

function literalTypeValue(n: AnyNode): unknown {
  const node = unwrapExpr(n);
  if (node.type === 'TSLiteralType') {
    const { ok, value } = resolveLiteralValue(node.literal);
    return ok ? value : undefined;
  }
  if (node.type === 'Literal') return node.value;
  return undefined;
}

/** 把 TS 类型节点转成基础类型 + 可选信息（只处理单文件可解析的） */
function tsTypeToPropType(n: AnyNode, lookupInterface: (name: string) => AnyNode | null): PropSchema['type'] | { kind: 'array'; items: unknown } | { kind: 'object'; properties: Record<string, PropSchema> } {
  const node = unwrapExpr(n);
  if (!node) return 'unknown';
  switch (node.type) {
    case 'TSStringKeyword':
    case 'TSNumberKeyword':
    case 'TSBooleanKeyword':
    case 'TSNullKeyword':
    case 'TSBigIntKeyword':
      return node.type === 'TSStringKeyword' ? 'string' : node.type === 'TSNumberKeyword' ? 'number' : node.type === 'TSBooleanKeyword' ? 'boolean' : 'literal';
    case 'TSUnknownKeyword':
    case 'TSAnyKeyword':
      return node.type === 'TSUnknownKeyword' ? 'unknown' : 'any';
    case 'TSFunctionType':
      return 'function';
    case 'TSArrayType':
      return { kind: 'array', items: tsTypeToPropType(node.elementType, lookupInterface) };
    case 'TSLiteralType':
      return 'literal';
    case 'TSUnionType': {
      const values = collectLiteralUnion(node);
      if (values) return 'enum';
      const kinds = new Set<string>();
      for (const m of node.types ?? []) {
        const t = tsTypeToPropType(m, lookupInterface);
        kinds.add(typeof t === 'string' ? t : t.kind);
      }
      if (kinds.size === 1) {
        const only = [...kinds][0];
        if (only === 'string' || only === 'number' || only === 'boolean') return only as PropSchema['type'];
      }
      return 'any';
    }
    case 'TSTypeReference': {
      const name = node.typeName?.name ?? node.typeName?.typeName?.name;
      if (typeof name === 'string') {
        const iface = lookupInterface(name);
        if (iface) {
          return { kind: 'object', properties: interfaceProps(iface, lookupInterface) };
        }
      }
      return 'any';
    }
    case 'TSTypeLiteral':
      return { kind: 'object', properties: interfaceProps(node, lookupInterface) };
    case 'TSParenthesizedType':
    case 'TSUnionOrIntersectionType':
      return tsTypeToPropType((node as any).typeAnnotation ?? node, lookupInterface);
    default:
      return 'unknown';
  }
}

function interfaceProps(iface: AnyNode, lookupInterface: (name: string) => AnyNode | null): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  for (const m of iface.body ?? []) {
    if (m.type === 'TSPropertySignature' || m.type === 'TSMethodSignature') {
      const key =
        m.key?.type === 'Identifier'
          ? m.key.name
          : m.key?.type === 'Literal'
            ? String(m.key.value)
            : null;
      if (!key) continue;
      const base = tsTypeToPropType(m.typeAnnotation?.typeAnnotation, lookupInterface);
      let prop: PropSchema = { key, label: key, type: 'unknown' };
      if (base && typeof base === 'object' && 'kind' in base) {
        if (base.kind === 'array') {
          prop = { ...prop, type: 'array', items: base.items };
        } else if (base.kind === 'object') {
          prop = { ...prop, type: 'object', properties: base.properties as Record<string, unknown> };
        }
      } else {
        prop = { ...prop, type: (base as PropSchema['type']) ?? 'unknown' };
        if (prop.type === 'enum') {
          const vals = collectLiteralUnion(m.typeAnnotation?.typeAnnotation);
          if (vals) prop.options = vals.map((v) => ({ value: v, label: String(v) }));
        }
      }
      prop.required = !m.optional;
      out[key] = prop;
    }
  }
  return out;
}

// ============================ 组件查找 ============================

interface ComponentFnHit {
  fn: AnyNode;
  exportKind: 'named' | 'default' | 'member';
}

function findComponentFn(program: AnyNode, name: string): ComponentFnHit | null {
  let namedHit: ComponentFnHit | null = null;

  const registerNamed = (fn: AnyNode | undefined, hit: ComponentFnHit) => {
    if (fn && !namedHit) namedHit = hit;
  };

  const fnFromDecl = (decl: AnyNode | null | undefined): AnyNode | null => {
    if (!decl) return null;
    if (decl.type === 'FunctionDeclaration') return decl;
    if (decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') return decl;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations ?? []) {
        if (d.id?.name === name) {
          const init = d.init;
          if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') return init;
          if (init?.type === 'CallExpression') return null;
          return null;
        }
      }
    }
    return null;
  };

  for (const stmt of program.body ?? []) {
    if (!stmt) continue;
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = fnFromDecl(stmt.declaration);
      if (decl && !namedHit) namedHit = { fn: decl, exportKind: 'named' };
      for (const spec of stmt.specifiers ?? []) {
        if (spec.type === 'ExportSpecifier' && (spec.local?.name === name || spec.exported?.name === name)) {
          // export { X }：X 是本地函数/变量
          const local = spec.local?.name;
          const target = findNodes(program, (n) =>
            (n?.type === 'FunctionDeclaration' || n?.type === 'VariableDeclarator') && n.id?.name === local
          );
          for (const { node } of target) {
            if (!namedHit) {
              const fn = node.type === 'VariableDeclarator' ? node.init : node;
              if (fn && (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression')) {
                namedHit = { fn, exportKind: 'named' };
              }
            }
          }
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      const fn = fnFromDecl(decl);
      const defaultName = fn?.id?.name ?? null;
      if (fn && (name === defaultName || name === 'default')) {
        return { fn, exportKind: 'default' };
      }
      if (decl?.type === 'Identifier' && decl.name === name) {
        const target = findNodes(program, (n) => (n?.type === 'VariableDeclarator') && n.id?.name === name);
        for (const { node } of target) {
          if (node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
            return { fn: node.init, exportKind: 'default' };
          }
        }
      }
    }
  }

  // 非 export 的本地大写函数/变量（兜底）
  if (!namedHit) {
    const targets = findNodes(
      program,
      (n) =>
        (n?.type === 'FunctionDeclaration' || n?.type === 'VariableDeclarator') &&
        n.id?.name === name
    );
    for (const { node } of targets) {
      if (namedHit) break;
      const fn = node.type === 'VariableDeclarator' ? node.init : node;
      if (fn && (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression')) {
        namedHit = { fn, exportKind: 'member' };
      }
    }
  }

  registerNamed(namedHit?.fn, namedHit as ComponentFnHit);
  return namedHit;
}

// ============================ 参数解析 ============================

function extractDefault(raw: string, right: AnyNode | undefined): { defaultValue?: unknown; defaultRaw?: string } {
  const out: { defaultValue?: unknown; defaultRaw?: string } = {};
  if (!right) return out;
  out.defaultRaw = right.start != null && right.end != null ? raw.slice(right.start, right.end) : undefined;
  const { ok, value } = resolveLiteralValue(right);
  if (ok && value !== undefined) out.defaultValue = value;
  return out;
}

/**
 * 生成组件属性 schema。
 * @param fileText 组件文件源码
 * @param fileRel  组件文件相对项目根路径
 * @param nodeName 组件名（导出名）
 */
export function componentSchema(fileText: string, fileRel: string, nodeName: string, context?: ResolveContext): ComponentSchema {
  const program = parseTsx(fileText, fileRel);
  const hit = findComponentFn(program, nodeName);
  if (!hit) {
    throw new EditorError(
      'COMPONENT_NOT_FOUND',
      `在 ${fileRel} 中找不到组件「${nodeName}」`,
      404
    );
  }

  const raw = fileText;
  const remoteTypeBindings = collectBindings(program);
  const propsByName = new Map<string, PropSchema>();
  const order: string[] = [];

  const push = (key: string, partial: Partial<PropSchema>) => {
    if (!key) return;
    if (!order.includes(key)) order.push(key);
    const prev = propsByName.get(key) ?? { key, label: key, type: 'unknown' as const, required: false };
    const next: PropSchema = { ...prev, key, label: key, ...partial } as PropSchema;
    propsByName.set(key, next);
  };

  // interface/type 查找（本文件）
  const interfaceCache = new Map<string, AnyNode>();
  const lookupInterface = (name: string): AnyNode | null => {
    if (interfaceCache.has(name)) return interfaceCache.get(name)!;
    const hits = findNodes(
      program,
      (n) =>
        (n?.type === 'TSInterfaceDeclaration' || n?.type === 'TSTypeAliasDeclaration') &&
        n.id?.name === name
    );
    const found = hits[0]?.node ?? null;
    interfaceCache.set(name, found);
    return found;
  };

  // 1) 函数参数解构 + 内联类型/默认值
  const fn = hit.fn;
  const params: AnyNode[] = [];
  if (fn.type === 'FunctionDeclaration') {
    if (fn.params) params.push(...fn.params);
  } else if (fn.params) {
    params.push(...fn.params);
  } else if (fn.body?.type === 'BlockStatement') {
    params.push(...(fn.params ?? []));
  }
  const first = params[0];
  if (first) {
    if (first.type === 'Identifier' && first.typeAnnotation?.typeAnnotation) {
      // function X(props: XProps) → 用类型对象展开（支持本文件 / 跨文件类型）
      const tt = first.typeAnnotation.typeAnnotation;
      let refName: string | null = tt.typeName?.name ?? null;
      const remoteRef = tt.typeName?.type === 'TSQualifiedName';
      if (tt.typeName?.type === 'TSQualifiedName') {
        // ButtonPrimitive.Props 这类：取末段名字用于描述，属性按外部组件处理
        refName = tt.typeName.right?.name ?? null;
      }
      if (typeof refName === 'string' && !remoteRef) {
        let iface = lookupInterface(refName);
        if (!iface && context) {
          // 跨文件：类型通过 import 引入（含 type-only）
          const imported = remoteTypeBindings.get(refName);
          if (imported) {
            const compFile = resolveLocalModule(imported.source, fileRel, context);
            if (compFile) {
              try {
                const remoteText = readProjectFile(context, compFile);
                const remoteProgram = parseTsx(remoteText, compFile);
                const remoteIface = findInterfaceIn(remoteProgram, imported.imported ?? refName);
                if (remoteIface) {
                  const remoteLookup = (nm: string) => findInterfaceIn(remoteProgram, nm);
                  const props = interfaceProps(remoteIface, remoteLookup);
                  for (const [k, p] of Object.entries(props)) push(k, p);
                }
              } catch {
                /* 远程类型解析失败时按本文件信息降级 */
              }
            }
          }
        }
        if (iface) {
          const props = interfaceProps(iface, lookupInterface);
          for (const [k, p] of Object.entries(props)) push(k, p);
        }
      }
    } else if (first.type === 'ObjectPattern') {
      for (const prop of first.properties ?? []) {
        if (prop.type === 'RestElement') continue;
        const key = prop.key?.name ?? prop.key?.value;
        if (!key) continue;
        const value = prop.value;
        let annotation: AnyNode | undefined;
        let defaultInfo: { defaultValue?: unknown; defaultRaw?: string } = {};
        if (value?.type === 'AssignmentPattern') {
          defaultInfo = extractDefault(raw, value.right);
          if (value.left?.typeAnnotation) annotation = value.left.typeAnnotation.typeAnnotation;
        } else if (value?.typeAnnotation) {
          annotation = value.typeAnnotation.typeAnnotation;
        }
        const required = annotation == null && !defaultInfo.defaultRaw;
        let schema: Partial<PropSchema> = { required: !defaultInfo.defaultRaw, ...defaultInfo };
        if (annotation) {
          const base = tsTypeToPropType(annotation, lookupInterface);
          if (base && typeof base === 'object' && 'kind' in base) {
            if (base.kind === 'array') schema = { ...schema, type: 'array', items: base.items };
            else if (base.kind === 'object') schema = { ...schema, type: 'object', properties: base.properties };
          } else {
            schema = { ...schema, type: (base as PropSchema['type']) ?? 'unknown' };
            if (schema.type === 'enum') {
              const vals = collectLiteralUnion(annotation);
              if (vals) schema.options = vals.map((v) => ({ value: v, label: String(v) }));
            }
          }
        } else {
          schema.type = schema.type ?? 'any';
        }
        push(key, schema);
      }
    }
  }

  // 2) cva variants/defaultVariants（shadcn 组件）
  const cvaHits = findNodes(program, (n) => n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'cva');
  for (const { node } of cvaHits) {
    const config = node.arguments?.[1];
    if (!config || config.type !== 'ObjectExpression') continue;
    const readObjectProps = (obj: AnyNode) => {
      const map = new Map<string, AnyNode>();
      for (const p of obj.properties ?? []) {
        if ((p.type === 'Property' || p.type === 'ObjectProperty') && p.key?.name) {
          map.set(p.key.name, p.value);
        }
      }
      return map;
    };
    const cfg = readObjectProps(config);
    const variants = cfg.get('variants');
    const defaults = cfg.get('defaultVariants');
    const defaultMap = defaults?.type === 'ObjectExpression' ? readObjectProps(defaults) : new Map<string, AnyNode>();
    if (variants?.type === 'ObjectExpression') {
      const variantsMap = readObjectProps(variants);
      for (const [variantKey, valueObj] of variantsMap) {
        if (valueObj?.type !== 'ObjectExpression') continue;
        const options: Array<{ value: unknown; label: string }> = [];
        for (const p of valueObj.properties ?? []) {
          if ((p.type === 'Property' || p.type === 'ObjectProperty') && p.key?.name) {
            options.push({ value: p.key.name, label: p.key.name });
          }
        }
        const defNode = defaultMap.get(variantKey);
        const def = defNode ? extractDefault(raw, defNode) : {};
        push(variantKey, {
          type: 'enum',
          options,
          required: false,
          ...def,
        });
      }
    }
  }

  // 3) interface 里声明但未出现在顺序里的属性（若上面没用上）
  for (const iface of interfaceCache.values()) {
    if (!iface || iface.type !== 'TSInterfaceDeclaration') continue;
    const props = interfaceProps(iface, lookupInterface);
    for (const [k, p] of Object.entries(props)) {
      if (!propsByName.has(k)) {
        push(k, p);
      }
    }
  }

  const props = order.map((k) => propsByName.get(k)!);

  const toJsonSpec = (p: PropSchema): JsonPropSpec => {
    const spec: JsonPropSpec = { 'x-type': p.type };
    const st = p.type;
    if (st === 'string' || st === 'number' || st === 'boolean') {
      spec.type = st;
    } else if (st === 'array') {
      spec.type = 'array';
      if (p.items) spec.items = {};
    } else if (st === 'object') {
      spec.type = 'object';
      if (p.properties) spec.properties = p.properties;
    } else if (st === 'enum') {
      spec.enum = (p.options ?? []).map((o) => o.value);
    } else if (st === 'function') {
      spec.description = '函数/事件表达式（保存时按 expression 传递）';
    }
    if (p.defaultValue !== undefined) spec.default = p.defaultValue;
    else if (p.defaultRaw !== undefined) spec.default = p.defaultRaw;
    if (p.description) spec.description = p.description;
    return spec;
  };

  const properties: ComponentSchema['properties'] = {};
  for (const k of order) {
    const p = propsByName.get(k)!;
    properties[k] = toJsonSpec(p);
  }
  const required = props.filter((p) => p.required).map((p) => p.key);

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    title: `${nodeName} props`,
    properties,
    ...(required.length > 0 ? { required } : {}),
    'x-component': { name: nodeName, file: fileRel, exportKind: hit.exportKind },
    'x-order': order,
  };
}

/** 文件内查找 interface/type 定义 */
function findInterfaceIn(program: AnyNode, name: string): AnyNode | null {
  return (
    findNodes(
      program,
      (n) =>
        (n?.type === 'TSInterfaceDeclaration' || n?.type === 'TSTypeAliasDeclaration') &&
        n.id?.name === name
    )[0]?.node ?? null
  );
}

/** 通过 /__editor/component-schema 调用入口：文件由调用方读取后传入 */
export function componentSchemaFromFile(fileText: string, fileRel: string, nodeName: string) {
  return componentSchema(fileText, fileRel, nodeName);
}
