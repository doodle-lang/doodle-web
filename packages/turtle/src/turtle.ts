// The turtle capability handlers: the browser half of the Doodle turtle library. The
// library (doodle-rust/doodle/turtle.doodle) computes all geometry and issues three
// suspending platform-primitive capabilities; these handlers fulfil them on a
// `DrawingSurface`. `draw_line` is *animated* over frames (the turtle glides and the pen
// trail grows); `set_turtle` and `clear_canvas` are instant. Wire `onCapability` into the
// pump (@doodle-lang/engine).
//
// S-23 (stop mid-`forward`): an animating `draw_line` races each frame against the shared
// stop signal and returns promptly when it fires, discarding its in-progress trail. The
// pump then cancels the drive — which faults `Cancelled` at the next safe point — so the
// stop button is instant even inside a per-iteration-suspending animation loop.

import type { CapabilityCall, DoodleValue } from '@doodle-lang/engine';
import type { LineSegment, Marker } from './types.js';
import type { DrawingSurface } from './surface.js';

/** The turtle platform-primitive capability ids — the fixed registration order the wasm
 *  `turtle` config uses (E§11 stability). `print` (0), `sin` (1), and `cos` (2) are not
 *  suspending capabilities, so the handlers never see them. */
export const DRAW_LINE = 3;
export const SET_TURTLE = 4;
export const CLEAR_CANVAS = 5;

/** Registers a one-shot callback to run on the next animation frame (browser:
 *  `(cb) => requestAnimationFrame(cb)`). Tests inject a manual driver for deterministic
 *  stepping. */
export type FrameSource = (callback: () => void) => void;

export interface TurtleHandlersOptions {
  /** Where to draw. */
  readonly surface: DrawingSurface;
  /** The animation clock. */
  readonly frames: FrameSource;
  /** The stop signal — **the same one passed to the pump**. An animating `forward` races
   *  each frame against it so a stop returns promptly (S-23). */
  readonly signal?: AbortSignal;
  /** Pen travel per animation frame, in turtle units (default 8). A `forward(n)` animates
   *  over `max(1, ceil(|n| / speed))` frames — constant pen speed, deterministic. */
  readonly speed?: number;
}

export interface TurtleHandlers {
  /** The pump `onCapability` handler: dispatches `draw_line`/`set_turtle`/`clear_canvas`. */
  readonly onCapability: (call: CapabilityCall) => Promise<undefined>;
}

const DEFAULT_SPEED = 8;

/**
 * Builds the turtle capability handler over a `DrawingSurface` and a frame clock. Returns
 * `{ onCapability }` for the pump; a `to` capability yields Void, so it always resolves
 * `undefined`.
 */
export function createTurtleHandlers(options: TurtleHandlersOptions): TurtleHandlers {
  const { surface, frames } = options;
  const signal = options.signal;
  const speed = options.speed ?? DEFAULT_SPEED;

  // The marker's heading and visibility persist across a `forward`: the library only
  // updates them via `set_turtle` (turns, show/hide), and the turtle keeps facing its
  // heading while it glides. `forward`'s `draw_line` carries no heading, so we remember it.
  let heading = 0;
  let visible = true;

  async function animateForward(seg: LineSegment): Promise<void> {
    const dx = seg.x1 - seg.x0;
    const dy = seg.y1 - seg.y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / speed));
    surface.beginStroke(seg);
    for (let i = 1; i <= steps; i++) {
      await waitFrame(frames, signal);
      if (signal?.aborted) {
        // Stop clicked mid-stroke: abandon the in-progress trail. The pump's
        // post-capability abort check then cancels the drive (S-23).
        surface.endStroke(false);
        return;
      }
      const t = i / steps;
      surface.setMarker({ x: seg.x0 + dx * t, y: seg.y0 + dy * t, heading, visible });
    }
    surface.endStroke(true);
  }

  async function onCapability(call: CapabilityCall): Promise<undefined> {
    switch (call.capability) {
      case DRAW_LINE:
        await animateForward(drawLineSegment(call.args));
        return undefined;
      case SET_TURTLE: {
        const marker = markerOf(call.args);
        heading = marker.heading;
        visible = marker.visible;
        surface.setMarker(marker);
        return undefined;
      }
      case CLEAR_CANVAS:
        surface.clear();
        return undefined;
      default:
        throw new Error(`turtle: unhandled capability id ${call.capability}`);
    }
  }

  return { onCapability };
}

/**
 * Resolves on the next animation frame **or** as soon as `signal` aborts, whichever is
 * first — so a stop wakes an animating `forward` immediately, without waiting out a frame.
 * The caller re-checks `signal.aborted` after awaiting to decide whether to continue.
 */
function waitFrame(frames: FrameSource, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    // A stray frame after an abort-driven resolve harmlessly re-enters `finish` (a no-op);
    // `FrameSource` is rAF-shaped with no cancel, which is fine for a one-shot.
    frames(finish);
  });
}

/** Coerces a capability argument to a JS number — coords arrive as floats (`number`) and
 *  color channels as ints (`bigint`) across the handle boundary. */
function num(value: DoodleValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`turtle: expected a number argument, got ${value === undefined ? 'nothing' : typeof value}`);
}

/** Decodes a `draw_line(x0, y0, x1, y1, r, g, b, a)` argument list. */
function drawLineSegment(args: readonly DoodleValue[]): LineSegment {
  if (args.length !== 8) {
    throw new Error(`turtle: draw_line expects 8 arguments, got ${args.length}`);
  }
  return {
    x0: num(args[0]),
    y0: num(args[1]),
    x1: num(args[2]),
    y1: num(args[3]),
    color: { r: num(args[4]), g: num(args[5]), b: num(args[6]), a: num(args[7]) },
  };
}

/** Decodes a `set_turtle(x, y, heading, visible)` argument list. */
function markerOf(args: readonly DoodleValue[]): Marker {
  if (args.length !== 4) {
    throw new Error(`turtle: set_turtle expects 4 arguments, got ${args.length}`);
  }
  return {
    x: num(args[0]),
    y: num(args[1]),
    heading: num(args[2]),
    visible: args[3] === true,
  };
}
