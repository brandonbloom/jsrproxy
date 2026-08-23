FROM rust:1.93-slim AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY materializer/Cargo.toml materializer/Cargo.toml
COPY materializer/src materializer/src
# A single linker job remains reliable when Colima emulates Cloudflare's amd64 target.
RUN cargo build --release --jobs 1 --package jsrproxy-materializer

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/jsrproxy-materializer /usr/local/bin/jsrproxy-materializer
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/jsrproxy-materializer"]
