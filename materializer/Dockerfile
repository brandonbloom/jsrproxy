FROM rust:1.93-slim AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY materializer/Cargo.toml materializer/Cargo.toml
COPY materializer/src materializer/src
RUN cargo build --release --package jsrproxy-materializer

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/jsrproxy-materializer /usr/local/bin/jsrproxy-materializer
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/jsrproxy-materializer"]
