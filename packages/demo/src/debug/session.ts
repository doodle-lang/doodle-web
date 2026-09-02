// The debug-session driver (E§8): drives a Doodle turtle instance under a **directive**
// (continue / step / into / over / out), fuel-slicing for responsiveness and fulfilling the
// turtle capabilities as it goes (like the pump), but **stopping** at debug pauses —
// breakpoints, steps, and raise-traps — instead of running straight to the end. DOM-free, so
// the demo's Node test drives it headlessly with a mock surface; the browser glue (main.ts)
// wires it to the editor gutter, step controls, and panels.

import { DoodleInstance, decodeValue, encodeValue } from '@doodle-lang/engine';
import type { Scheduler } from '@doodle-lang/engine';
import { createTurtleHandlers } from '@doodle-lang/turtle';
import type { DrawingSurface, FrameSource } from '@doodle-lang/turtle';

/** How a debug drive step ended. A `paused` stop is resumable (call another directive); the
 *  rest are terminal (the session is spent — `free()` it). Positions are 1-based user-program
 *  lines (or null when in the prepended turtle library / at a boundary). */
export type DebugStop =
  | { readonly kind: 'paused'; readonly reason: PauseReason; readonly line: number | null; readonly under: boolean }
  | { readonly kind: 'completed' }
  | { readonly kind: 'raised'; readonly exceptionKind: string; readonly message: string; readonly line: number | null }
  | { readonly kind: 'faulted'; readonly fault: string };

/** A debug pause reason surfaced to the UI (E§7.2). `slice-end` never escapes — the driver
 *  consumes it as a yield point. */
export type PauseReason = 'breakpoint' | 'step' | 'raise-trap' | 'host-pause';

/** A driving directive the debugger issues (E§7.3). */
export type DebugDirective = 'continue' | 'step' | 'into' | 'over' | 'out';

export interface DebugSessionOptions {
  /** Where the turtle draws. */
  readonly surface: DrawingSurface;
  /** The animation clock (browser: `requestAnimationFrame`; tests: a manual driver). */
  readonly frames: FrameSource;
  /** The stop button; aborting cancels the drive (→ `faulted`/`cancelled`). */
  readonly signal?: AbortSignal;
  /** How to yield between fuel slices (default: a macrotask). */
  readonly scheduler?: Scheduler;
  /** Receives `print` output as it streams. */
  readonly onOutput?: (text: string) => void;
  /** Pen travel per animation frame (turtle units). */
  readonly speed?: number;
}

const FUEL = 100_000n;
const macrotask: Scheduler = (resume) => {
  setTimeout(resume, 0);
};

/**
 * A loaded, pausable debug session over a turtle program. Construct, set breakpoints /
 * raise-trap / watch mode, then drive with {@link run}; between `paused` stops read the
 * observation surface off {@link instance}. Always {@link free} it when done.
 */
export class DebugSession {
  /** The underlying engine instance — the panels read the observation surface off it. */
  readonly instance: DoodleInstance;
  /** The entry module's canonical id, for addressing breakpoints (E§3.2). */
  readonly entryModule: string;

  private readonly options: DebugSessionOptions;
  private readonly scheduler: Scheduler;
  private readonly onCapability: (call: { capability: number; args: readonly (null | boolean | bigint | number | string)[] }) => Promise<undefined>;
  private readonly moduleBytes: Uint8Array;
  private readonly preludeBytes: number;
  private readonly preludeLines: number;
  private readonly outputDecoder = new TextDecoder('utf-8');
  private outputSeen = 0;
  /** editor (1-based user) line → engine breakpoint id, for the breakpoints set here. */
  private readonly breakpointIds = new Map<number, number>();

  constructor(source: string, options: DebugSessionOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? macrotask;
    this.instance = DoodleInstance.turtle(source); // throws on a load error (caller catches)
    this.entryModule = this.instance.entryModule();
    this.moduleBytes = new TextEncoder().encode(this.instance.source());
    this.preludeBytes = this.instance.preludeBytes();
    this.preludeLines = countNewlines(this.moduleBytes, 0, this.preludeBytes);
    const handlers = createTurtleHandlers({
      surface: options.surface,
      frames: options.frames,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.speed !== undefined ? { speed: options.speed } : {}),
    });
    this.onCapability = handlers.onCapability;
  }

  /** Toggles a breakpoint at a 1-based **editor** line (mapping past the turtle prelude), and
   *  returns whether it is now set. Live: takes effect on the next drive. */
  toggleBreakpoint(userLine: number): boolean {
    const existing = this.breakpointIds.get(userLine);
    if (existing !== undefined) {
      this.instance.clearBreakpoint(existing);
      this.breakpointIds.delete(userLine);
      return false;
    }
    const id = this.instance.setBreakpoint(this.entryModule, userLine + this.preludeLines);
    this.breakpointIds.set(userLine, id);
    return true;
  }

  /** The editor lines that currently carry a breakpoint. */
  breakpointLines(): number[] {
    return [...this.breakpointIds.keys()];
  }

  /** Enables/disables raise-trapping (E§8.7). */
  setRaiseTrap(on: boolean): void {
    this.instance.setRaiseTrapping(on);
  }

  /** Enables/disables watch-it-run (per-subexpression fine stops, E§8.8/S-62). */
  setWatch(on: boolean): void {
    this.instance.setObservationMode(on);
  }

  /** Maps a module-source `[start,end)` span to a 1-based **user-program** line, or null when
   *  the span is in the prepended turtle library (nothing to show in the editor). */
  userLineOf(span: readonly [number, number] | null): number | null {
    if (!span || span[0] < this.preludeBytes) return null;
    return countNewlines(this.moduleBytes, 0, span[0]) + 1 - this.preludeLines;
  }

  /** The 1-based user line currently executing (the innermost user call site), for the paused
   *  line highlight. */
  currentLine(): number | null {
    return this.userLineOf(spanOf(this.instance.currentUserSpan()));
  }

  /** Runs the prepended turtle-library setup, stopping at the first **user-program** statement —
   *  so a debug session starts on the user's first line rather than inside the library's
   *  procedure definitions. Synchronous and full-speed: the library's top level only defines
   *  procedures and state (no drawing capabilities), so no suspension occurs here. */
  primeToUserCode(): void {
    for (let guard = 0; guard < 100_000 && this.currentLine() === null; guard += 1) {
      const result = this.instance.drive('step', FUEL);
      const kind = result.kind;
      const reason = result.pauseReason;
      result.free();
      if (kind !== 'paused') return; // terminal (e.g. an empty user program) or a suspension
      if (reason !== 'step' && reason !== 'slice-end') return; // an unexpected breakpoint/raise-trap
    }
  }

  /**
   * Drives one directive to its next stop (E§7.3): fuel-slices with a yield between slices,
   * fulfils turtle capabilities, and returns at the first debug pause (breakpoint / step /
   * raise-trap / host-pause) or terminal outcome. Honors the stop signal between slices.
   */
  async run(directive: DebugDirective): Promise<DebugStop> {
    if (this.options.signal?.aborted) this.instance.cancel();
    let result = this.instance.drive(directive, FUEL);
    for (;;) {
      const kind = result.kind;

      if (kind === 'paused') {
        const reason = result.pauseReason ?? 'step';
        result.free();
        this.flushOutput();
        if (reason === 'slice-end') {
          await new Promise<void>((resume) => this.scheduler(resume));
          if (this.options.signal?.aborted) this.instance.cancel();
          result = this.instance.drive(directive, FUEL);
          continue;
        }
        const { line, under } = this.pausedLocation(reason);
        return { kind: 'paused', reason: reason as PauseReason, line, under };
      }

      if (kind === 'suspended') {
        await this.fulfilCapability(result);
        // Resolve resumes under the directive in force (E§7.3); loop reads the new outcome.
        result = this.lastResolveResult!;
        continue;
      }

      if (kind === 'completed') {
        result.free();
        this.flushOutput(true);
        return { kind: 'completed' };
      }

      if (kind === 'raised') {
        const stop: DebugStop = {
          kind: 'raised',
          exceptionKind: result.exceptionKind ?? 'unknown',
          message: result.message ?? '',
          line: this.userLineOf(spanOf(result.raiseSpan)),
        };
        result.free();
        this.flushOutput(true);
        return stop;
      }

      // 'faulted'
      const fault = result.fault ?? 'unknown';
      result.free();
      this.flushOutput(true);
      return { kind: 'faulted', fault };
    }
  }

  /** Frees the instance and clears breakpoints. */
  free(): void {
    this.instance.free();
  }

  // --- internals ---

  private lastResolveResult: ReturnType<DoodleInstance['resolve']> | undefined;

  /** Decodes a capability request's argument handles, runs the turtle handler, and resolves
   *  (E§7.5) — a thrown handler surfaces as a Doodle raise at the call site. */
  private async fulfilCapability(result: ReturnType<DoodleInstance['drive']>): Promise<void> {
    const capability = result.capability!;
    const handles = Array.from(result.args ?? new BigUint64Array());
    result.free();
    this.flushOutput();
    let args: (null | boolean | bigint | number | string)[];
    try {
      args = handles.map((h) => decodeValue(this.instance, h));
    } finally {
      for (const h of handles) this.instance.release(h);
    }
    let handle: bigint;
    let raise: boolean;
    try {
      await this.onCapability({ capability, args });
      handle = encodeValue(this.instance, null); // a `to` capability yields Void
      raise = false;
    } catch (err) {
      handle = this.instance.makeString(err instanceof Error ? err.message : String(err));
      raise = true;
    }
    if (this.options.signal?.aborted) this.instance.cancel();
    this.lastResolveResult = this.instance.resolve(handle, raise, FUEL);
    this.instance.release(handle);
  }

  /** Where a pause highlights, and whether we are *under* that line. At a fine (watch) stop the
   *  completed subexpression's line; else the innermost active line. `under` is true when the
   *  actual executing position is inside a call (the prepended turtle library, or a called
   *  procedure) whose source is not in the editor — the highlight then marks the user's call
   *  site, and the UI colours it to say "executing inside this line's call". */
  private pausedLocation(reason: string): { line: number | null; under: boolean } {
    if (reason === 'raise-trap') {
      return { line: this.userLineOf(spanOf(this.instance.trappedRaiseSpan())), under: false };
    }
    const fine = this.userLineOf(spanOf(this.instance.completedSpan()));
    if (fine !== null) return { line: fine, under: false };
    const direct = this.userLineOf(spanOf(this.instance.currentSpan()));
    if (direct !== null) return { line: direct, under: false };
    const callSite = this.currentLine();
    return { line: callSite, under: callSite !== null };
  }

  private flushOutput(final = false): void {
    const onOutput = this.options.onOutput;
    if (!onOutput) return;
    const all = this.instance.output();
    if (all.length > this.outputSeen) {
      const text = this.outputDecoder.decode(all.subarray(this.outputSeen), { stream: true });
      if (text) onOutput(text);
      this.outputSeen = all.length;
    }
    if (final) {
      const tail = this.outputDecoder.decode();
      if (tail) onOutput(tail);
    }
  }
}

/** Count of `\n` bytes in `bytes[from, to)`. */
function countNewlines(bytes: Uint8Array, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (bytes[i] === 10) count += 1;
  return count;
}

function spanOf(raw: Uint32Array | undefined): readonly [number, number] | null {
  if (!raw || raw.length !== 2) return null;
  return [raw[0]!, raw[1]!];
}
