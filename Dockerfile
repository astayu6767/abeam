# syntax=docker/dockerfile:1
# Abeam API + Azalea Rust Minecraft client for Railway.
# The first build is intentionally slower because Cargo compiles Azalea.

FROM rust:bookworm AS azalea
WORKDIR /src
ENV CARGO_TERM_COLOR=always \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    CARGO_BUILD_JOBS=2 \
    RUSTUP_TOOLCHAIN=nightly-2026-07-02
RUN rustup toolchain install nightly-2026-07-02 --profile minimal

# Cache the dependency build before copying the frequently-changing Rust source.
COPY azalea-bridge/rust-toolchain.toml azalea-bridge/Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo +nightly-2026-07-02 build --release || true
COPY azalea-bridge/src ./src
RUN touch src/main.rs \
    && cargo +nightly-2026-07-02 build --release \
    && cp target/release/azalea-bridge /azalea-bridge

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Next builds the reference dashboard with its dev toolchain; prune only after
# the build so the production image contains the runtime dependencies too.
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm cache clean --force
COPY --from=azalea /azalea-bridge /usr/local/bin/azalea-bridge
RUN chmod +x /usr/local/bin/azalea-bridge

# Railway injects PORT at runtime. The app defaults to 8080 locally.
# Do not declare VOLUME here: Railway requires volumes to be added in the
# service settings and mounted at /app/data.
EXPOSE 8080

CMD ["npm", "start"]
