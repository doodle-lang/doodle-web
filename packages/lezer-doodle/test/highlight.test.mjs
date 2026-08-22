// Headless syntax-highlighting test: parse a sample with the highlight-tagged Doodle
// parser and run @lezer/highlight's highlightTree with the default classHighlighter,
// asserting the expected token categories get their classes. No DOM/editor needed — this
// exercises the styleTags mapping (src/index.ts) that a CodeMirror EditorView renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classHighlighter, highlightTree } from '@lezer/highlight';

import { doodleLanguage } from '../dist/index.js';

/** The highlight classes assigned to each highlighted span of `src`, in order. */
function highlightSpans(src) {
  const tree = doodleLanguage.parser.parse(src);
  const spans = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    spans.push({ text: src.slice(from, to), classes });
  });
  return spans;
}

/** The classes of the first highlighted span whose text is exactly `token`. */
function classOf(src, token) {
  const span = highlightSpans(src).find((s) => s.text === token);
  return span ? span.classes : '';
}

test('keywords, numbers, strings, comments, and identifiers are tagged', () => {
  const src = 'let n = 42\nif n == 0 then\n  print("hi")  # a comment\nend\n';
  assert.match(classOf(src, 'let'), /tok-keyword/);
  assert.match(classOf(src, 'if'), /tok-keyword/);
  assert.match(classOf(src, 'then'), /tok-keyword/);
  assert.match(classOf(src, 'end'), /tok-keyword/);
  assert.match(classOf(src, '42'), /tok-number/);
  assert.match(classOf(src, '"hi"'), /tok-string/);
  assert.match(classOf(src, '# a comment'), /tok-comment/);
  assert.match(classOf(src, 'n'), /tok-variableName/);
});

test('true/false/nil literals and a triple-quoted string are tagged', () => {
  assert.match(classOf('let b = true\n', 'true'), /tok-bool/);
  assert.match(classOf('let b = false\n', 'false'), /tok-bool/);
  // `nil` carries the `null` tag; the default highlighter renders it keyword-like.
  assert.notEqual(classOf('let z = nil\n', 'nil'), '');
  assert.match(classOf('let s = """doc"""\n', '"""doc"""'), /tok-string/);
});

test('a declared to/fn name is tagged as a definition', () => {
  const src = 'to greet(name)\n  print(name)\nend\n';
  assert.match(classOf(src, 'greet'), /tok-definition/);
  const fnSrc = 'fn double(x)\n  return x * 2\nend\n';
  assert.match(classOf(fnSrc, 'double'), /tok-definition/);
});

test('doodle() builds a LanguageSupport without throwing', async () => {
  const { doodle } = await import('../dist/index.js');
  const support = doodle();
  assert.ok(support.language === doodleLanguage, 'wraps the Doodle language');
});
