// End-to-end: drive real Doodle turtle programs through the wasm engine + the pump
// (@doodle-lang/engine) + the turtle handlers, and assert the committed path. This proves
// the whole chain — the Doodle turtle library's geometry, the suspending platform
// primitives, the fuel-sliced pump, and the animated handlers — renders correctly, and
// pins the S-23 stop-mid-`forward` contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadEngine, DoodleInstance, pump } from '@doodle-lang/engine';
import { createTurtleHandlers } from '../dist/index.js';
import { MockSurface } from '../test-support/mock-surface.mjs';

const wasmBytes = readFileSync(new URL('../../engine/wasm/doodle_wasm_bg.wasm', import.meta.url));
const scheduler = (resume) => setImmediate(resume);
// One animation frame per macrotask, so `await pump(...)` runs a paced turtle program
// straight to completion (the pump awaits each animated forward).
const autoFrames = (cb) => setImmediate(cb);

/** Asserts a committed segment runs from `start` to `end` (turtle coords) within `eps`.
 *  Endpoints go through libm sin/cos, so they are deterministic but not clean integers. */
function assertSegment(seg, start, end, eps = 1e-6) {
  assert.ok(
    Math.abs(seg.x0 - start[0]) < eps && Math.abs(seg.y0 - start[1]) < eps,
    `start ${JSON.stringify([seg.x0, seg.y0])} != ${JSON.stringify(start)}`,
  );
  assert.ok(
    Math.abs(seg.x1 - end[0]) < eps && Math.abs(seg.y1 - end[1]) < eps,
    `end ${JSON.stringify([seg.x1, seg.y1])} != ${JSON.stringify(end)}`,
  );
}

test('a hexagon via the library repeat/block commits six sides', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('repeat(6) do\n  forward(30)\n  right(60)\nend\n');
  const surface = new MockSurface();
  const handlers = createTurtleHandlers({ surface, frames: autoFrames, speed: 30 });
  const outcome = await pump(inst, { scheduler, onCapability: handlers.onCapability });

  assert.equal(outcome.kind, 'completed');
  assert.equal(surface.committed.length, 6, 'six forward strokes');
  assertSegment(surface.committed[0], [0, 0], [0, 30]); // first side straight up
  inst.free();
});

test('a while-loop spiral renders end-to-end (twenty growing sides)', async () => {
  await loadEngine(wasmBytes);
  const src =
    'let side = 5\n' +
    'let n = 0\n' +
    'while n < 20 do\n' +
    '  forward(side)\n' +
    '  right(30)\n' +
    '  side = side + 3\n' +
    '  n = n + 1\n' +
    'end\n';
  const inst = DoodleInstance.turtle(src);
  const surface = new MockSurface();
  const handlers = createTurtleHandlers({ surface, frames: autoFrames, speed: 50 });
  const outcome = await pump(inst, { scheduler, onCapability: handlers.onCapability });

  assert.equal(outcome.kind, 'completed');
  assert.equal(surface.committed.length, 20);
  assertSegment(surface.committed[0], [0, 0], [0, 5]); // first side: length 5, straight up
  inst.free();
});

test('a named pen color reaches the committed line as RGBA', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('pencolor("red")\nforward(10)\n');
  const surface = new MockSurface();
  const handlers = createTurtleHandlers({ surface, frames: autoFrames, speed: 10 });
  const outcome = await pump(inst, { scheduler, onCapability: handlers.onCapability });

  assert.equal(outcome.kind, 'completed');
  assert.equal(surface.committed.length, 1);
  assert.deepEqual(surface.committed[0].color, { r: 255, g: 0, b: 0, a: 255 });
  inst.free();
});

test('stop during an animated forward faults Cancelled, discards the line, and a late resolve errors', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('forward(100)\nforward(100)\n');
  const controller = new AbortController();
  const surface = new MockSurface();
  // Abort on the 2nd animation frame — mid the FIRST forward (100 units at speed 10 = 10 frames).
  let frame = 0;
  const frames = (cb) =>
    setImmediate(() => {
      if (++frame === 2) controller.abort();
      cb();
    });
  const handlers = createTurtleHandlers({ surface, frames, signal: controller.signal, speed: 10 });

  const outcome = await pump(inst, { scheduler, signal: controller.signal, onCapability: handlers.onCapability });

  assert.equal(outcome.kind, 'faulted');
  assert.equal(outcome.fault, 'cancelled');
  assert.deepEqual(surface.committed, [], 'the interrupted forward committed no line');
  assert.equal(surface.discarded, 1, 'the interrupted forward was discarded (S-23)');

  // A late resolve on the now-terminal instance errors rather than silently resuming: the
  // release build faults `internal` (the host-contract-violation guard, E§3.3/§10.1).
  const late = inst.resolve(inst.makeNil(), false, undefined);
  assert.equal(late.kind, 'faulted');
  assert.equal(late.fault, 'internal');
  late.free();
  inst.free();
});
