# ScadForge — pinned OpenSCAD image.
#
# PIN: docker.io/openscad/openscad
#      tag:    dev  (also tagged trixie, dev.2026-01-19, trixie.2026-01-19)
#      digest: sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7
#      openscad --version inside the container: OpenSCAD version 2026.01.19 (git e43242666)
#      Multi-arch manifest: linux/amd64, linux/arm64, linux/riscv64 (native on both
#      Apple Silicon and x86_64 hosts — no QEMU emulation required).
#      Built + published by the OpenSCAD project's own CI (Docker Hub user
#      "openscadci"), weekly, tracking git master.
#
# CAVEAT: this image trails the newest x86_64-only AppImage nightly by ~5 weeks.
# See docker/README.md for the full rationale (spike: docs/spikes/02-docker-cli/README.md)
# and the re-pin / bump procedure before changing the digest below.

FROM openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7

WORKDIR /work
# Convenience only for ad hoc interactive use of THIS built image
# (`docker run scadforge-openscad:pinned --version`). The raw upstream
# `openscad/openscad` image has NO entrypoint (Entrypoint=[] Cmd=[bash]), so
# every programmatic caller (compose.yaml, docker/ci-smoke-render.sh, the
# #14 scad-core runner) must pass `--entrypoint openscad` / an explicit
# `entrypoint:` override rather than relying on this line — see the
# "Image-agnostic invocation" section of docker/README.md.
ENTRYPOINT ["openscad"]
