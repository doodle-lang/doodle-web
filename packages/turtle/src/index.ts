// @doodle-lang/turtle — turtle graphics for the browser: a canvas renderer and the
// animated capability handlers that drive it from a pumped Doodle turtle program
// (@doodle-lang/engine). The Doodle turtle library computes all geometry and issues three
// platform-primitive capabilities; this package fulfils them on a `DrawingSurface`.

export type { Color, LineSegment, Marker } from './types.js';
export type { DrawingSurface } from './surface.js';
export { turtleToPixel } from './surface.js';
export { CanvasSurface } from './canvas.js';
export type { CanvasConfig } from './canvas.js';
export { createTurtleHandlers, DRAW_LINE, SET_TURTLE, CLEAR_CANVAS } from './turtle.js';
export type { FrameSource, TurtleHandlers, TurtleHandlersOptions } from './turtle.js';
