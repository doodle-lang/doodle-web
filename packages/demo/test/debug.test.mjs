// Node tests of the debugger core (src/debug/): the actual DebugSession driver over the real
// wasm engine, driven headlessly with a mock DrawingSurface and a synchronous clock. Covers the
// end-to-end acceptance (M6.9): set a breakpoint, debug to it, inspect variables, step, resume;
// plus raise-trap (pre-unwind) and watch-it-run (a fine subexpression stop with its value). The
// browser DOM wiring (gutter, panels, buttons) is covered by the Playwright smoke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadEngine, stackWalk, moduleGlobals } from '@doodle-lang/engine';
import { DebugSession } from '../dist/debug/session.js';

const wasmBytes = readFileSync(new URL('../../engine/wasm/doodle_wasm_bg.wasm', import.meta.url));
const autoFrames = (cb) => setImmediate(cb);
const scheduler = (cb) => setImmediate(cb);

/** A no-op DrawingSurface (the tests assert engine state, not pixels). */
class MockSurface {
  beginStroke() {}
  setMarker() {}
  endStroke() {}
  clear() {}
}

function newSession(source) {
  return new DebugSession(source, { surface: new MockSurface(), frames: autoFrames, scheduler, speed: 100 });
}

await loadEngine(wasmBytes);

test('a breakpoint pauses Debug, exposes module variables, steps, and resumes', async () => {
  const source = 'let a = 1\nlet b = 2\nforward(a + b)\nprint("done")\n';
  const session = newSession(source);
  const set = session.toggleBreakpoint(3); // editor line 3: forward(a + b)
  assert.equal(set, true);

  const stop = await session.run('continue');
  assert.equal(stop.kind, 'paused');
  assert.equal(stop.reason, 'breakpoint');
  assert.equal(stop.line, 3, 'paused at the user-program breakpoint line');

  // The top frame's home module carries the program's globals (among the turtle library's).
  const walk = stackWalk(session.instance);
  const top = walk.frames.find((f) => !f.elided);
  assert.ok(top && top.module !== undefined, 'a live frame with a home module');
  const globals = moduleGlobals(session.instance, top.module);
  const a = globals.find((g) => g.name === 'a');
  const b = globals.find((g) => g.name === 'b');
  assert.ok(a && b, 'the program globals a and b are listed');
  const handle = session.instance.moduleGlobalValue(walk.generation, top.module, a.slot);
  assert.equal(session.instance.asInt(handle), 1n);
  session.instance.release(handle);

  // Step past the breakpoint, then resume to completion.
  const stepped = await session.run('step');
  assert.equal(stepped.kind, 'paused');
  const done = await session.run('continue');
  assert.equal(done.kind, 'completed');
  session.free();
});

test('raise-trap pauses at the raise (pre-unwind), then resumes to the uncaught raise', async () => {
  const session = newSession('let x = 1\nraise "boom"\n');
  session.setRaiseTrap(true);

  const stop = await session.run('continue');
  assert.equal(stop.kind, 'paused');
  assert.equal(stop.reason, 'raise-trap');
  assert.equal(stop.line, 2, 'paused at the raise site');

  const raised = session.instance.trappedRaise();
  assert.notEqual(raised, undefined);
  assert.equal(new TextDecoder().decode(session.instance.stringBytes(raised)), 'boom');
  session.instance.release(raised);

  const final = await session.run('continue');
  assert.equal(final.kind, 'raised');
  assert.ok(final.message.includes('boom'));
  session.free();
});

test('watch-it-run stops at a subexpression with its just-produced value', async () => {
  const session = newSession('let x = 2 + 3 * 4\nprint(x)\n');
  session.setWatch(true);

  let sawValue = false;
  let stop = await session.run('step');
  for (let i = 0; i < 40 && stop.kind === 'paused'; i += 1) {
    if (session.instance.completedSpan()) {
      const handle = session.instance.currentResult();
      if (handle !== undefined) {
        sawValue = true;
        session.instance.release(handle);
      }
    }
    stop = await session.run('step');
  }
  assert.ok(sawValue, 'a fine subexpression stop exposed a just-produced value');
  session.free();
});

test('a value tree materializes a record without holding live handles', async () => {
  const { materializeValue } = await import('../dist/debug/inspect.js');
  const source = 'record Point with x, y end\nfn make()\n  let p = Point(x: 1, y: 2)\n  print("x")\n  p\nend\nmake()\n';
  const session = newSession(source);
  session.toggleBreakpoint(4); // inside make(), after p is bound (print("x"))
  const stop = await session.run('continue');
  assert.equal(stop.kind, 'paused');

  const walk = stackWalk(session.instance);
  const frame = walk.frames[0]; // the make() frame
  const slot = frame.locals.indexOf('p');
  assert.ok(slot >= 0, 'local p is in scope');
  const handle = session.instance.frameLocal(walk.generation, 0, slot);
  const node = materializeValue(session.instance, handle);
  session.instance.release(handle);
  assert.equal(node.kind, 'record');
  assert.match(node.summary, /Point/);
  const fields = Object.fromEntries(node.children.map((c) => [c.label, c.value.summary]));
  assert.equal(fields.x, '1');
  assert.equal(fields.y, '2');
  session.free();
});
