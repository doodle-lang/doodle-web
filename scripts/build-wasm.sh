#!/bin/sh
# Usage: ./scripts/build-wasm.sh
#
# Builds the `doodle-wasm` crate from the sibling `doodle-rust` checkout for
# wasm32, runs the wasm-bindgen CLI (--target web, so the same ESM works in the
# browser demo and in Node tests), and writes the artifact into
# packages/engine/wasm/. That directory is git-ignored and regenerated on demand
# — doodle-rust is the single source of truth for the engine.
#
# NO wasm-opt pass here: the shipped artifact is the raw wasm-bindgen output, and the
# size gate (scripts/wasm-ship-size.sh) measures exactly those bytes — so what ships is
# what is gated. A `wasm-opt -Oz` pass would shrink it (~178 vs ~193 KB brotli), but the
# apt binaryen in CI mis-optimizes wasm-bindgen's growable function table (a runtime
# `WebAssembly.Table.grow()` failure the M3.9 review surfaced when the conformance suite
# first ran through the optimized bytes), and the deploy path does not run that suite —
# so an optimize step here would risk publishing a broken binary. Adopting wasm-opt again
# needs a pinned, known-good binaryen plus a deploy-time smoke test of the optimized wasm.
#
# DOODLE_RUST_DIR overrides where doodle-rust lives (default: the sibling submodule
# ../doodle-rust). Requires the pinned Rust toolchain (+ wasm32-unknown-unknown
# target) and wasm-bindgen on PATH, exactly as doodle-rust's own size gate does.

set -e

WEB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="${DOODLE_RUST_DIR:-$WEB_ROOT/../doodle-rust}"
OUT="$WEB_ROOT/packages/engine/wasm"

if [ ! -f "$RUST_DIR/crates/doodle-wasm/Cargo.toml" ]; then
    echo "ERROR: doodle-rust not found at $RUST_DIR (set DOODLE_RUST_DIR)"
    exit 1
fi
for tool in cargo wasm-bindgen; do
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
[ -s "$OUT/doodle_wasm_bg.wasm" ] || { echo "ERROR: wasm-bindgen produced no wasm output"; exit 1; }
echo "wasm-bindgen artifact written to $OUT"
ls -1 "$OUT"
