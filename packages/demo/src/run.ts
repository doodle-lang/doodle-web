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
  /** Receives the executing `[start, end)` byte span once per slice (for a line highlight). */
  readonly onPosition?: (span: readonly [number, number] | null) => void;
  /** Pen travel per animation frame (turtle units); forwarded to the handlers. */
  readonly speed?: number;
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

  try {
    return await pump(instance, {
      ...(options.signal ? { signal: options.signal } : {}),
      onCapability: handlers.onCapability,
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(options.onPosition ? { onPosition: options.onPosition } : {}),
    });
  } finally {
    instance.free();
  }
}
