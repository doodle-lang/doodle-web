import type { LineSegment, Marker } from './types.js';

/**
 * The drawing surface the turtle handlers render onto. A **two-layer** model that keeps an
 * animated `forward` cleanly interruptible (S-23):
 *
 *   - a **persistent** layer of committed lines (one per *completed* `forward`), and
 *   - a **transient** overlay: the turtle marker plus the in-progress pen trail of the
 *     stroke currently animating.
 *
 * A completed `forward` commits its line (`endStroke(true)`); a `forward` interrupted by
 * the stop button discards its in-progress trail (`endStroke(false)`) — so the canvas ever
 * shows only whole, finished strokes, matching "the pending capability request is
 * discarded" (E§10.1). Working in turtle coordinates keeps the surface independent of
 * canvas size; the concrete `CanvasSurface` maps to pixels via [`turtleToPixel`].
 */
export interface DrawingSurface {
  /** Begin animating a pen stroke toward `seg.(x1, y1)`. The surface may preview a growing
   *  trail up to the marker each frame; `seg.color.a === 0` is a pen-up glide (no trail). */
  beginStroke(seg: LineSegment): void;
  /** Pose the turtle marker — called once per animation frame (the moving pen tip) and for
   *  the instant poses (`set_turtle`: turns, teleports, show/hide). */
  setMarker(marker: Marker): void;
  /** Finish the current stroke: `commit` draws its full segment permanently (a completed
   *  `forward`); `!commit` discards the in-progress trail (an interrupted `forward`). */
  endStroke(commit: boolean): void;
  /** Erase the persistent layer and clear the overlay (`clear_canvas`). */
  clear(): void;
}

/**
 * Maps a point in turtle coordinates (origin center, y up) to canvas pixels (origin
 * top-left, y down) for a `width × height` canvas. Pure — unit-tested directly, and the
 * only place the coordinate convention is encoded.
 */
export function turtleToPixel(
  x: number,
  y: number,
  width: number,
  height: number,
): readonly [number, number] {
  return [width / 2 + x, height / 2 - y];
}
