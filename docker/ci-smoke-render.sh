#!/usr/bin/env bash
# ScadForge CI smoke test for the pinned OpenSCAD image (Issue #15).
#
# 1. Builds docker/openscad.Dockerfile (pinned digest — see docker/README.md).
# 2. Asserts `openscad --version` reports the pinned version.
# 3. Renders a trivial cube to PNG and asserts the output is a real PNG.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="scadforge-openscad:pinned"
PINNED_VERSION="2026.01.19"

echo "== Building pinned OpenSCAD image =="
docker build -f "$REPO_ROOT/docker/openscad.Dockerfile" -t "$IMAGE" "$REPO_ROOT"

echo "== Checking pinned version =="
VERSION_OUTPUT="$(docker run --rm "$IMAGE" --version 2>&1)"
echo "$VERSION_OUTPUT"
if [[ "$VERSION_OUTPUT" != *"$PINNED_VERSION"* ]]; then
  echo "FAIL: expected version '$PINNED_VERSION' in output, got: $VERSION_OUTPUT" >&2
  exit 1
fi

echo "== Smoke render: trivial cube -> PNG =="
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
echo "cube([10,10,10]);" > "$WORKDIR/cube.scad"

docker run --rm -v "$WORKDIR:/work" "$IMAGE" \
  --render --backend=Manifold -o /work/cube.png /work/cube.scad

if [[ ! -s "$WORKDIR/cube.png" ]]; then
  echo "FAIL: cube.png was not produced" >&2
  exit 1
fi

MAGIC="$(head -c 8 "$WORKDIR/cube.png" | xxd -p)"
if [[ "$MAGIC" != "89504e470d0a1a0a" ]]; then
  echo "FAIL: cube.png is not a valid PNG (magic bytes: $MAGIC)" >&2
  exit 1
fi

echo "PASS: pinned image builds, reports $PINNED_VERSION, and renders a valid PNG."
