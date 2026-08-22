// Ambient types for the lezer-generated parser. `dist/parser.js` is produced from
// `src/doodle.grammar` by the build (lezer-generator) and ships no declarations of its own;
// this declares its shape so `src/index.ts` can re-export a typed `parser`. The build copies
// this file to `dist/parser.d.ts` alongside the generated parser.
import type { LRParser } from '@lezer/lr';

export declare const parser: LRParser;
