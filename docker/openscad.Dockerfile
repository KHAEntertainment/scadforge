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
ENTRYPOINT ["openscad"]
