// Unit tests of the turtle handlers in isolation — no wasm, no pump. Capability calls are
// crafted directly (matching the pump's decoded shape: coords are `number`, color channels
// and heading are `bigint`), and a manual frame driver steps the animation deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurtleHandlers, turtleToPixel, DRAW_LINE, SET_TURTLE, CLEAR_CANVAS } from '../dist/index.js';
import { MockSurface } from '../test-support/mock-surface.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A manual animation clock: frames advance only when the test calls `flush()`. */
function manualFrames() {
  let queued = [];
  return {
    frames: (cb) => queued.push(cb),
    flush: () => {
      const cbs = queued;
      queued = [];
      for (const cb of cbs) cb();
    },
    get pending() {
      return queued.length;
    },
  };
}

/** Drives a handler promise to completion, flushing any queued frames between microtasks. */
async function drive(promise, driver) {
  let done = false;
  promise.then(() => (done = true));
  for (let guard = 0; guard < 10000 && !done; guard++) {
    if (driver.pending > 0) driver.flush();
    await tick();
  }
  return promise;
}

const drawLine = (x0, y0, x1, y1, r = 0, g = 0, b = 0, a = 255) => ({
  capability: DRAW_LINE,
  args: [x0, y0, x1, y1, BigInt(r), BigInt(g), BigInt(b), BigInt(a)],
});

test('turtleToPixel maps the origin to the center and y upward', () => {
  assert.deepEqual(turtleToPixel(0, 0, 200, 100), [100, 50]);
  assert.deepEqual(turtleToPixel(10, 10, 200, 100), [110, 40]); // +x right, +y up
  assert.deepEqual(turtleToPixel(-10, -10, 200, 100), [90, 60]);
});

test('an animated forward glides over ceil(distance/speed) frames and commits its line', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames, speed: 10 });

  // forward from (0,0) to (0,30): distance 30, speed 10 => exactly 3 frames.
  await drive(onCapability(drawLine(0, 0, 0, 30)), driver);

  assert.equal(surface.markers.length, 3, 'one marker pose per frame');
  assert.deepEqual(
    surface.markers.map((m) => m.y),
    [10, 20, 30],
    'the pen tip advances 10 turtle units per frame',
  );
  assert.equal(surface.committed.length, 1);
  assert.deepEqual(
    { x0: surface.committed[0].x0, y0: surface.committed[0].y0, x1: surface.committed[0].x1, y1: surface.committed[0].y1 },
    { x0: 0, y0: 0, x1: 0, y1: 30 },
  );
  assert.equal(surface.discarded, 0);
});

test('a pen-up forward (alpha 0) still glides the marker but its line is invisible', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames, speed: 10 });

  await drive(onCapability(drawLine(0, 0, 20, 0, 0, 0, 0, 0)), driver); // alpha 0

  assert.equal(surface.markers.length, 2, 'still glides (distance 20 / speed 10 = 2 frames)');
  assert.equal(surface.committed.length, 1);
  assert.equal(surface.committed[0].color.a, 0, 'committed with alpha 0 — the renderer draws no trail');
});

test('stop mid-forward returns promptly, discards the trail, and commits nothing', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const controller = new AbortController();
  const { onCapability } = createTurtleHandlers({
    surface,
    frames: driver.frames,
    signal: controller.signal,
    speed: 1, // 40 frames for a length-40 forward — plenty of room to stop mid-stroke
  });

  const promise = onCapability(drawLine(0, 0, 40, 0));
  driver.flush(); // frame 1
  await tick();
  assert.equal(surface.markers.length, 1, 'one frame elapsed');

  controller.abort(); // STOP mid-stroke
  await drive(promise, driver);

  assert.equal(surface.discarded, 1, 'the interrupted stroke was discarded');
  assert.equal(surface.committed.length, 0, 'nothing committed');
  assert.ok(surface.markers.length < 40, 'the animation stopped early');
});

test('set_turtle poses the marker instantly and its heading/visibility persist into a forward', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames, speed: 10 });

  // set_turtle(5, 6, 90, true) — heading 90 (an int -> bigint), visible.
  await onCapability({ capability: SET_TURTLE, args: [5, 6, 90n, true] });
  assert.equal(surface.markers.length, 1);
  assert.deepEqual(surface.lastMarker(), { x: 5, y: 6, heading: 90, visible: true });

  // A following forward glides with the remembered heading (90) and visibility.
  await drive(onCapability(drawLine(5, 6, 25, 6)), driver);
  const glideMarkers = surface.markers.slice(1);
  assert.ok(glideMarkers.length > 0);
  assert.ok(glideMarkers.every((m) => m.heading === 90 && m.visible === true));
});

test('a hidden turtle stays hidden while it glides', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames, speed: 10 });

  await onCapability({ capability: SET_TURTLE, args: [0, 0, 0n, false] }); // hideturtle
  await drive(onCapability(drawLine(0, 0, 0, 20)), driver);
  const glideMarkers = surface.markers.slice(1);
  assert.ok(glideMarkers.length > 0, 'the turtle actually glided');
  assert.ok(glideMarkers.every((m) => m.visible === false));
});

test('clear_canvas wipes the surface', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames, speed: 10 });

  await drive(onCapability(drawLine(0, 0, 0, 10)), driver);
  assert.equal(surface.committed.length, 1);
  await onCapability({ capability: CLEAR_CANVAS, args: [] });
  assert.equal(surface.clears, 1);
  assert.equal(surface.committed.length, 0);
});

test('an unknown capability id throws (a misconfiguration, surfaced as a raise by the pump)', async () => {
  const surface = new MockSurface();
  const driver = manualFrames();
  const { onCapability } = createTurtleHandlers({ surface, frames: driver.frames });
  await assert.rejects(() => onCapability({ capability: 99, args: [] }), /unhandled capability id 99/);
});
