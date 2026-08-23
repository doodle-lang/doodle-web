// Node tests of the demo's run core (src/run.ts) — the actual editor→run→pump→turtle
// wiring, driven headlessly with a mock DrawingSurface and the real wasm engine. The
// browser glue (mounting the editor, buttons, real canvas) is covered by the Playwright
// smoke (test/browser.spec.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadEngine } from '@doodle-lang/engine';
import { runTurtleProgram } from '../dist/run.js';

const wasmBytes = readFileSync(new URL('../../engine/wasm/doodle_wasm_bg.wasm', import.meta.url));
/** One animation frame per macrotask, so `await runTurtleProgram(...)` runs to completion. */
const autoFrames = (cb) => setImmediate(cb);

/** A recording DrawingSurface: keeps the committed pen lines. */
class MockSurface {
  constructor() {
    this.committed = [];
    this.cleared = 0;
    this._stroke = null;
  }
  beginStroke(seg) {
    this._stroke = seg;
  }
  setMarker() {}
  endStroke(commit) {
    if (commit && this._stroke) this.committed.push(this._stroke);
    this._stroke = null;
  }
  clear() {
    this.cleared += 1;
    this.committed.length = 0;
  }
}

test('runs a turtle program: draws its path and streams print output', async () => {
  await loadEngine(wasmBytes);
  const surface = new MockSurface();
  let out = '';
  const result = await runTurtleProgram(
    'pencolor("red")\nforward(50)\nright(90)\nforward(50)\nprint("done")\n',
    { surface, frames: autoFrames, speed: 25, onOutput: (t) => (out += t) },
  );
  assert.equal(result.kind, 'completed');
  assert.equal(surface.committed.length, 2, 'two forwards → two committed lines');
  assert.deepEqual(surface.committed[0].color, { r: 255, g: 0, b: 0, a: 255 }, 'pencolor applied');
  assert.equal(out, 'done\n');
});

test('onLine reports the user-program line of each turtle command (skipping the library)', async () => {
  await loadEngine(wasmBytes);
  const surface = new MockSurface();
  const lines = [];
  await runTurtleProgram('forward(20)\nright(90)\nforward(20)\n', {
    surface,
    frames: autoFrames,
    speed: 25,
    onLine: (line) => {
      if (lines[lines.length - 1] !== line) lines.push(line); // dedup consecutive samples
    },
  });
  // forward→draw_line (lines 1,3), right→set_turtle (line 2): the user's lines, not the
  // turtle library's draw_line/set_turtle call sites.
  assert.deepEqual(lines, [1, 2, 3]);
});

test('a load error is returned (not thrown) for the output pane', async () => {
  await loadEngine(wasmBytes);
  const surface = new MockSurface();
  const result = await runTurtleProgram('let x =\n', { surface, frames: autoFrames });
  assert.equal(result.kind, 'load-error');
  assert.ok(result.message.length > 0);
});

test('stop cancels a running program mid-draw', async () => {
  await loadEngine(wasmBytes);
  const surface = new MockSurface();
  const controller = new AbortController();
  let frame = 0;
  const frames = (cb) =>
    setImmediate(() => {
      if (++frame >= 8) controller.abort();
      cb();
    });
  const result = await runTurtleProgram('loop do\n  forward(5)\nend\n', {
    surface,
    frames,
    signal: controller.signal,
    speed: 2,
  });
  assert.equal(result.kind, 'faulted');
  assert.equal(result.fault, 'cancelled');
});
