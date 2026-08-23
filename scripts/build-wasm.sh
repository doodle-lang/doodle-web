#!/bin/sh
# Usage: ./scripts/build-wasm.sh
#
# Builds the `doodle-wasm` crate from the sibling `doodle-rust` checkout for
# wasm32, runs the wasm-bindgen CLI (--target web, so the same ESM works in the
# browser demo and in Node tests), optimizes the result with `wasm-opt -Oz`, and
# writes the artifact into packages/engine/wasm/. That directory is git-ignored and
# regenerated on demand — doodle-rust is the single source of truth for the engine.
#
# The `wasm-opt -Oz` pass is what the shipped artifact carries so that the byte-exact size
# gate (scripts/wasm-ship-size.sh) measures precisely what ships (~178 vs ~193 KB brotli).
# It MUST run against a known-good binaryen: the ubuntu apt binaryen mis-optimizes
# wasm-bindgen's growable function table (a runtime `WebAssembly.Table.grow()` failure), so
# CI/deploy install a PINNED wasm-opt via scripts/install-binaryen.sh, and the deploy
# workflow smoke-tests the optimized module before publishing. Locally, a recent Homebrew
# binaryen (>= version_130) is fine.
#
# DOODLE_RUST_DIR overrides where doodle-rust lives (default: the sibling submodule
# ../doodle-rust). Requires the pinned Rust toolchain (+ wasm32-unknown-unknown
# target), wasm-bindgen, and wasm-opt (binaryen) on PATH.

set -e

WEB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="${DOODLE_RUST_DIR:-$WEB_ROOT/../doodle-rust}"
OUT="$WEB_ROOT/packages/engine/wasm"

if [ ! -f "$RUST_DIR/crates/doodle-wasm/Cargo.toml" ]; then
    echo "ERROR: doodle-rust not found at $RUST_DIR (set DOODLE_RUST_DIR)"
    exit 1
fi
for tool in cargo wasm-bindgen wasm-opt; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: '$tool' not found on PATH"
        exit 1
    fi
done

echo "Building doodle-wasm (release, wasm32) from $RUST_DIR ..."
( cd "$RUST_DIR" && cargo build --release --target wasm32-unknown-unknown --package doodle-wasm )

RAW="$RUST_DIR/target/wasm32-unknown-unknown/release/doodle_wasm.wasm"
[ -f "$RAW" ] || { echo "ERROR: expected wasm not found: $RAW"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
wasm-bindgen "$RAW" --out-dir "$OUT" --target web
BG="$OUT/doodle_wasm_bg.wasm"
[ -s "$BG" ] || { echo "ERROR: wasm-bindgen produced no wasm output"; exit 1; }

# Optimize the shipped `_bg.wasm` in place (the -Oz the size gate measures). Write to a
# sibling then move, so a wasm-opt that produces nothing cannot truncate the artifact.
wasm-opt -Oz -o "$BG.opt" "$BG"
[ -s "$BG.opt" ] || { echo "ERROR: wasm-opt produced no output"; exit 1; }
mv "$BG.opt" "$BG"
echo "wasm-bindgen + wasm-opt -Oz artifact written to $OUT"
ls -1 "$OUT"
