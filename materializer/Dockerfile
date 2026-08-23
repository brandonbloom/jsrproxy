FROM rust:1.93-slim AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY materializer/Cargo.toml materializer/Cargo.toml
# A single linker job remains reliable when Colima emulates Cloudflare's amd64 target.
# Compile dependencies in their own layer so source-only edits do not rebuild
# the entire dependency graph under emulation.
RUN mkdir -p materializer/src \
  && printf 'fn main() {}\n' > materializer/src/main.rs \
  && : > materializer/src/lib.rs \
  && cargo build --release --jobs 1 --package jsrproxy-materializer
COPY materializer/src materializer/src
RUN cargo build --release --jobs 1 --package jsrproxy-materializer

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/jsrproxy-materializer /usr/local/bin/jsrproxy-materializer
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/jsrproxy-materializer"]
