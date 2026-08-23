// End-to-end tests of the fuel-sliced pump against the real wasm engine, driven in Node
// with an injected `setImmediate` scheduler (the same pump code the browser runs — only
// the scheduler differs, AD6). Run after `npm run build-wasm` and `npm run build`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadEngine, DoodleInstance, pump } from '../dist/index.js';

const wasmBytes = readFileSync(new URL('../wasm/doodle_wasm_bg.wasm', import.meta.url));
/** The Node analogue of the browser frame scheduler (implementation-plan AD6). */
const scheduler = (resume) => setImmediate(resume);

test('drives print to completion, capturing output', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.demo('print(1 + 2)\n');
  let out = '';
  const outcome = await pump(inst, { scheduler, onOutput: (t) => (out += t) });
  assert.equal(outcome.kind, 'completed');
  assert.equal(out, '3\n');
  inst.free();
});

test('a turtle forward suspends draw_line as a capability the handler resolves', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('forward(10)\n');
  const calls = [];
  const outcome = await pump(inst, {
    scheduler,
    // A `to` capability yields Void: return undefined. This is the capability→Promise
    // round-trip the animated `forward` will use (M3.6).
    onCapability: (call) => {
      calls.push(call);
      return undefined;
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, 3, 'draw_line is capability id 3');
  assert.equal(calls[0].args.length, 8);
  // args = [x0, y0, x1, y1, r, g, b, a]; coords are floats (number), channels ints (bigint).
  // forward(10) at heading 0 draws (0,0)->(0,10) opaque black.
  assert.equal(calls[0].args[3], 10, 'new y = 10 (a float)');
  assert.equal(calls[0].args[7], 255n, 'alpha = 255 (an int)');
  inst.free();
});

test('an async capability handler paces the drive (Promise round-trip)', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('forward(1)\nforward(1)\n');
  let resolved = 0;
  const outcome = await pump(inst, {
    scheduler,
    onCapability: async () => {
      await new Promise((r) => setImmediate(r)); // simulate an animation frame
      resolved += 1;
      return undefined;
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(resolved, 2, 'both forwards awaited their handler');
  inst.free();
});

test('the stop signal cancels a running program between slices', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.demo('loop do\n1\nend\n');
  const controller = new AbortController();
  let slices = 0;
  const outcome = await pump(inst, {
    signal: controller.signal,
    scheduler: (resume) => {
      if (++slices >= 3) controller.abort();
      setImmediate(resume);
    },
  });
  assert.equal(outcome.kind, 'faulted');
  assert.equal(outcome.fault, 'cancelled');
  inst.free();
});

test('the stop signal cancels a CAPABILITY-suspending loop, not just compute loops', async () => {
  // The main animated-turtle shape: a loop whose body suspends a capability every
  // iteration, so a slice-end pause is never reached. The stop must still work — the pump
  // polls the signal in the suspend branch, cancels, and the resumed drive faults Cancelled.
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('loop do\nforward(1)\nend\n');
  const controller = new AbortController();
  let caps = 0;
  const outcome = await pump(inst, {
    signal: controller.signal,
    scheduler,
    onCapability: () => {
      if (++caps >= 5) controller.abort();
      return undefined;
    },
  });
  assert.equal(outcome.kind, 'faulted');
  assert.equal(outcome.fault, 'cancelled');
  inst.free();
});

test('a throwing capability handler surfaces as a Doodle raise at the call site', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('forward(1)\n');
  const outcome = await pump(inst, {
    scheduler,
    onCapability: () => {
      throw new Error('host refused');
    },
  });
  assert.equal(outcome.kind, 'raised');
  assert.match(outcome.message, /host refused/);
  inst.free();
});

test('incremental output across many slices concatenates correctly, incl. multi-byte', async () => {
  await loadEngine(wasmBytes);
  // Tiny fuel forces many slices so the outputSeen delta path runs repeatedly; the values
  // include multi-byte UTF-8 (é, β).
  const inst = DoodleInstance.demo('print("café")\nprint("β")\nprint(2 + 2)\n');
  let out = '';
  const outcome = await pump(inst, { fuelPerSlice: 1n, scheduler, onOutput: (t) => (out += t) });
  assert.equal(outcome.kind, 'completed');
  assert.equal(out, 'café\nβ\n4\n');
  assert.equal(out, new TextDecoder().decode(inst.output()), 'deltas concatenate to the full output');
  inst.free();
});

test('an uncaught raise surfaces as a raised outcome with its kind', async () => {
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.demo('1 / 0\n');
  const outcome = await pump(inst, { scheduler });
  assert.equal(outcome.kind, 'raised');
  assert.equal(outcome.exceptionKind, 'division-by-zero');
  inst.free();
});

test('a bignum capability argument decodes to a JS bigint, not a wedge', async () => {
  // A Doodle integer is arbitrary-precision (L§4.2). `pencolor(r,g,b)` stores its channels
  // and `forward` passes them to `draw_line`, so a huge `r` arrives as a bignum capability
  // argument (beyond i64). The decode must carry it as a JS bigint and the run must reach a
  // terminal state — before the total int boundary, the i64 reader threw out of the pump and
  // left the instance stuck Suspended (the M3.9 review finding).
  await loadEngine(wasmBytes);
  const huge = 10n ** 30n;
  const inst = DoodleInstance.turtle(`pencolor(${huge}, 0, 0)\nforward(1)\n`);
  let seen;
  const outcome = await pump(inst, {
    scheduler,
    onCapability: (call) => {
      if (call.capability === 3) seen = call.args[4]; // draw_line: [x0,y0,x1,y1,r,g,b,a]
      return undefined;
    },
  });
  assert.equal(outcome.kind, 'completed', 'the run terminates instead of wedging');
  assert.equal(typeof seen, 'bigint');
  assert.equal(seen, huge, 'the bignum crosses the boundary intact');
  inst.free();
});

test('a stop that races a handler-throw faults Cancelled, not raised (S-23)', async () => {
  // If a capability handler throws AND the stop signal is aborted on the same call, the
  // pump cancels then resolves-WITH-RAISE. A pending cancel must win over the host raise:
  // the run faults `cancelled`, not `raised` (E§10.1 S-23 — the engine's raise arm reaps
  // the cancel instead of surfacing the rejection).
  await loadEngine(wasmBytes);
  const inst = DoodleInstance.turtle('forward(1)\nforward(1)\n');
  const controller = new AbortController();
  const outcome = await pump(inst, {
    scheduler,
    signal: controller.signal,
    onCapability: () => {
      controller.abort(); // stop pressed...
      throw new Error('host boom'); // ...as the handler also fails, on the same call
    },
  });
  assert.equal(outcome.kind, 'faulted');
  assert.equal(outcome.fault, 'cancelled', 'cancel wins over the racing raise');
  inst.free();
});
