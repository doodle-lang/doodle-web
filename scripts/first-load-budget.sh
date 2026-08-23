#!/bin/sh
# Fails if the demo app's first-load payload exceeds the ≤ 2 s-first-load budget proxy
# (implementation-plan §6.5). Measures gzip — what GitHub Pages serves — over the whole
# built site (packages/demo/dist/app). The wasm binary is *also* gated, separately and more
# tightly, by doodle-rust's brotli size gate; this is the holistic page transfer, a portable
# stand-in for the real "≤ 2 s on a mid-range Chromebook" check (which stays a manual
# Lighthouse spot-check, since CI hardware is not a Chromebook).
#
# Usage: build the app first (`npm run build:app -w @doodle-lang/demo`), then run this.
set -eu

DIR="packages/demo/dist/app"
BUDGET=460800 # 450 KiB, gzipped (current ≈ 349 KiB — headroom for engine growth)

[ -d "$DIR" ] || {
  echo "ERROR: $DIR not found — run 'npm run build:app -w @doodle-lang/demo' first"
  exit 1
}

total=0
echo "First-load payload (gzip, what Pages serves):"
for f in $(find "$DIR" -type f | sort); do
  gz=$(gzip -c "$f" | wc -c | tr -d ' ')
  total=$((total + gz))
  printf "  %-46s %9d B\n" "${f#"$DIR"/}" "$gz"
done
echo "  ------------------------------------------------------"
printf "  %-46s %9d B  (budget %d)\n" "TOTAL" "$total" "$BUDGET"

if [ "$total" -gt "$BUDGET" ]; then
  echo "FAIL: first-load payload $total exceeds the $BUDGET-byte budget"
  exit 1
fi
echo "PASS: first-load payload within budget"
