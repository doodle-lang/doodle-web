#!/bin/sh
# Byte-exact wasm size gate on the SHIPPED artifact (implementation-plan §6.5): brotli-
# compresses packages/engine/wasm/doodle_wasm_bg.wasm — the exact bytes build-wasm.sh
# emits, which the demo bundles and @doodle-lang/engine ships — and fails if it exceeds the
# ≤ 300 KB brotli budget. Because build-wasm.sh runs `wasm-opt -Oz`, this measures precisely
# what users download, not a smaller binary built by a different pipeline. (doodle-rust's
# scripts/wasm-size.sh gates the same recipe at the engine-crate level; this one is the gate
# on the actual doodle-web-built bytes, so the deploy path itself is gated.)
#
# Fail-closed: a missing/empty artifact, a missing brotli, or an unmeasurable result aborts
# rather than passing — a size gate that greens on a broken pipeline is worse than none.
# WASM_BUDGET_BYTES overrides the budget (e.g. =1 to force a failure in a self-test).
#
# Usage: run scripts/build-wasm.sh first, then this. Requires `brotli` on PATH.
set -eu

WASM="packages/engine/wasm/doodle_wasm_bg.wasm"
# 300 KB brotli, decimal (300,000 bytes) — matches doodle-rust's wasm-size gate (plan §6.5).
BUDGET_BYTES="${WASM_BUDGET_BYTES:-300000}"

command -v brotli >/dev/null 2>&1 || { echo "ERROR: 'brotli' not found on PATH"; exit 1; }
[ -s "$WASM" ] || { echo "ERROR: $WASM missing or empty — run scripts/build-wasm.sh first"; exit 1; }

BR="$WASM.br"
rm -f "$BR" # never measure a stale compression
brotli -f -o "$BR" "$WASM"
[ -s "$BR" ] || { echo "ERROR: brotli produced no output"; exit 1; }
size=$(wc -c < "$BR" | tr -d ' ')
rm -f "$BR"
case "$size" in
  '' | *[!0-9]*)
    echo "ERROR: could not measure compressed size"
    exit 1
    ;;
esac

echo "shipped wasm brotli: $size bytes  (budget $BUDGET_BYTES)"
if [ "$size" -gt "$BUDGET_BYTES" ]; then
  echo "FAIL: shipped wasm $size bytes exceeds budget $BUDGET_BYTES bytes"
  exit 1
fi
echo "PASS: shipped wasm within budget"
