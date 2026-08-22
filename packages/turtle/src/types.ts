// The small value types the turtle renderer speaks — all in **turtle coordinates**
// (origin at the center, x growing right, y growing UP; heading in degrees, 0 pointing up
// and increasing clockwise), matching the turtle library's own convention. The host is a
// dumb drawing surface: the library computes every coordinate and color channel and the
// renderer only maps them to pixels.

/** An RGBA color, each channel 0..255 (the turtle library packs these; `a === 0` is a
 *  pen-up glide — the turtle moves but leaves no mark). */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** A pen stroke in turtle coordinates: from `(x0, y0)` to `(x1, y1)` in `color`. */
export interface LineSegment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly color: Color;
}

/** The turtle marker's pose: where it sits, where it points, and whether it shows. */
export interface Marker {
  readonly x: number;
  readonly y: number;
  /** Heading in degrees; 0 points up, increasing clockwise. */
  readonly heading: number;
  readonly visible: boolean;
}
