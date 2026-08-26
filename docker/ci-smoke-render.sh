#!/usr/bin/env bash
# ScadForge CI smoke test for the pinned OpenSCAD image (Issue #15).
#
# 1. Builds docker/openscad.Dockerfile (pinned digest — see docker/README.md).
# 2. Asserts `openscad --version` reports the pinned version.
# 3. Renders a trivial cube to PNG and asserts the output is a real PNG.
# 4. Regression-guards the SCADFORGE_OPENSCAD_IMAGE override contract: the raw
#    upstream `openscad/openscad` image ships with NO openscad entrypoint
#    (Entrypoint=[] Cmd=[bash]) — only the locally built image sets one, for
#    convenience. Every invocation below therefore passes `--entrypoint
#    openscad` explicitly instead of relying on the image's own
#    ENTRYPOINT/CMD, so the exact same command works whether $IMAGE is the
#    locally built tag or a bare upstream digest ref (Phase 4 QA finding,
#    PR #22).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="scadforge-openscad:pinned"
PINNED_DIGEST="openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7"
PINNED_VERSION="2026.01.19"

check_version() {
  local image="$1"
  local label="$2"
  local output
  output="$(docker run --rm --entrypoint openscad "$image" --version 2>&1)"
  echo "$output"
  if [[ "$output" != *"$PINNED_VERSION"* ]]; then
    echo "FAIL ($label): expected version '$PINNED_VERSION' in output, got: $output" >&2
    exit 1
  fi
}

echo "== Building pinned OpenSCAD image =="
docker build -f "$REPO_ROOT/docker/openscad.Dockerfile" -t "$IMAGE" "$REPO_ROOT"

echo "== Checking pinned version (locally built image) =="
check_version "$IMAGE" "built image"

echo "== Regression check: SCADFORGE_OPENSCAD_IMAGE override against the raw upstream digest =="
# This is the exact scenario Phase 4 QA reproduced as broken: overriding to a
# bare upstream digest ref (no local build/retag) must still answer
# `openscad --version` with the pinned version, via the same explicit
# `--entrypoint openscad` invocation used everywhere else. `docker run` pulls
# the digest on demand if it isn't already resolvable locally.
check_version "$PINNED_DIGEST" "raw upstream digest override"

echo "== Smoke render: trivial cube -> PNG =="
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
echo "cube([10,10,10]);" > "$WORKDIR/cube.scad"

docker run --rm --entrypoint openscad -v "$WORKDIR:/work" "$IMAGE" \
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

echo "PASS: pinned image builds, reports $PINNED_VERSION (both as built and as a raw digest override), and renders a valid PNG."
