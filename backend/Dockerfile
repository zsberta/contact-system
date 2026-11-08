# syntax=docker/dockerfile:1
# Rust builder for the Loco backend.
# NOTE: keep this on the latest Rust 1.x — loco-rs/sea-orm require ≥1.94.
FROM rust:1-bookworm AS backend-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
COPY backend ./backend
# SQL migrations are embedded via include_str!, no extra copy needed.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release -p contact-system && \
    cp /build/target/release/contact-system-cli /tmp/contact-system-cli
