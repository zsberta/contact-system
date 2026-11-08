# contact-system (Rust/Loco backend + Vite frontend)
#
# `docker compose up -d --build` builds everything:
#   1. frontend-builder: npm build -> /dist (the React SPA)
#   2. backend-builder:  cargo build --release -> contact-system-cli
#   3. runner: binary + backend/config + dist + entrypoint
#
# Migrations run automatically on boot (config `auto_migrate: true` +
# explicit `db migrate` in the entrypoint). Same Postgres schema as the
# old Express backend — zero data loss on existing volumes.

# ---------- frontend ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /fe
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY index.html vite.config.ts tailwind.config.ts postcss.config.js components.json ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
RUN npm run build

# ---------- backend ----------
# NOTE: keep this on the latest Rust 1.x — loco-rs/sea-orm require ≥1.94.
FROM rust:1-bookworm AS backend-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
COPY backend ./backend
COPY public ./public
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release -p contact-system \
 && cp /build/target/release/contact-system-cli /tmp/contact-system-cli

# ---------- runner ----------
FROM debian:bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
 && groupadd -r appuser && useradd -r -g appuser appuser \
 && mkdir -p /app/uploads /app/dist /app/backend/config \
 && chown -R appuser:appuser /app
COPY --from=backend-builder /tmp/contact-system-cli /app/contact-system-cli
COPY backend/config ./backend/config
COPY backend/entrypoint.sh ./entrypoint.sh
COPY --from=frontend-builder /fe/dist ./dist
RUN chmod +x /app/entrypoint.sh /app/contact-system-cli \
 && chown -R appuser:appuser /app
USER appuser
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
