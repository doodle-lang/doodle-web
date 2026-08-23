// The demo's run core — DOM-free so it can be Node-tested with a mock surface. Loads a
// Doodle turtle program, drives it through the fuel-sliced pump (@doodle-lang/engine)
// with the animated turtle capability handlers (@doodle-lang/turtle), rendering onto an
// injected DrawingSurface. `loadEngine()` must have resolved first (the caller does it
// once). The browser glue (src/main.ts) wires this to the editor, canvas, and stop button.

import { DoodleInstance, pump } from '@doodle-lang/engine';
import type { PumpOutcome } from '@doodle-lang/engine';
import { createTurtleHandlers } from '@doodle-lang/turtle';
import type { DrawingSurface, FrameSource } from '@doodle-lang/turtle';

/** A failed load (a front-end parse/resolve error) surfaces as this instead of a pump
 *  outcome, carrying the rendered diagnostics for the output pane. */
export type RunResult = PumpOutcome | { readonly kind: 'load-error'; readonly message: string };

export interface RunOptions {
  /** Where the turtle draws. */
  readonly surface: DrawingSurface;
  /** The animation clock — `requestAnimationFrame` in the browser, a manual driver in tests. */
  readonly frames: FrameSource;
  /** The stop button. Aborting cancels the drive (→ a `faulted`/`cancelled` outcome). */
  readonly signal?: AbortSignal;
  /** Receives `print` output as it streams. */
  readonly onOutput?: (text: string) => void;
  /** Receives the 1-based line of the user's program currently executing (or null when in
   *  the prepended turtle library or at a boundary), for a live line highlight. */
  readonly onLine?: (line: number | null) => void;
  /** Pen travel per animation frame (turtle units); forwarded to the handlers. */
  readonly speed?: number;
}

/** Count of `\n` bytes in `bytes[from, to)`. */
function countNewlines(bytes: Uint8Array, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (bytes[i] === 10) count += 1;
  return count;
}

/**
 * Runs `source` as a Doodle turtle program to a terminal outcome, rendering onto
 * `options.surface`. Returns a `load-error` if the program fails to load, otherwise the
 * pump's outcome (`completed` / `raised` / `faulted`). Always frees the instance.
 */
export async function runTurtleProgram(source: string, options: RunOptions): Promise<RunResult> {
  let instance: DoodleInstance;
  try {
    instance = DoodleInstance.turtle(source);
  } catch (err) {
    return { kind: 'load-error', message: err instanceof Error ? err.message : String(err) };
  }

  const handlers = createTurtleHandlers({
    surface: options.surface,
    frames: options.frames,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
  });

  // Map the engine's module-relative byte span → a 1-based line in the *user's* program.
  // The engine's spans index the full module (turtle prelude + program), so subtract the
  // prelude's line count; a position inside the prelude reports null (nothing to highlight
  // in the editor). Newlines are single bytes, so counting them is offset-encoding-safe.
  let onPosition: ((span: readonly [number, number] | null) => void) | undefined;
  const onLine = options.onLine;
  if (onLine) {
    const moduleBytes = new TextEncoder().encode(instance.source());
    const preludeBytes = instance.preludeBytes();
    const preludeLines = countNewlines(moduleBytes, 0, preludeBytes);
    onPosition = (span) => {
      if (!span || span[0] < preludeBytes) onLine(null);
      else onLine(countNewlines(moduleBytes, 0, span[0]) + 1 - preludeLines);
    };
  }

  try {
    return await pump(instance, {
      ...(options.signal ? { signal: options.signal } : {}),
      onCapability: handlers.onCapability,
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(onPosition ? { onPosition } : {}),
    });
  } finally {
    instance.free();
  }
}
