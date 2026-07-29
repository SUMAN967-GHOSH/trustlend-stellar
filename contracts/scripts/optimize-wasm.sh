#!/usr/bin/env bash
# Optimize WASM binaries with wasm-opt after cargo build.
# Requires: `cargo install wasm-opt` or system package (binaryen)
#
# Usage: bash optimize-wasm.sh [target_dir]
# Default target dir: target/wasm32-unknown-unknown/release

set -euo pipefail

TARGET_DIR="${1:-target/wasm32-unknown-unknown/release}"
OPT_LEVEL="${2:--Oz}"

if ! command -v wasm-opt &>/dev/null; then
  echo "ERROR: wasm-opt not found. Install via:"
  echo "  cargo install wasm-opt"
  echo "  # or: brew install binaryen / apt install binaryen"
  exit 1
fi

echo "Optimizing WASM binaries in $TARGET_DIR with $OPT_LEVEL ..."

count=0
for wasm in "$TARGET_DIR"/*.wasm; do
  [ -f "$wasm" ] || continue
  before=$(stat -c%s "$wasm" 2>/dev/null || stat -f%z "$wasm")
  wasm-opt "$OPT_LEVEL" --output "$wasm" "$wasm"
  after=$(stat -c%s "$wasm" 2>/dev/null || stat -f%z "$wasm")
  saved=$(( before - after ))
  pct=$(( saved * 100 / before ))
  echo "  $(basename "$wasm"): ${before} -> ${after} bytes (saved ${saved}, ${pct}%)"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "No .wasm files found in $TARGET_DIR"
  exit 1
fi

echo "Done. Optimized $count file(s)."
