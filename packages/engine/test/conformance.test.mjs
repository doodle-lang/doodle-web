// The cross-surface conformance gate (implementation-plan §4.1): drive every `mode: run`
// conformance fixture from doodle-rust THROUGH THE WASM SURFACE (facade + pump) and match
// its transcript + outcome against the fixture's own `expect-out`/`expect-raise`
// directives — exactly as the native `conformance-runner` does (matcher.rs). Passing here
// certifies the wasm facade preserves engine determinism: identical output and raise
// (message + line:col position) on the wasm surface as on native.
//
// Fixtures live in the sibling doodle-rust checkout; DOODLE_CONFORMANCE_DIR overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadEngine, DoodleInstance, pump } from '../dist/index.js';

const wasmBytes = readFileSync(new URL('../wasm/doodle_wasm_bg.wasm', import.meta.url));
const scheduler = (resume) => setImmediate(resume);

const conformanceDir =
  process.env.DOODLE_CONFORMANCE_DIR ??
  fileURLToPath(new URL('../../../../doodle-rust/conformance/v0.1/lang/', import.meta.url));

/** Parses a fixture's `#! key: value` directive header (conformance/README.md). */
function parseDirectives(source) {
  const out = { mode: null, expectOut: [], expectRaise: null };
  for (const line of source.split('\n')) {
    const m = /^#!\s*([a-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'mode') out.mode = value.trim();
    else if (key === 'expect-out') out.expectOut.push(value);
    else if (key === 'expect-raise') out.expectRaise = parsePositioned(value);
  }
  return out;
}

/** `<substring> @ <line>:<col>` → { substring, line, column } (1-based), matching
 *  directive.rs::parse_positioned. */
function parsePositioned(value) {
  const at = value.lastIndexOf('@');
  const substring = value.slice(0, at).trim();
  const [line, column] = value
    .slice(at + 1)
    .trim()
    .split(':')
    .map((n) => Number.parseInt(n, 10));
  return { substring, line, column };
}

/** Byte offset in NFC `source` → 1-based line, 1-based column in code points (matching
 *  doodle-core source::LineIndex::position_at). */
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

/** All `*.doodle` fixture paths under `dir`, recursively. */
function fixturePaths(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.doodle'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

/** Drives one `mode: run` fixture through the wasm surface and returns the mismatch
 *  reasons (empty = pass), replicating matcher.rs::run_dynamic. */
async function runFixtureThroughWasm(source) {
  const directives = parseDirectives(source);
  const reasons = [];

  let inst;
  try {
    inst = DoodleInstance.demo(source); // a run fixture must load clean
  } catch (err) {
    return [`load error through wasm: ${err instanceof Error ? err.message : String(err)}`];
  }
  const nfc = inst.source();
  let out = '';
  const outcome = await pump(inst, { scheduler, onOutput: (t) => (out += t) });

  // match_output: the expected transcript is each expect-out line, newline-terminated.
  const expectedOut = directives.expectOut.map((t) => `${t}\n`).join('');
  if (out !== expectedOut) {
    reasons.push(`output: expected ${JSON.stringify(expectedOut)}, got ${JSON.stringify(out)}`);
  }

  // match_run_outcome: a raise must match substring + line:col; else it must complete.
  const want = directives.expectRaise;
  if (outcome.kind === 'raised') {
    if (!want) {
      reasons.push(`raised ${JSON.stringify(outcome.message)} but no expect-raise declared`);
    } else {
      const pos = outcome.span ? positionAt(nfc, outcome.span[0]) : null;
      if (!outcome.message.includes(want.substring)) {
        reasons.push(`raise message ${JSON.stringify(outcome.message)} lacks ${JSON.stringify(want.substring)}`);
      }
      if (!pos || pos.line !== want.line || pos.column !== want.column) {
        reasons.push(`raise at ${pos ? `${pos.line}:${pos.column}` : '<none>'}, expected ${want.line}:${want.column}`);
      }
    }
  } else if (outcome.kind === 'completed') {
    if (want) reasons.push(`expected a raise (${JSON.stringify(want.substring)}) but the program completed`);
  } else {
    reasons.push(`unexpected outcome: ${JSON.stringify(outcome)}`);
  }

  inst.free();
  return reasons;
}

// --- register a subtest per run fixture ---

assert.ok(
  existsSync(conformanceDir),
  `conformance fixtures not found at ${conformanceDir} (set DOODLE_CONFORMANCE_DIR)`,
);

const runFixtures = fixturePaths(conformanceDir)
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
  .filter(({ source }) => parseDirectives(source).mode === 'run');

assert.ok(runFixtures.length > 0, `no 'mode: run' fixtures found under ${conformanceDir}`);

await loadEngine(wasmBytes);

for (const { path, source } of runFixtures) {
  const name = path.slice(conformanceDir.length).replace(/^\/+/, '');
  // A multi-module fixture (a `main.doodle` with sibling module files) `import`s at runtime,
  // and the browser demo does not resolve imports yet: the wasm facade surfaces a
  // `SuspendedImport` as `Faulted("import-unsupported")` (the first-class outcome + a JS
  // `resolve_import` binding + demo fetch are the deferred M5-web work, E§6). So the wasm
  // conformance gate cannot run these standalone; skip them **visibly** (like the native
  // runner SKIPs a test above the implemented surface) until import support lands.
  const multiModule = path.endsWith('/main.doodle');
  const options = multiModule
    ? { skip: 'multi-module: imports need the M5-web resolve_import binding (E§6)' }
    : {};
  test(`conformance-through-wasm: ${name}`, options, async () => {
    const reasons = await runFixtureThroughWasm(source);
    assert.deepEqual(reasons, [], `${name} diverged on the wasm surface:\n  ${reasons.join('\n  ')}`);
  });
}
