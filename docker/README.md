# docker/ — pinned OpenSCAD

This directory pins the exact OpenSCAD build ScadForge's server-side renderer
(`packages/scad-core`) and CI both use, so renders are reproducible across
machines and time.

## The pin

```
docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7
```

- **Version**: OpenSCAD **2026.01.19** (git `e43242666`)
- **Aliases** (all resolve to the same digest above): `dev`, `trixie`,
  `dev.2026-01-19`, `trixie.2026-01-19`
- **Arch**: multi-arch manifest (`linux/amd64`, `linux/arm64`,
  `linux/riscv64`) — runs natively on Apple Silicon and x86_64, no QEMU
  emulation needed
- Published by the OpenSCAD project's own CI (Docker Hub `openscadci`
  account), built weekly, tracking git `master`

Full reproduction trail and the rejected alternatives (x86_64 AppImage under
emulation, arm64 AppImage nightly, from-source build) are recorded in
`docs/spikes/02-docker-cli/README.md` (Issue #4).

### Caveat

This image trails the newest **x86_64-only** AppImage nightly from
openscad.org/snapshots by **~5 weeks** (2026-01-19 vs. the 2026-08-23 nightly
current at spike time). openscad.org does not publish arm64 nightlies newer
than 2023-09-11, and the current x86_64 nightly segfaults under Docker
Desktop's QEMU emulation on Apple Silicon — so this Docker Hub image is the
best available reproducible, multi-arch, native pin. If a feature landed in
OpenSCAD after 2026-01-19 becomes load-bearing for ScadForge, re-pin per the
procedure below rather than reaching for emulation or a from-source build.

## Bump / re-pin procedure

1. Check `https://hub.docker.com/r/openscad/openscad/tags` for a newer `dev`
   (or `trixie`) tag — published weekly.
2. Resolve the tag to its immutable digest:
   ```bash
   docker pull openscad/openscad:dev
   docker inspect --format='{{index .RepoDigests 0}}' openscad/openscad:dev
   ```
3. Confirm the version and required flags still work:
   ```bash
   docker run --rm openscad/openscad@sha256:<new-digest> --version
   ```
   Re-run the `docs/spikes/02-docker-cli` harness (`node run-views.mjs
   sample.scad`) against the new digest to re-verify `--backend=Manifold`,
   3MF color export, `--export-format=param`, and camera args before
   switching CI/production over.
4. Update the digest in **three** places (all pin the same value verbatim):
   - `docker/openscad.Dockerfile` (`FROM` line + header comment)
   - `docker/README.md` (this file, both spots above)
   - `PROJECT_CONTEXT.md` / `CLAUDE.md` "Pinned toolchain" (Tech-Lead-owned —
     open an issue/comment rather than editing directly if those are frozen
     by the time you're reading this)
5. Update the `.github/workflows/ci.yml` smoke-render job only if the digest
   string is duplicated there (see "CI" below) — currently it's read from the
   same `docker/openscad.Dockerfile`, so no separate edit is needed there.
6. Commit with a message noting old → new digest and version, and re-run the
   full render_views verification.

## Image-agnostic invocation (read before overriding `SCADFORGE_OPENSCAD_IMAGE`)

**The raw upstream `openscad/openscad` image has no `openscad` entrypoint.**
`docker inspect openscad/openscad@sha256:0af06...b52fa7` reports
`Entrypoint=[] Cmd=[bash]` — only the image built from
`docker/openscad.Dockerfile` sets `ENTRYPOINT ["openscad"]`, and that's a
**local convenience only**, not something every image behind
`SCADFORGE_OPENSCAD_IMAGE` can be assumed to have (found by Phase 4 QA on
PR #22: `docker run --rm openscad/openscad@sha256:0af06...b52fa7 --version`
fails with `exec: "--version": executable file not found in $PATH` because
`--version` is treated as the container's `Cmd`, not an arg to `openscad`).

**Rule: every programmatic invocation must name the `openscad` executable
explicitly — never rely on image `ENTRYPOINT`/`CMD`.** Concretely:
- `compose.yaml`'s `openscad` service sets `entrypoint: ["openscad"]`
  explicitly (not inherited from the Dockerfile), so it behaves identically
  whether `SCADFORGE_OPENSCAD_IMAGE` resolves to the locally built tag or a
  bare upstream digest.
- Any direct `docker run` (CI, the #14 scad-core runner, ad hoc debugging)
  must pass `--entrypoint openscad` explicitly:
  ```bash
  docker run --rm --entrypoint openscad "$SCADFORGE_OPENSCAD_IMAGE" --version
  ```
  This is the verified-working form — confirmed identical against both the
  locally built `scadforge-openscad:pinned` tag and the bare
  `openscad/openscad@sha256:0af06...b52fa7` digest (see "Verified re-run of
  the QA reproduction" below). Do **not** use the earlier documented form
  (`docker run --rm "$IMAGE" --version`, relying on `ENTRYPOINT`) — that is
  the exact command QA showed fails against a raw upstream digest.

## Local usage

```bash
# Build the pinned image
docker compose build openscad

# Prove the pin — prints "OpenSCAD version 2026.01.19 ..."
docker compose up openscad
# or, one-liner:
docker compose run --rm openscad --version
```

Both work against `SCADFORGE_OPENSCAD_IMAGE` overridden to a raw upstream
digest too, because `compose.yaml` sets `entrypoint: ["openscad"]` explicitly
(see "Image-agnostic invocation" above) rather than depending on the image's
own entrypoint.

Root `compose.yaml` mounts:
- `./data/projects` → `/work/projects` — project directories (`.scad`
  sources + the per-project `.scadforge/` filesystem store)
- `./packages/libs` → `/work/libs` (read-only) — vendored libraries
  (BOSL2/MCAD) consumed via `use <...>` / `include <...>`

`./data/` is gitignored; Docker creates it automatically on first
`compose up` / `compose run` if it doesn't exist yet.

### Library resolution: `OPENSCADPATH`

OpenSCAD resolves `use <...>` / `include <...>` library paths via the
`OPENSCADPATH` environment variable (colon-separated, like `PATH`).
`compose.yaml` sets `OPENSCADPATH=/work/libs` on the `openscad` service to
match the `./packages/libs:/work/libs:ro` mount above, so
`use <BOSL2/std.scad>` resolves once BOSL2/MCAD are vendored into
`packages/libs` (tracked separately — `packages/libs` is currently a package
scaffold with no vendored `.scad` files yet, per Phase 4 QA's non-blocking
note).

**Convention for the #14 scad-core runner**: whenever it bind-mounts a
library directory into the container (its own `docker run`/exec, not this
compose file), it should mount it at the same path, `/work/libs`, and set
`-e OPENSCADPATH=/work/libs` on that invocation — matching this compose
service so library-relative `.scad` includes behave identically regardless
of which caller (compose, the runner, CI) invokes OpenSCAD.

## Consuming this image from Node (apps/server / packages/scad-core)

The server's OpenSCAD subprocess runner does **not** shell out to `docker
compose` — it invokes `docker run` (or an equivalent container runtime call)
directly, the same pattern verified in
`docs/spikes/02-docker-cli/run-views.mjs`. The image reference is
overridable via a single environment variable:

```
SCADFORGE_OPENSCAD_IMAGE=docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7
```

If unset, tooling defaults to the locally built tag `scadforge-openscad:pinned`
(i.e. `docker build -f docker/openscad.Dockerfile -t scadforge-openscad:pinned .`).
This is the same env var name `compose.yaml`'s `openscad` service image tag
reads, so a single override applies to both compose and any direct
`docker run` invocation — **provided the invocation names the executable
explicitly**, per "Image-agnostic invocation" above:

```bash
# Verified-working form, either image:
docker run --rm --entrypoint openscad "$SCADFORGE_OPENSCAD_IMAGE" --version
```

### Verified re-run of the QA reproduction

Re-running Phase 4 QA's exact repro after the fix, against the exact digest
value the README previously (incorrectly) documented as a working override:

```
$ docker run --rm openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7 --version
docker: Error response from daemon: failed to create task for container: failed to create shim task:
OCI runtime create failed: runc create failed: unable to start container process: error during
container init: exec: "--version": executable file not found in $PATH
(exit 127)   # <- QA's reported failure, reproduced verbatim

$ docker run --rm --entrypoint openscad openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7 --version
OpenSCAD version 2026.01.19   # <- fixed form, exit 0

$ SCADFORGE_OPENSCAD_IMAGE="openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7" docker compose up openscad
 Container scadforge-openscad-1 Started
openscad-1  | OpenSCAD version 2026.01.19
openscad-1 exited with code 0   # <- QA's exact repro command, now passing
```

## CI

`.github/workflows/ci.yml` has a `docker-smoke-render` job
(`docker/ci-smoke-render.sh`) that:
1. Builds `docker/openscad.Dockerfile`.
2. Runs `openscad --version` (via `--entrypoint openscad`) against the
   locally built image and asserts it reports `2026.01.19`.
3. **Regression-guards the override contract**: runs the identical
   `--entrypoint openscad --version` check against the bare upstream digest
   (`openscad/openscad@sha256:0af06...b52fa7`, no local build/retag) and
   asserts the same pinned version — this is the exact scenario Phase 4 QA
   found broken, now covered so it can't regress silently.
4. Renders a trivial `cube([10,10,10]);` model to PNG (also via
   `--entrypoint openscad`) and asserts the output file exists and starts
   with the PNG magic bytes.

This keeps `@docker`-tagged Vitest suites runnable in CI without needing a
registry pull on every run (the image builds from the pinned digest, which
Docker layer-caches after the first pull).
