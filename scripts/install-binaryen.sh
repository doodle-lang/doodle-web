#!/bin/sh
# Installs a PINNED binaryen `wasm-opt` for CI/deploy (Linux x86_64).
#
# Why pinned, not apt: the ubuntu apt binaryen mis-optimizes wasm-bindgen's growable
# function table under `-Oz` — the optimized module then fails `WebAssembly.Table.grow()`
# at runtime on any capability/turtle program (surfaced by the M3.9 review the first time
# the conformance suite ran through the optimized bytes). version_130 is verified good, and
# is pinned by sha256 so a moved/edited release is rejected. The wasm-opt binary is
# statically linked (the release ships only libbinaryen.a), so installing just the binary
# onto PATH is sufficient — no sibling lib dir needed.
#
# Usage: ./scripts/install-binaryen.sh   (needs curl, sudo, sha256sum, tar; Linux x86_64).
set -eu

VER=version_130
SHA=0a18362361ad05465118cd8eeb72edaeec89de6894bc283576ef4e07aa3babcc
TB="binaryen-${VER}-x86_64-linux.tar.gz"
URL="https://github.com/WebAssembly/binaryen/releases/download/${VER}/${TB}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "${tmp}/${TB}" "$URL"
echo "${SHA}  ${tmp}/${TB}" | sha256sum -c -
tar xzf "${tmp}/${TB}" -C "$tmp"
sudo install -m 0755 "${tmp}/binaryen-${VER}/bin/wasm-opt" /usr/local/bin/wasm-opt
wasm-opt --version
