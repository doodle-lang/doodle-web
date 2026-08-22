// @doodle-lang/lezer-doodle — a Lezer grammar for the Doodle language (language spec App A
// + §3), built at package-build time by lezer-generator (a static parse table, so no
// runtime grammar compilation — CSP-clean, implementation-plan §3.9).
//
// This entry exposes the compiled `parser` (an `@lezer/lr` LRParser). The CodeMirror
// `LanguageSupport` + syntax-highlighting `styleTags` land with the editor increment.
//
// The grammar is kept honest by the §6.4 grammar-parity gate: it and the engine parser must
// classify a shared corpus of tricky syntax identically (see test/parity.test.mjs).
export { parser } from './parser.js';
