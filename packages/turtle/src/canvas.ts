// A `DrawingSurface` backed by a 2D canvas context — the browser renderer. It owns the
// turtle scene (the committed pen lines and the marker pose) and repaints on every frame,
// so the moving pen tip and marker never smear the persistent trail. Not exercised by the
// headless tests (a real context is a browser concern, M3.7); the tested logic lives in
// the handlers and the pure `turtleToPixel` mapping.

import type { DrawingSurface } from './surface.js';
import { turtleToPixel } from './surface.js';
import type { Color, LineSegment, Marker } from './types.js';

export interface CanvasConfig {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** Turtle-marker size in pixels (default 10). */
  readonly markerSize?: number;
  /** A solid background repainted on every redraw; omit for a transparent canvas. */
  readonly background?: string;
  /** Pen line width in pixels (default 2). */
  readonly lineWidth?: number;
}

const DEFAULT_MARKER_SIZE = 10;
const DEFAULT_LINE_WIDTH = 2;
const MARKER_FILL = '#22cc77';

export class CanvasSurface implements DrawingSurface {
  readonly #ctx: CanvasRenderingContext2D;
  readonly #width: number;
  readonly #height: number;
  readonly #markerSize: number;
  readonly #lineWidth: number;
  readonly #background: string | undefined;

  readonly #committed: LineSegment[] = [];
  #stroke: LineSegment | null = null;
  #tip: { x: number; y: number } | null = null;
  #marker: Marker = { x: 0, y: 0, heading: 0, visible: true };

  constructor(config: CanvasConfig) {
    this.#ctx = config.ctx;
    this.#width = config.width;
    this.#height = config.height;
    this.#markerSize = config.markerSize ?? DEFAULT_MARKER_SIZE;
    this.#lineWidth = config.lineWidth ?? DEFAULT_LINE_WIDTH;
    this.#background = config.background;
    this.#redraw();
  }

  beginStroke(seg: LineSegment): void {
    this.#stroke = seg;
    this.#tip = { x: seg.x0, y: seg.y0 };
    this.#redraw();
  }

  setMarker(marker: Marker): void {
    this.#marker = marker;
    // During a stroke the marker is the pen tip, so the previewed trail grows with it.
    if (this.#stroke) this.#tip = { x: marker.x, y: marker.y };
    this.#redraw();
  }

  endStroke(commit: boolean): void {
    if (commit && this.#stroke) this.#committed.push(this.#stroke);
    this.#stroke = null;
    this.#tip = null;
    this.#redraw();
  }

  clear(): void {
    this.#committed.length = 0;
    this.#stroke = null;
    this.#tip = null;
    this.#redraw();
  }

  #redraw(): void {
    const ctx = this.#ctx;
    if (this.#background !== undefined) {
      ctx.fillStyle = this.#background;
      ctx.fillRect(0, 0, this.#width, this.#height);
    } else {
      ctx.clearRect(0, 0, this.#width, this.#height);
    }
    ctx.lineWidth = this.#lineWidth;
    for (const seg of this.#committed) this.#drawSegment(seg, seg.x1, seg.y1);
    if (this.#stroke && this.#tip) this.#drawSegment(this.#stroke, this.#tip.x, this.#tip.y);
    if (this.#marker.visible) this.#drawMarker(this.#marker);
  }

  #drawSegment(seg: LineSegment, toX: number, toY: number): void {
    if (seg.color.a <= 0) return; // pen-up glide: no visible trail
    const ctx = this.#ctx;
    const [px0, py0] = turtleToPixel(seg.x0, seg.y0, this.#width, this.#height);
    const [px1, py1] = turtleToPixel(toX, toY, this.#width, this.#height);
    ctx.strokeStyle = cssColor(seg.color);
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.stroke();
  }

  #drawMarker(marker: Marker): void {
    // An isoceles triangle pointing along the heading. Local points are in a y-up,
    // heading-0-is-up frame; rotating by `heading` with the y-down screen matrix turns the
    // triangle clockwise, matching the turtle convention.
    const ctx = this.#ctx;
    const [cx, cy] = turtleToPixel(marker.x, marker.y, this.#width, this.#height);
    const rad = (marker.heading * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const s = this.#markerSize;
    const local: ReadonlyArray<readonly [number, number]> = [
      [0, -s],
      [s * 0.6, s * 0.7],
      [-s * 0.6, s * 0.7],
    ];
    ctx.beginPath();
    local.forEach(([lx, ly], i) => {
      const x = cx + (lx * cos - ly * sin);
      const y = cy + (lx * sin + ly * cos);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = MARKER_FILL;
    ctx.fill();
  }
}

/** A `rgba(...)` CSS string from an 0..255 RGBA color (alpha scaled to 0..1). */
function cssColor(c: Color): string {
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${channel(c.a) / 255})`;
}
function channel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
