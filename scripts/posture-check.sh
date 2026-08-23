#!/bin/sh
# Verifies the demo's D-7 privacy posture on the BUILT app (§Decisions #4 RESOLVED): a
# self-contained page with a strict <meta> CSP that forbids JS eval, no external resource
# loads, and no third-party analytics/trackers. (The stronger HTTP-header CSP incl.
# frame-ancestors rides with the deferred Cloudflare move.)
#
# Usage: build the app first (`npm run build:app -w @doodle-lang/demo`), then run this.
set -eu

APP="packages/demo/dist/app"
HTML="$APP/index.html"
[ -f "$HTML" ] || {
  echo "ERROR: $HTML not found — run 'npm run build:app -w @doodle-lang/demo' first"
  exit 1
}
fail=0

# 1. A Content-Security-Policy meta that is self-contained and forbids JS eval.
csp=$(grep -oE 'http-equiv="Content-Security-Policy"[^>]*content="[^"]*"' "$HTML" || true)
[ -n "$csp" ] || {
  echo "FAIL: no Content-Security-Policy meta tag"
  fail=1
}
case "$csp" in
  *"default-src 'self'"*) : ;;
  *)
    echo "FAIL: CSP lacks default-src 'self'"
    fail=1
    ;;
esac
# `'wasm-unsafe-eval'` is allowed (wasm only); a bare `'unsafe-eval'` (JS) is not.
case "$csp" in
  *"'unsafe-eval'"*)
    echo "FAIL: CSP allows 'unsafe-eval' — JS eval must be forbidden"
    fail=1
    ;;
  *) : ;;
esac

# 2. No external resource references in the page (all assets self-hosted).
ext=$(grep -oE '(src|href)="https?://[^"]*"' "$HTML" || true)
[ -z "$ext" ] || {
  echo "FAIL: external resource reference(s) in index.html:"
  echo "$ext"
  fail=1
}

# 3. No third-party analytics/trackers anywhere in the built output.
if grep -qiE 'googletagmanager|google-analytics|gtag\(|plausible\.io|segment\.(io|com)|mixpanel|hotjar|/matomo' \
  "$HTML" "$APP"/assets/*.js 2>/dev/null; then
  echo "FAIL: a third-party analytics/tracker reference was found"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "PASS: self-contained, strict meta-CSP (no JS eval), no external loads or trackers"
exit "$fail"
