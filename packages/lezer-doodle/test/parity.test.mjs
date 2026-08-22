// The §6.4 grammar-parity gate (implementation-plan §6.4): the Lezer grammar and the
// engine parser must classify a shared corpus of tricky syntax identically as
// valid/invalid. The corpus lives in doodle-rust (the engine is the grammar authority) as
// `mode: static, stage: parse` conformance fixtures under `lang/LA/gp-*.doodle`; the engine
// side is checked by the conformance runner. Here we parse each with the Lezer grammar and
// assert its verdict (any error node ⇒ invalid) matches the fixture's declared verdict (an
// `expect-static-error` directive ⇒ the engine rejects it). Green on both sides ⇒ the two
// grammars agree on the corpus.
//
// The corpus is read from the sibling doodle-rust checkout; DOODLE_GRAMMAR_PARITY_DIR overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parser } from '../dist/parser.js';

const corpusDir =
  process.env.DOODLE_GRAMMAR_PARITY_DIR ??
  fileURLToPath(new URL('../../../../doodle-rust/conformance/v0.1/lang/LA/', import.meta.url));

/** The engine rejects a fixture iff it declares an `expect-static-error` (conformance
 *  README): a fixture with none expects a clean parse. */
function engineRejects(source) {
  return source.split('\n').some((line) => /^#!\s*expect-static-error:/.test(line));
}

/** The Lezer grammar rejects a program iff its parse tree contains any error node. */
function lezerRejects(source) {
  const tree = parser.parse(source);
  let error = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) error = true;
    },
  });
  return error;
}

assert.ok(
  existsSync(corpusDir),
  `grammar-parity corpus not found at ${corpusDir} (set DOODLE_GRAMMAR_PARITY_DIR)`,
);

const fixtures = readdirSync(corpusDir)
  .filter((name) => name.startsWith('gp-') && name.endsWith('.doodle'))
  .sort();

assert.ok(fixtures.length > 0, `no gp-*.doodle fixtures under ${corpusDir}`);

for (const name of fixtures) {
  const source = readFileSync(join(corpusDir, name), 'utf8');
  test(`grammar-parity: ${name}`, () => {
    const engine = engineRejects(source);
    const lezer = lezerRejects(source);
    assert.equal(
      lezer,
      engine,
      engine
        ? `the engine rejects ${name} as a syntax error, but the Lezer grammar accepted it`
        : `the engine parses ${name} cleanly, but the Lezer grammar reported a syntax error`,
    );
  });
}
