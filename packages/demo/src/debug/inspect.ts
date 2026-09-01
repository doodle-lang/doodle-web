// Value-tree materialization for the debugger's Variables panel (E§4.4/§8.4): turn a
// host-owned value handle into a **plain, fully-materialized** tree — a record's fields, a
// dict's entries, a list's elements, recursively — bounded by a depth and node cap. It mints
// child handles internally and **releases them as it goes**, so the returned data holds no live
// handles: safe to render and re-render, and immune to the stale-handle hazard after a resume
// (the caller still owns and releases the root handle it passed). Pure structural inspection —
// no Doodle code runs (§8.4).

import type { DoodleInstance } from '@doodle-lang/engine';

/** A materialized value: a short `summary` plus, for a compound, its `children`. `truncated`
 *  marks a node whose contents were cut by the depth/node budget. */
export interface ValueNode {
  readonly kind: string;
  readonly summary: string;
  readonly children: readonly ValueChild[];
  readonly truncated: boolean;
}

/** One child of a compound value: a `label` (field name, dict key rendering, or index) and its
 *  materialized value. */
export interface ValueChild {
  readonly label: string;
  readonly value: ValueNode;
}

const MAX_DEPTH = 4;
const MAX_NODES = 200;

/** Materializes the value named by `handle` (host-owned; the caller keeps ownership) to a plain
 *  tree, bounded by depth and total node count. */
export function materializeValue(instance: DoodleInstance, handle: bigint): ValueNode {
  return build(instance, handle, MAX_DEPTH, { nodes: MAX_NODES });
}

interface Budget {
  nodes: number;
}

function build(instance: DoodleInstance, handle: bigint, depth: number, budget: Budget): ValueNode {
  budget.nodes -= 1;
  let kind: string;
  try {
    kind = instance.kindOf(handle);
  } catch {
    return leaf('unknown', '‹unreadable›');
  }
  switch (kind) {
    case 'nil':
      return leaf(kind, 'nil');
    case 'bool':
      return leaf(kind, String(safe(() => instance.asBool(handle), false)));
    case 'int':
      return leaf(kind, safe(() => instance.asIntStr(handle), '?'));
    case 'float':
      return leaf(kind, formatFloat(safe(() => instance.asFloat(handle), NaN)));
    case 'string':
      return leaf(kind, quote(safe(() => new TextDecoder().decode(instance.stringBytes(handle)), '')));
    case 'bytes':
      return leaf(kind, 'bytes');
    case 'callable':
      return leaf(kind, callableLabel(instance, handle));
    case 'type':
      return leaf(kind, safe(() => instance.typeName(handle), 'Type'));
    case 'module':
      return leaf(kind, 'module');
    case 'list':
      return listNode(instance, handle, depth, budget);
    case 'dict':
      return dictNode(instance, handle, depth, budget);
    case 'record':
      return recordNode(instance, handle, depth, budget);
    default:
      return leaf(kind, kind);
  }
}

function listNode(instance: DoodleInstance, handle: bigint, depth: number, budget: Budget): ValueNode {
  const length = safe(() => instance.listLength(handle), 0);
  const summary = `[${length}]`;
  if (depth <= 0 || length === 0) return { kind: 'list', summary, children: [], truncated: depth <= 0 && length > 0 };
  const children: ValueChild[] = [];
  let truncated = false;
  for (let i = 0; i < length; i += 1) {
    if (budget.nodes <= 0) {
      truncated = true;
      break;
    }
    const child = instance.listGet(handle, i);
    children.push({ label: String(i), value: build(instance, child, depth - 1, budget) });
    instance.release(child);
  }
  return { kind: 'list', summary, children, truncated };
}

function dictNode(instance: DoodleInstance, handle: bigint, depth: number, budget: Budget): ValueNode {
  const length = safe(() => instance.dictLength(handle), 0);
  const summary = `{${length}}`;
  if (depth <= 0 || length === 0) return { kind: 'dict', summary, children: [], truncated: depth <= 0 && length > 0 };
  const children: ValueChild[] = [];
  let truncated = false;
  for (let i = 0; i < length; i += 1) {
    if (budget.nodes <= 0) {
      truncated = true;
      break;
    }
    const keyHandle = instance.dictKey(handle, i);
    const valueHandle = instance.dictValue(handle, i);
    const key = build(instance, keyHandle, 1, budget);
    children.push({ label: key.summary, value: build(instance, valueHandle, depth - 1, budget) });
    instance.release(keyHandle);
    instance.release(valueHandle);
  }
  return { kind: 'dict', summary, children, truncated };
}

function recordNode(instance: DoodleInstance, handle: bigint, depth: number, budget: Budget): ValueNode {
  const typeName = safe(() => instance.recordTypeName(handle), 'record');
  const length = safe(() => instance.recordLength(handle), 0);
  const summary = `${typeName} {…}`;
  if (depth <= 0 || length === 0) return { kind: 'record', summary, children: [], truncated: depth <= 0 && length > 0 };
  const children: ValueChild[] = [];
  let truncated = false;
  for (let i = 0; i < length; i += 1) {
    if (budget.nodes <= 0) {
      truncated = true;
      break;
    }
    const label = safe(() => instance.recordFieldName(handle, i), String(i));
    const child = instance.recordField(handle, i);
    children.push({ label, value: build(instance, child, depth - 1, budget) });
    instance.release(child);
  }
  return { kind: 'record', summary, children, truncated };
}

function callableLabel(instance: DoodleInstance, handle: bigint): string {
  const name = safe(() => instance.callableName(handle), undefined);
  const isFn = safe(() => instance.callableIsFunction(handle), undefined);
  const keyword = isFn === undefined ? 'callable' : isFn ? 'fn' : 'to';
  return name ? `${keyword} ${name}` : `${keyword} ‹anonymous›`;
}

function leaf(kind: string, summary: string): ValueNode {
  return { kind, summary, children: [], truncated: false };
}

/** Formats a float for display. The engine's canonical rendering (L§4.3) is authoritative for
 *  program output; this is a debugger label, so a compact JS rendering is fine. */
function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
