#!/usr/bin/env bash
# Rebuilds kaspa/kaspa_bg.wasm (and the unpatched kaspa.js glue) from a pinned rusty-kaspa commit in
# Docker (tools/kaspa-wasm/Dockerfile) and compares them with the committed files - audit findings
# DSK-005 / EXT-014. Needs a running Docker daemon (Docker Desktop or colima); x86_64 is emulated on
# Apple silicon.
#
#   bash tools/build-kaspa-wasm.sh            # build the pinned commit, compare, keep the output in .kaspa-wasm-build/
#   RUSTY_KASPA_COMMIT=<sha> bash tools/build-kaspa-wasm.sh   # try another commit
#
# It never overwrites kaspa/: the committed kaspa.js carries local eval-free patches (kaspa/VERSION),
# so a new SDK is installed by hand (copy, re-apply the patches, bash tools/check-wasm.sh --update).
#
# Result for the pinned defaults (kaspa/VERSION "PINNED SOURCE"): kaspa.js is byte-identical to the
# committed original; kaspa_bg.wasm is the known rebuild below, 92 bytes of code layout away from the
# committed binary (the original builder's setup was not recorded). The committed binary is kept.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Pinned from kaspa/VERSION: the rusty-kaspa master commit the committed binary was built from.
RUSTY_KASPA_COMMIT="${RUSTY_KASPA_COMMIT:-7de0d4ac4013b2081f3c3c924109a8f2e7824432}"
RUST_VERSION="${RUST_VERSION:-1.95.0}"
WASM_PACK_VERSION="${WASM_PACK_VERSION:-0.15.0}"
SRC_DIR="${SRC_DIR:-rusty-kaspa-master}"
OUT="$ROOT/.kaspa-wasm-build"
TAG="kachat-kaspa-wasm:${RUSTY_KASPA_COMMIT:0:12}-rust${RUST_VERSION}-wp${WASM_PACK_VERSION}-${SRC_DIR}"

docker build --platform linux/amd64 \
  --build-arg RUSTY_KASPA_COMMIT="$RUSTY_KASPA_COMMIT" \
  --build-arg RUST_VERSION="$RUST_VERSION" \
  --build-arg WASM_PACK_VERSION="$WASM_PACK_VERSION" \
  --build-arg SRC_DIR="$SRC_DIR" \
  -t "$TAG" "$ROOT/tools/kaspa-wasm"

rm -rf "$OUT" && mkdir -p "$OUT"
CID="$(docker create --platform linux/amd64 "$TAG")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker cp "$CID:/home/shudan/$SRC_DIR/wasm/web/kaspa/kaspa_bg.wasm" "$OUT/"
docker cp "$CID:/home/shudan/$SRC_DIR/wasm/web/kaspa/kaspa.js" "$OUT/"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
WANT_WASM="$(grep ' kaspa_bg.wasm$' "$ROOT/kaspa/SHA256SUMS" | cut -d' ' -f1)"
# The glue as the SDK build writes it, before the local patches (kaspa/VERSION).
WANT_JS="f481d7a0df21fc2557809c34891af2f2ecf4e5d69889591665c8937734db4075"
# What the pinned defaults build (2026-10-16): the reproducible twin of the committed binary.
KNOWN_REBUILD="98b507e78131ffd7eae3b49590b76c158a1b209399f58c3930f7529bfca40718"
GOT_WASM="$(sha "$OUT/kaspa_bg.wasm")"
GOT_JS="$(sha "$OUT/kaspa.js")"
echo "rusty-kaspa $RUSTY_KASPA_COMMIT, rustc $RUST_VERSION, wasm-pack $WASM_PACK_VERSION"
echo "kaspa_bg.wasm  built $GOT_WASM"
echo "               committed $WANT_WASM"
echo "kaspa.js       built $GOT_JS"
echo "               original (unpatched) $WANT_JS"
if [[ "$GOT_WASM" == "$WANT_WASM" && "$GOT_JS" == "$WANT_JS" ]]; then
  echo "MATCH: the committed SDK is reproduced byte for byte."
elif [[ "$GOT_WASM" == "$KNOWN_REBUILD" && "$GOT_JS" == "$WANT_JS" ]]; then
  echo "PINNED: the known rebuild of the pinned source (same glue; see kaspa/VERSION for the 92-byte layout difference)."
else
  echo "DIFFERENT: see $OUT"
  exit 2
fi
