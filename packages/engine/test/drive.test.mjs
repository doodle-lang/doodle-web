// The cross-surface DEBUG conformance gate (implementation-plan §4.3, D-M6-2): drive every
// `mode: drive` fixture from doodle-rust THROUGH THE WASM SURFACE and compare its
// outcome/position/stack **transcript** against the fixture's own `#! do:`/`expect:`/`stack:`
// script — exactly as the native `conformance-runner` does (drivescript.rs + drive.rs).
// Passing here certifies the wasm debug bindings (breakpoints, raise-trap, observation mode,
// stepping, the stack walk) preserve engine determinism: identical pause reasons, positions,
// and stack shapes on the wasm surface as on native.
//
// This is a JS port of the reference parser/executor; the format is normative in
// doodle-rust/conformance/README.md. Fixtures live in the sibling checkout;
// DOODLE_CONFORMANCE_DIR overrides its root (this reads the `v0.1/eng/` drive subtree).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadEngine, DoodleInstance } from '../dist/index.js';

const wasmBytes = readFileSync(new URL('../wasm/doodle_wasm_bg.wasm', import.meta.url));

const engRoot =
  process.env.DOODLE_CONFORMANCE_DIR ??
  fileURLToPath(new URL('../../../../doodle-rust/conformance/v0.1/', import.meta.url));
const driveDir = join(engRoot, 'eng');

// --- the drive-script parser (port of drivescript.rs) ---

/** `<substring> @ <line>:<col>` → { substring, line, column } (matching directive.rs). */
function parsePositioned(value) {
  const at = value.lastIndexOf('@');
  if (at < 0) throw new Error(`expected \`… @ line:col\`, got ${JSON.stringify(value)}`);
  const substring = value.slice(0, at).trim();
  const [line, column] = value
    .slice(at + 1)
    .trim()
    .split(':')
    .map((n) => Number.parseInt(n, 10));
  return { substring, line, column };
}

/** Parses a fixture's `#!` drive header into { breakpoints, raiseTrap, subexpr, steps }. */
function parseDriveScript(source) {
  const raw = [];
  for (const line of source.split('\n')) {
    const m = /^#!\s*([a-z-]+):\s*(.*)$/.exec(line);
    if (m) raw.push([m[1], m[2].trim()]);
  }
  const script = { breakpoints: [], raiseTrap: false, subexpr: false, steps: [] };
  let building = null;
  let seenDo = false;
  const finish = () => {
    if (!building) return;
    if (!building.expect) throw new Error('`#! do:` with no `#! expect:`');
    script.steps.push(building);
    building = null;
  };
  for (const [key, value] of raw) {
    switch (key) {
      case 'clause':
      case 'mode':
        break; // fixture metadata, not part of the drive script
      case 'break': {
        if (seenDo) throw new Error('`break:` must precede the first `do:`');
        const parts = value.split(/\s+/);
        const [canonical, lineStr] = parts.length === 1 ? ['main', parts[0]] : parts;
        script.breakpoints.push([canonical, Number.parseInt(lineStr, 10)]);
        break;
      }
      case 'raise-trap':
        if (seenDo) throw new Error('`raise-trap:` must precede the first `do:`');
        script.raiseTrap = value === 'on';
        break;
      case 'obs':
        if (seenDo) throw new Error('`obs:` must precede the first `do:`');
        script.subexpr = value === 'subexpr';
        break;
      case 'do':
        finish();
        seenDo = true;
        building = { action: value, expect: null, stack: null };
        break;
      case 'expect':
        if (!building) throw new Error('`#! expect:` with no preceding `#! do:`');
        building.expect = parseStop(value);
        break;
      case 'stack':
        if (!building || !building.expect) throw new Error('`#! stack:` must follow an `expect:`');
        building.stack = value.split(',').map((e) => parseStackElem(e.trim()));
        break;
      default:
        throw new Error(`unknown drive directive \`#! ${key}:\``);
    }
  }
  finish();
  if (script.steps.length === 0) throw new Error('a drive fixture needs at least one `#! do:`');
  return script;
}

/** A `<stop>` assertion → a tagged object. */
function parseStop(value) {
  const sp = value.search(/\s/);
  const head = sp < 0 ? value : value.slice(0, sp);
  const rest = sp < 0 ? '' : value.slice(sp + 1).trim();
  switch (head) {
    case 'completed':
      return { type: 'completed' };
    case 'paused': {
      const { substring: reason, line, column } = parsePositioned(rest);
      return { type: 'paused', reason, pos: { line, column } };
    }
    case 'raised': {
      const { substring, line, column } = parsePositioned(rest);
      return { type: 'raised', substring, pos: { line, column } };
    }
    case 'suspended': {
      const { substring: id, line, column } = parsePositioned(rest);
      return { type: 'suspended', id, pos: { line, column } };
    }
    case 'faulted':
      if (!rest) throw new Error('`faulted` expects a fault kind');
      return { type: 'faulted', faultKind: rest };
    default:
      throw new Error(`unknown stop \`${head}\` in \`expect: ${value}\``);
  }
}

/** One stack element: `L`, `name@L`, or `name@L×N` (`x` accepted for `×`). */
function parseStackElem(elem) {
  if (!elem) throw new Error('empty stack element');
  let name;
  let rest = elem;
  const at = elem.indexOf('@');
  if (at >= 0) {
    name = elem.slice(0, at).trim();
    rest = elem.slice(at + 1).trim();
  }
  rest = rest.replace('×', 'x');
  let tail;
  const x = rest.indexOf('x');
  if (x >= 0) {
    tail = Number.parseInt(rest.slice(x + 1).trim(), 10);
    rest = rest.slice(0, x);
  }
  return { name, line: Number.parseInt(rest.trim(), 10), tail };
}

// --- the executor (port of drive.rs) ---

/** Byte offset in NFC `source` → { line, column } (1-based, column in code points). */
function positionAt(source, byteOffset) {
  const prefix = new TextDecoder().decode(new TextEncoder().encode(source).subarray(0, byteOffset));
  let line = 1;
  let column = 1;
  for (const ch of prefix) {
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** The wasm fault tag (`"limit:step-budget"`) → the drive-script fault kind (`"step-budget"`). */
function faultKind(tag) {
  return tag.startsWith('limit:') ? tag.slice('limit:'.length) : tag;
}

/** The position a `paused` stop reports (drive.rs::paused_position): the raise site for a
 *  raise-trap; the completed subexpression for a fine stop; else the construct about to run. */
function pausedOffset(inst, reason) {
  const span =
    reason === 'raise-trap' ? inst.trappedRaiseSpan() : (inst.completedSpan() ?? inst.currentSpan());
  return span ? span[0] : null;
}

/** Snapshots the DriveResult's fields (so it can be freed before reading instance state). */
function snapshotResult(result) {
  const kind = result.kind;
  const snap = { kind };
  if (kind === 'paused') snap.pauseReason = result.pauseReason;
  if (kind === 'raised') {
    snap.message = result.message ?? '';
    const s = result.raiseSpan;
    snap.raiseOffset = s ? s[0] : null;
  }
  if (kind === 'faulted') snap.fault = result.fault ?? 'unknown';
  result.free();
  return snap;
}

function posEq(a, b) {
  return a !== null && a.line === b.line && a.column === b.column;
}

function showPos(p) {
  return p ? `${p.line}:${p.column}` : '<none>';
}

/** Checks one step's stop transcript, appending any mismatch reasons. */
function checkStep(inst, snap, step, nfc, reasons) {
  const exp = step.expect;
  if (exp.type === 'completed') {
    if (snap.kind !== 'completed') reasons.push(`expected completed, got ${snap.kind}`);
  } else if (exp.type === 'paused') {
    if (snap.kind !== 'paused') {
      reasons.push(`expected paused ${exp.reason}, got ${snap.kind}`);
    } else {
      if (snap.pauseReason !== exp.reason) {
        reasons.push(`expected paused ${exp.reason}, got paused ${snap.pauseReason}`);
      }
      const off = pausedOffset(inst, snap.pauseReason);
      const pos = off === null ? null : positionAt(nfc, off);
      if (!posEq(pos, exp.pos)) {
        reasons.push(`expected ${exp.reason} @ ${showPos(exp.pos)}, got ${showPos(pos)}`);
      }
    }
  } else if (exp.type === 'raised') {
    if (snap.kind !== 'raised') {
      reasons.push(`expected raised, got ${snap.kind}`);
    } else {
      if (!snap.message.includes(exp.substring)) {
        reasons.push(`raise message ${JSON.stringify(snap.message)} lacks ${JSON.stringify(exp.substring)}`);
      }
      const pos = snap.raiseOffset === null ? null : positionAt(nfc, snap.raiseOffset);
      if (!posEq(pos, exp.pos)) {
        reasons.push(`expected raise @ ${showPos(exp.pos)}, got ${showPos(pos)}`);
      }
    }
  } else if (exp.type === 'faulted') {
    if (snap.kind !== 'faulted') reasons.push(`expected faulted ${exp.faultKind}, got ${snap.kind}`);
    else if (faultKind(snap.fault) !== exp.faultKind) {
      reasons.push(`expected faulted ${exp.faultKind}, got faulted ${faultKind(snap.fault)}`);
    }
  } else if (exp.type === 'suspended') {
    reasons.push('a `suspended` drive stop is not exercisable through the wasm surface yet (imports fault)');
  }
  if (step.stack) checkStack(inst, step.stack, nfc, reasons);
}

/** Checks the live-stack shape (drive.rs::check_stack) against `want`, innermost first. */
function checkStack(inst, want, nfc, reasons) {
  const walk = inst.stackWalk();
  const actual = walk.frames
    .filter((f) => !f.elided && f.callSite)
    .map((f) => ({
      name: f.callable ? f.callable.name : undefined,
      line: positionAt(nfc, f.callSite[0]).line,
      tail: f.tailCount,
    }));
  if (actual.length !== want.length) {
    reasons.push(`expected ${want.length}-frame stack, got ${actual.length}: ${JSON.stringify(actual)}`);
    return;
  }
  want.forEach((elem, i) => {
    const got = actual[i];
    if (elem.line !== got.line) reasons.push(`stack frame ${i}: expected line ${elem.line}, got ${got.line}`);
    if (elem.name !== undefined && got.name !== elem.name) {
      reasons.push(`stack frame ${i}: expected name ${JSON.stringify(elem.name)}, got ${JSON.stringify(got.name)}`);
    }
    if (elem.tail !== undefined && got.tail !== elem.tail) {
      reasons.push(`stack frame ${i}: expected tail ×${elem.tail}, got ×${got.tail}`);
    }
  });
}

/** Drives one fixture through the wasm surface, returning the transcript mismatch reasons. */
function runDriveFixture(source) {
  const script = parseDriveScript(source);
  let inst;
  try {
    inst = DoodleInstance.demo(source);
  } catch (err) {
    return [`load error through wasm: ${err instanceof Error ? err.message : String(err)}`];
  }
  const nfc = inst.source();
  for (const [canonical, line] of script.breakpoints) inst.setBreakpoint(canonical, line);
  if (script.raiseTrap) inst.setRaiseTrapping(true);
  if (script.subexpr) inst.setObservationMode(true);

  const reasons = [];
  script.steps.forEach((step, i) => {
    const snap = snapshotResult(inst.drive(step.action, undefined));
    const stepReasons = [];
    checkStep(inst, snap, step, nfc, stepReasons);
    for (const r of stepReasons) reasons.push(`step ${i + 1}: ${r}`);
  });
  inst.free();
  return reasons;
}

/** All `*.doodle` fixture paths under `dir`, recursively. */
function fixturePaths(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.doodle'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// --- register a subtest per drive fixture ---

assert.ok(existsSync(driveDir), `drive fixtures not found at ${driveDir} (set DOODLE_CONFORMANCE_DIR)`);

const driveFixtures = fixturePaths(driveDir)
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
  .filter(({ source }) => /^#!\s*mode:\s*drive\b/m.test(source));

assert.ok(driveFixtures.length > 0, `no 'mode: drive' fixtures found under ${driveDir}`);

await loadEngine(wasmBytes);

for (const { path, source } of driveFixtures) {
  const name = path.slice(driveDir.length).replace(/^\/+/, '');
  test(`drive-through-wasm: ${name}`, () => {
    const reasons = runDriveFixture(source);
    assert.deepEqual(reasons, [], `${name} diverged on the wasm surface:\n  ${reasons.join('\n  ')}`);
  });
}
