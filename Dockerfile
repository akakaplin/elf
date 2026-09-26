# syntax=docker/dockerfile:1.7

# glibc, not the musl-on-`scratch` the sibling `perpl` uses. The `duckdb` crate
# links a prebuilt DuckDB shared object, and the only Linux builds upstream
# publishes are glibc ones. `distroless/cc` is the small end of what can load
# it: glibc, libstdc++ and libgcc, and no shell.

ARG RUST_VERSION=1.98.1
ARG DEBIAN_VERSION=bookworm

FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS builder

# Without this the build script falls through to pkg-config and links whatever
# libduckdb the image has, which is none. With it, it fetches the official
# prebuilt libduckdb for the target triple at the version the crate encodes
# (1.10505.0 -> DuckDB 1.5.5). This is an env var rather than a feature, so
# `Cargo.lock` is untouched and `--locked` still means something. The
# alternative, `--features duckdb/bundled`, compiles DuckDB from source: about
# fifteen minutes, and it needs a lockfile update to pull in `cc`.
ENV DUCKDB_DOWNLOAD_LIB=1

# The release profile in Cargo.toml asks for fat LTO and one codegen unit.
# `build.sh --fast` passes thin LTO and parallel codegen for local iteration;
# the env vars outrank the manifest. Each setting gets its own target directory
# inside the cache mount, so switching between the two does not throw away the
# other's artifacts.
ARG LTO=fat
ARG CODEGEN_UNITS=1
ENV CARGO_PROFILE_RELEASE_LTO=${LTO} \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=${CODEGEN_UNITS} \
    CARGO_TARGET_DIR=/app/target/${LTO}

# `/app`, not `/build`: `--web` defaults to `CARGO_MANIFEST_DIR/web` and that
# path is baked in at compile time. Building here and putting the assets at
# `/app/web` below makes the compiled-in default the correct path inside the
# image, so overriding CMD does not silently cost you the UI.
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

# The cache mounts put the registry and `target/` outside the layer, so both
# the binary and the downloaded libduckdb have to be copied out inside this
# same RUN. The `.so` is not optional: nothing here is statically linked
# against DuckDB, and the rpath cargo bakes in points into `target/`, which
# does not outlive this stage.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/app/target,sharing=locked \
    cargo build --release --locked \
 && cp "$CARGO_TARGET_DIR/release/elf" /elf \
 && cp "$CARGO_TARGET_DIR/release/deps/libduckdb.so" /libduckdb.so

# Made here because the runtime stage has no shell to make it in, and the
# unprivileged UID below could not create it once the image is running. It
# exists so that a run which forgot `-v` fails with elf's own message about a
# missing series/ rather than something vaguer about /data itself.
RUN mkdir -p /out/data && chown 65532:65532 /out/data

FROM gcr.io/distroless/cc-debian12 AS runtime

# Found through LD_LIBRARY_PATH rather than the rpath in the binary, which
# names the builder's `target/duckdb-download/...` and is a dangling path here.
COPY --from=builder /libduckdb.so /usr/local/lib/libduckdb.so
ENV LD_LIBRARY_PATH=/usr/local/lib

COPY --from=builder /elf /app/elf
COPY web /app/web
COPY --from=builder --chown=65532:65532 /out/data /data

# Numeric: the base ships a `nonroot` entry, but naming it would tie the image
# to that base continuing to carry one.
USER 65532:65532

# DuckDB spills to `.tmp` *under the working directory* when an in-memory query
# outgrows its memory budget, and every other directory here is read-only to
# this UID — /data deliberately so. The base's /tmp is 1777, which makes it the
# one place the spill can be created; without this a large window would fail on
# a directory it is not allowed to make.
WORKDIR /tmp

EXPOSE 8787

# No VOLUME for /data. elf only reads the store, so the one thing the
# declaration buys — keeping writes made to an unmounted path — does not apply,
# and it would leave an anonymous volume behind on every run that forgot `-v`.

# elf holds nothing that needs flushing — the store is opened read-only and the
# DuckDB database is in memory — and as PID 1 it has no SIGTERM handler, so the
# kernel discards the signal and every `docker stop` waits out its full grace
# period before killing it anyway. Asking for the kill up front costs nothing
# and saves ten seconds. Remove this line if elf ever grows a shutdown path.
STOPSIGNAL SIGKILL

ENTRYPOINT ["/app/elf"]

# `--host` is the flag that matters: the default 127.0.0.1 binds inside the
# container's own network namespace, where a published port cannot reach it.
# 8787 is already the default, spelled out so this line and EXPOSE cannot drift
# apart. Any argument to `docker run` replaces the whole list, so repeat
# `--data` and `--host` when you override it.
CMD ["--data", "/data", "--host", "0.0.0.0", "--port", "8787"]
