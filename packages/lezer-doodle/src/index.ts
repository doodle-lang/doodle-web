// @doodle-lang/lezer-doodle — a Lezer grammar for the Doodle language (language spec App A
// + §3), built at package-build time by lezer-generator (a static parse table, so no
// runtime grammar compilation — CSP-clean, implementation-plan §3.9).
//
// Exposes the raw `parser` (an `@lezer/lr` LRParser), a CodeMirror `LRLanguage` with
// syntax-highlighting tags (`doodleLanguage`), and a `LanguageSupport` factory (`doodle`)
// ready to drop into an EditorState. The grammar is kept honest by the §6.4 grammar-parity
// gate (test/parity.test.mjs): it and the engine parser must classify a shared corpus of
// tricky syntax identically.

import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';

import { parser } from './parser.js';

export { parser } from './parser.js';

/** Maps grammar nodes to highlight tags (`@lezer/highlight`). Keyword nodes are named by
 *  their spelling (via `@specialize` in the grammar). */
const doodleHighlighting = styleTags({
  'if then else while loop do with end return break continue raise try rescue': t.controlKeyword,
  'to fn record protocol implement module parameter let const': t.definitionKeyword,
  'import exports as extends ref': t.moduleKeyword,
  'and or not is': t.operatorKeyword,
  'true false': t.bool,
  nil: t.null,
  'Number Float': t.number,
  'String TripleString Bytes': t.string,
  LineComment: t.lineComment,
  Identifier: t.variableName,
  // The declared name of a `to`/`fn`/protocol member is a direct child of its decl node.
  'ToDecl/Identifier FnDecl/Identifier AnonFn/Identifier ProtoMember/Identifier': t.function(
    t.definition(t.variableName),
  ),
});

/**
 * The Doodle language for CodeMirror 6: the compiled parser configured with highlight
 * tags, plus language metadata (line comments start with `#`).
 */
export const doodleLanguage = LRLanguage.define({
  name: 'doodle',
  parser: parser.configure({ props: [doodleHighlighting] }),
  languageData: {
    commentTokens: { line: '#' },
  },
});

/** A `LanguageSupport` for Doodle — add to an EditorState's extensions to get parsing and
 *  syntax highlighting. */
export function doodle(): LanguageSupport {
  return new LanguageSupport(doodleLanguage);
}
