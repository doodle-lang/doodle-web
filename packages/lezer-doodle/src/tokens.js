// External tokenizer + context tracker for Doodle's significant newlines (§3.2). A
// newline is a statement separator at bracket depth 0, but insignificant inside
// `(`/`[`/`{` (there it continues the line). The context tracker counts bracket nesting;
// the tokenizer emits a real `newline` at depth 0 and a `newlineBracketed` (in the skip
// set) inside brackets, so the parser only ever sees separators where they matter.
//
// This is plain JS (imported by the generated parser at build time — no runtime grammar
// compilation, so it is CSP-clean). Term ids come from the generated parser.terms.js.

import { ContextTracker, ExternalTokenizer } from '@lezer/lr';
import {
  newline,
  newlineBracketed,
  ParenL,
  ParenR,
  BracketL,
  BracketR,
  BraceL,
  BraceR,
} from './parser.terms.js';

/** Tracks `(`/`[`/`{` nesting depth so a newline inside brackets is insignificant. The
 *  `hash` lets @lezer/lr guard incremental fragment reuse across a depth change (the
 *  external newline tokenizer keys on this depth, so cached subtrees must not be reused at
 *  a different depth). */
export const trackBrackets = new ContextTracker({
  start: 0,
  shift(depth, term) {
    if (term === ParenL || term === BracketL || term === BraceL) return depth + 1;
    if (term === ParenR || term === BracketR || term === BraceR) return depth > 0 ? depth - 1 : 0;
    return depth;
  },
  hash: (depth) => depth,
});

/** Emits `newline` at bracket depth 0 (a statement separator) or `newlineBracketed` inside
 *  brackets (skipped). Only a line feed terminates a line (L§3.2); a bare carriage return
 *  is insignificant whitespace (the `space` skip token consumes it), and a `\r\n` pair is
 *  the `\r` (skipped) then this `\n`. */
export const newlines = new ExternalTokenizer((input, stack) => {
  if (input.next !== 10) return; // only a line feed (`\n`) is a terminator
  input.advance();
  input.acceptToken(stack.context === 0 ? newline : newlineBracketed);
});
