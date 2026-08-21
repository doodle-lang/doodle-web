# doodle-web

Doodle on the web — the JavaScript side of the [Doodle language](https://github.com/doodle-lang).
A sibling submodule of the `doodle-lang/workspace`, kept separate from the pure-Rust
engine repo (`doodle-rust`) by design (implementation-plan AD7 / M3 Decision #1).

## Packages

- **`packages/engine`** — [`@doodle-lang/engine`](packages/engine): the JS/TS embedding of
  the Doodle engine. It wraps the `doodle-wasm` WebAssembly facade (built from
  `doodle-rust`) in a **fuel-sliced pump** that runs the engine on the browser main thread
  without jank (AD6), surfaces capabilities as Promises, and samples the executing position
  per animation frame.

The browser demo (CodeMirror editor + turtle canvas) lands under this repo at M3.7.

## Building the wasm

The engine wraps a WebAssembly artifact compiled from the `doodle-wasm` crate in the
sibling `doodle-rust` checkout. Generate it with:

```sh
./scripts/build-wasm.sh           # builds ../doodle-rust's doodle-wasm → packages/engine/wasm/
```

Requires the pinned Rust toolchain (with the `wasm32-unknown-unknown` target) and
`wasm-bindgen` on PATH, as `doodle-rust` does. The generated `packages/engine/wasm/`
directory is git-ignored and rebuilt on demand.

## Develop

```sh
npm install
npm run build-wasm
npm test          # Node test runner, wasm pump end-to-end
npm run typecheck
```
