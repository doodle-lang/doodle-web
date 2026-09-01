// The TypeScript contract for the engine's debug observation surface (engine spec E§8) —
// the object shapes the wasm `DoodleInstance` returns as plain JS objects/arrays, pinned here
// because a JS host reads them by field name (the shapes ARE API, a rider on D-M6-3). Field
// names use E§8.2/§8.3 vocabulary. The typed accessors below wrap the three methods whose
// wasm-bindgen return type is opaque (`object`/`any`); the scalar debug/inspection reads on
// `DoodleInstance` are already well-typed by the generated bindings.

import type { DoodleInstance } from '../wasm/doodle_wasm.js';

/** A `[start, end)` byte span into the module source (E§8.1). */
export type Span = readonly [number, number];

/** A drive directive (E§7.3) — the `do:` vocabulary the debugger drives with. */
export type DriveDirective = 'run' | 'continue' | 'step' | 'into' | 'over' | 'out';

/** A call frame's callable reflection (E§8.2), plain GC-owned data (nothing to release). All
 *  fields absent for a callable with no source declaration (an intrinsic/dispatcher). */
export interface CallableInfo {
  /** The declared name, or absent for an anonymous `fn`/a sourceless callable. */
  readonly name?: string;
  /** `true` for a `fn` (yields a value), `false` for a `to` (procedure). */
  readonly isFunction?: boolean;
  /** The `[start, end)` span of the `to`/`fn` declaration. */
  readonly declSpan?: Span;
}

/** One entry of the {@link StackWalk} transcript (E§8.2/§8.3) — a live call frame or, when
 *  `elided` is set, a tail-elided caller (E§8.3). Entirely GC-owned data: nothing here is a
 *  handle. Expand a binding's value with {@link DoodleInstance.frameLocal}/`frameDynamic`. */
export interface StackFrame {
  /** The frame's callable reflection; absent for the module top level and `do…end` blocks. */
  readonly callable?: CallableInfo;
  /** The `[start, end)` call-site span; absent for the module top / native-invoked blocks. */
  readonly callSite?: Span;
  /** Tail-iterations absorbed into this frame by proper-tail-call reuse (E§8.3). */
  readonly tailCount: number;
  /** In-scope local names, slot order (empty for an elided frame or a block). */
  readonly locals: readonly string[];
  /** `with`-established dynamic-parameter names in this frame (empty for an elided frame). */
  readonly dynamics: readonly string[];
  /** The frame's home module index (E§8.2) — pass to {@link moduleGlobals} for the module's
   *  variables (shown once per module). Absent on an elided frame. */
  readonly module?: number;
  /** `true` if this is a tail-elided caller (E§8.3), not a live activation. */
  readonly elided?: boolean;
}

/** A module-level declaration kind (E§8.2). The *variables* a debugger's panel shows are
 *  `let`/`const`/`parameter`; the rest are the module's other declarations. */
export type GlobalKind = 'let' | 'const' | 'parameter' | 'to' | 'fn' | 'record' | 'protocol' | 'module';

/** A module-level binding (E§8.2): its name, declaration `kind` (the host filters to
 *  `let`/`const`/`parameter` for a variables panel), and `slot` (the key for
 *  {@link DoodleInstance.moduleGlobalValue}). Value read lazily and gen-gated, like frame bindings. */
export interface GlobalBinding {
  readonly name: string;
  readonly kind: GlobalKind;
  readonly slot: number;
}

/** The stack-walk result (E§8.2): the live frames (innermost first) then the tail-elided
 *  history (E§8.3), tagged with the pause `generation` a lazy binding read must carry. */
export interface StackWalk {
  /** The pause generation these frame indices are valid for (invalidated by any drive). */
  readonly generation: number;
  /** Live frames innermost-first, followed by `elided` entries most-recent-first. */
  readonly frames: readonly StackFrame[];
}

/** An installed breakpoint as read back (E§8.6); `resolved: false` marks a pending mark. */
export interface BreakpointInfo {
  readonly id: number;
  readonly canonicalId: string;
  readonly line: number;
  readonly resolved: boolean;
}

/** The outcome of {@link evalToString} (E§8.4/S-22). A `rendered`/`raised` `value` is a fresh
 *  **host-owned** handle the caller must `release`. */
export type AuxResult =
  | { readonly kind: 'rendered'; readonly value: bigint }
  | { readonly kind: 'raised'; readonly value: bigint }
  | { readonly kind: 'faulted'; readonly fault: string };

/** The call stack + tail-elided history at a stopped instance (E§8.2/§8.3), typed. */
export function stackWalk(instance: DoodleInstance): StackWalk {
  return instance.stackWalk() as unknown as StackWalk;
}

/** The installed breakpoints (E§8.6), typed. */
export function breakpoints(instance: DoodleInstance): BreakpointInfo[] {
  return instance.breakpoints() as unknown as BreakpointInfo[];
}

/** Host-driven `to_string` on a value at a paused instance (E§8.4/S-22), typed. */
export function evalToString(instance: DoodleInstance, handle: bigint, fuel: bigint): AuxResult {
  return instance.evalToString(handle, fuel) as unknown as AuxResult;
}

/** The module-level bindings of a frame's home `module` (E§8.2), typed — a top-level program's
 *  variables live here, not in a frame's `locals`. */
export function moduleGlobals(instance: DoodleInstance, module: number): GlobalBinding[] {
  return instance.moduleGlobals(module) as unknown as GlobalBinding[];
}
