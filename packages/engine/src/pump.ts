// The fuel-sliced pump (implementation-plan AD6): drives a Doodle engine instance in
// short fuel slices, yielding to the host event loop between them so the browser main
// thread stays responsive; surfaces suspending capabilities as Promises; samples the
// executing user-program position (per slice AND at each capability suspend) for a line
// highlight; and stops between slices when
// an AbortSignal fires. The SAME code runs in Node (CI, injected `setImmediate`) and the
// browser (rAF/`setTimeout`) — only the scheduler differs, which is how CI certifies the
// demo.

import type { DoodleInstance, DriveResult } from '../wasm/doodle_wasm.js';

/** A value crossing the capability boundary in either direction (scalars only at M3). */
export type DoodleValue = null | boolean | bigint | number | string;

/** A suspended capability call surfaced to the host, args already decoded from handles. */
export interface CapabilityCall {
  /** The capability's registry id (stable across runs). */
  readonly capability: number;
  /** The bound arguments, decoded to JS values. */
  readonly args: readonly DoodleValue[];
}

/** How the host fulfils a capability: return its result value (or `undefined`/`null` for a
 *  `to` capability's Void). May be async — the pump awaits it, which is how an animated
 *  `forward` paces over animation frames. **Throwing** surfaces the failure as a Doodle
 *  raise at the capability's call site (E§7.5). */
export type CapabilityHandler = (
  call: CapabilityCall,
) => DoodleValue | undefined | Promise<DoodleValue | undefined>;

/** Yields control to the host event loop between slices. Node: `setImmediate`; browser:
 *  `requestAnimationFrame` or `setTimeout`. */
export type Scheduler = (resume: () => void) => void;

export interface PumpOptions {
  /** Safe points to run per slice (default 100k — a coarse ~few-ms budget; the real engine
   *  cost per safe point is small, and the gate is responsiveness, not exactness). */
  readonly fuelPerSlice?: bigint;
  /** How to yield between slices. Default: a macrotask (`setTimeout(…, 0)`) so control
   *  actually returns to the event loop (a microtask default would not — AD6). */
  readonly scheduler?: Scheduler;
  /** Fulfils suspending capabilities. Required if the program uses any. */
  readonly onCapability?: CapabilityHandler;
  /** Receives newly-printed output (the delta since the last slice), decoded as UTF-8. */
  readonly onOutput?: (text: string) => void;
  /** Receives the executing `[start, end)` byte span (or null at a boundary), for a line
   *  highlight — sampled once per slice AND at each capability suspend, so a capability-paced
   *  program (the animated turtle, which suspends before any slice ends) still updates. */
  readonly onPosition?: (span: readonly [number, number] | null) => void;
  /** The stop button: checked between slices AND after each capability handler; when
   *  aborted, the drive is cancelled and the run ends `faulted` with `"cancelled"`. */
  readonly signal?: AbortSignal;
}

/** How a pumped run ended. */
export type PumpOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'raised'; readonly exceptionKind: string; readonly message: string; readonly span: readonly [number, number] | null }
  | { readonly kind: 'faulted'; readonly fault: string };

const DEFAULT_FUEL = 100_000n;
/** A macrotask yield — the default scheduler; actually returns control to the event loop. */
const macrotaskScheduler: Scheduler = (resume) => {
  setTimeout(resume, 0);
};

/**
 * Drives `instance` to a terminal outcome, slice by slice. Returns when the program
 * completes, raises, or faults (including a cancellation after the signal aborts) — always
 * in a terminal state; the caller frees the instance. Throws only on misconfiguration
 * (a program that suspends a capability with no `onCapability` handler).
 */
export async function pump(instance: DoodleInstance, options: PumpOptions = {}): Promise<PumpOutcome> {
  const fuel = options.fuelPerSlice ?? DEFAULT_FUEL;
  const scheduler = options.scheduler ?? macrotaskScheduler;
  // A dedicated streaming decoder for output — SEPARATE from the per-value decoder, since a
  // streaming decoder cannot be shared across two byte streams (§ decodeValue). Robust even
  // if output ever stops landing on whole-value boundaries.
  const outputDecoder = new TextDecoder('utf-8');
  let outputSeen = 0;

  const flushOutput = (final = false) => {
    if (!options.onOutput) return;
    const all = instance.output();
    if (all.length > outputSeen) {
      const text = outputDecoder.decode(all.subarray(outputSeen), { stream: true });
      if (text) options.onOutput(text);
      outputSeen = all.length;
    }
    if (final) {
      const tail = outputDecoder.decode();
      if (tail) options.onOutput(tail);
    }
  };

  // A signal already aborted before the first slice cancels immediately.
  if (options.signal?.aborted) instance.cancel();

  let result: DriveResult = instance.drive('run', fuel);
  for (;;) {
    const kind = result.kind;

    if (kind === 'completed') {
      result.free();
      flushOutput(true);
      return { kind: 'completed' };
    }

    if (kind === 'raised') {
      const span = spanOf(result.raiseSpan);
      const outcome: PumpOutcome = {
        kind: 'raised',
        exceptionKind: result.exceptionKind ?? 'unknown',
        message: result.message ?? '',
        span,
      };
      result.free();
      flushOutput(true);
      return outcome;
    }

    if (kind === 'faulted') {
      const fault = result.fault ?? 'unknown';
      result.free();
      flushOutput(true);
      return { kind: 'faulted', fault };
    }

    if (kind === 'suspended') {
      const capability = result.capability!;
      const handles = Array.from(result.args ?? new BigUint64Array());
      result.free();
      flushOutput();
      // Sample the executing position at each capability suspend (a `to` capability like the
      // turtle's `draw_line` sits at its call site), not only at slice ends — so a paced,
      // capability-driven program (the animated turtle) drives a live line highlight.
      if (options.onPosition) options.onPosition(spanOf(instance.currentUserSpan()));

      let args: DoodleValue[];
      try {
        args = handles.map((h) => decodeValue(instance, h));
      } finally {
        // Always release the host-owned argument handles (S-17), even if a decode throws.
        for (const h of handles) instance.release(h);
      }

      if (!options.onCapability) {
        throw new Error(`program suspended capability ${capability} but no onCapability handler was provided`);
      }

      // Fulfil the capability. A handler that throws surfaces as a Doodle raise at the call
      // site (E§7.5); a returned value (or undefined for a `to`'s Void) resolves normally.
      let handle: bigint;
      let raise: boolean;
      try {
        const value = await options.onCapability({ capability, args });
        handle = encodeValue(instance, value ?? null);
        raise = false;
      } catch (err) {
        handle = instance.makeString(err instanceof Error ? err.message : String(err));
        raise = true;
      }

      // Stop clicked while awaiting the handler? Cancel before resuming, so the resumed
      // drive faults `Cancelled` at its next safe point. Resolving (not driving) is required
      // — the instance is Suspended.
      if (options.signal?.aborted) instance.cancel();
      result = instance.resolve(handle, raise, fuel);
      instance.release(handle);
      continue;
    }

    // 'paused' — a slice boundary (or a Step*/breakpoint we treat the same). Sample the
    // position, yield to the host, then honor the stop button before driving the next slice.
    result.free();
    flushOutput();
    if (options.onPosition) options.onPosition(spanOf(instance.currentUserSpan()));
    await new Promise<void>((resume) => scheduler(resume));
    if (options.signal?.aborted) instance.cancel();
    result = instance.drive('run', fuel);
  }
}

/** Decodes a handle to a JS value by kind (scalars only at M3). Does not release it. */
function decodeValue(instance: DoodleInstance, handle: bigint): DoodleValue {
  switch (instance.kindOf(handle)) {
    case 'nil':
      return null;
    case 'bool':
      return instance.asBool(handle);
    case 'int':
      // Read the integer as decimal text, then build a JS bigint — total over any
      // magnitude. `asInt` returns a host i64 and THROWS on a bignum (L§4.2 integers are
      // arbitrary-precision), which would escape the decode and leave the instance wedged
      // Suspended; `asIntStr` carries any magnitude across the boundary.
      return BigInt(instance.asIntStr(handle));
    case 'float':
      return instance.asFloat(handle);
    case 'string':
      // A per-call non-streaming decode: a string handle is always a complete UTF-8 value.
      return new TextDecoder('utf-8').decode(instance.stringBytes(handle));
    default:
      // A compound/foreign value: opaque at M3 — surface as null rather than throw.
      return null;
  }
}

/** Interns a JS value as a fresh host-owned handle to resolve a capability with. */
function encodeValue(instance: DoodleInstance, value: DoodleValue): bigint {
  if (value === null) return instance.makeNil();
  if (typeof value === 'boolean') return instance.makeBool(value);
  // Intern via decimal text so a bignum result (beyond i64) is total, mirroring the
  // decode; `makeInt` takes a host i64 and would throw on a larger magnitude.
  if (typeof value === 'bigint') return instance.makeIntStr(value.toString());
  if (typeof value === 'number') return instance.makeFloat(value);
  if (typeof value === 'string') return instance.makeString(value);
  throw new Error(`cannot resolve a capability with value of type ${typeof value}`);
}

function spanOf(raw: Uint32Array | undefined): readonly [number, number] | null {
  if (!raw || raw.length !== 2) return null;
  return [raw[0]!, raw[1]!];
}
