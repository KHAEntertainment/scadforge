# ScadForge Spike 2 — pinned OpenSCAD nightly.
#
# PIN: docker.io/openscad/openscad
#      tag:    dev  (also tagged trixie, dev.2026-01-19, trixie.2026-01-19)
#      digest: sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7
#      openscad --version inside the container: OpenSCAD version 2026.01.19 (git e43242666)
#      Multi-arch manifest: linux/amd64, linux/arm64, linux/riscv64 (native on both
#      Apple Silicon and x86_64 hosts — no QEMU emulation required).
#      Built + published by the OpenSCAD project's own CI (Docker Hub user
#      "openscadci"), weekly, tracking git master — this is genuinely the
#      "nightly" (openscad/openscad:dev tracks master; "trixie"/"bookworm"
#      variants pin the Debian base only, same OpenSCAD build).
#
# WHY THIS PIN INSTEAD OF openscad.org's SNAPSHOT ARTIFACTS OR A FROM-SOURCE BUILD:
#   1. openscad.org/snapshots publishes Linux nightlies as x86_64-only
#      AppImages. The last arm64/aarch64 AppImage is dated 2023-09-11 and is
#      missing `--export-format=param` and 3MF-with-color (no lib3mf) —
#      both are hard requirements of this spike (verified: see README).
#   2. Running the CURRENT x86_64 nightly AppImage (2026.08.23) under Docker
#      Desktop's linux/amd64 emulation (QEMU) on Apple Silicon segfaults
#      immediately — even `openscad --info` crashes with SIGSEGV. Verified,
#      not a flag/config issue: a known class of QEMU user-mode-emulation
#      failure on large Qt/CGAL binaries.
#   3. Building OpenSCAD from source at the exact commit that produced the
#      2026.08.23 nightly (openscad/openscad@3da45dd5, native arm64) was
#      attempted and reproducibly OOM-kills `cc1plus` compiling CGAL/manifold
#      translation units on this Docker Desktop VM's memory budget — not a
#      quick fix (needs -j1 and/or a much bigger VM, trading a slow, fragile
#      from-scratch ~30+ min build for a hand-built image nobody else can
#      reproduce byte-for-byte without the exact same toolchain versions).
#   4. `openscad/openscad` solves all three: official, multi-arch native,
#      pull-by-digest reproducible, and — per verification below — has
#      lib3mf 1.8.1, Manifold 3.3.2, and `--export-format=param` built in.
#
# CAVEAT: this image is ~5 weeks older than the very latest x86_64-only
# AppImage nightly (2026.01.19 vs 2026.08.23). If a feature added to OpenSCAD
# after 2026-01-19 becomes load-bearing, re-check for a newer openscad/openscad
# tag (they publish weekly) before re-attempting a from-source build.

FROM openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7

WORKDIR /work
ENTRYPOINT ["openscad"]
