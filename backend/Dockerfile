ARG TOSS_DISTRIBUTION=community

FROM node:24.18.0-bookworm-slim AS node-runtime

FROM node-runtime AS distribution-community
RUN mkdir -p /bundle/distributions/community /bundle/builtin/typst
COPY distributions/community /bundle/distributions/community

FROM distribution-${TOSS_DISTRIBUTION} AS selected-distribution
RUN chmod -R a=rX /bundle

FROM node-runtime AS web-builder
ARG TOSS_DISTRIBUTION
ENV TOSS_CONFIG=/workspace/distributions/${TOSS_DISTRIBUTION}/toss.json
WORKDIR /workspace
COPY web/package.json ./web/package.json
COPY web/package-lock.json ./web/package-lock.json
COPY web/typst-runtime.config.json ./web/typst-runtime.config.json
COPY scripts/fetch-runtime-artifacts.mjs ./scripts/fetch-runtime-artifacts.mjs
COPY scripts/prebuilt-typst-compiler.mjs ./scripts/prebuilt-typst-compiler.mjs
COPY scripts/typst-compiler-builder.Dockerfile ./scripts/typst-compiler-builder.Dockerfile
COPY prebuilt/typst-compiler/build-manifest.json ./prebuilt/typst-compiler/build-manifest.json
COPY prebuilt/typst-compiler/artifact.json ./prebuilt/typst-compiler/artifact.json
COPY prebuilt/busytex/build-manifest.json ./prebuilt/busytex/build-manifest.json
COPY protocol/package.json ./protocol/package.json
COPY protocol/package-lock.json ./protocol/package-lock.json
COPY --from=selected-distribution /bundle/distributions ./distributions
RUN node scripts/fetch-runtime-artifacts.mjs
RUN node scripts/prebuilt-typst-compiler.mjs verify-package
WORKDIR /workspace/protocol
RUN npm ci
WORKDIR /workspace/web
RUN npm ci
COPY protocol/openapi.json /workspace/protocol/openapi.json
COPY protocol/scripts /workspace/protocol/scripts
COPY web .
RUN npm test && npm run build

FROM debian:bookworm-slim AS runtime-common
ARG TOSS_DISTRIBUTION
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git git-lfs libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY backend/migrations ./migrations
COPY --from=web-builder /workspace/web/dist ./web-dist
COPY --from=selected-distribution /bundle/builtin ./builtin
COPY --from=selected-distribution /bundle/distributions ./distributions
ENV WEB_STATIC_DIR=/app/web-dist
ENV TOSS_CONFIG=/app/distributions/${TOSS_DISTRIBUTION}/toss.json
ENV HOME=/tmp
EXPOSE 8080
CMD ["core-api"]

FROM rust:1.97.0-bookworm AS builder
WORKDIR /app
COPY backend/Cargo.toml ./Cargo.toml
COPY backend/Cargo.lock ./Cargo.lock
# Keep the expensive dependency graph in a layer keyed only by Cargo manifests.
# The real source is copied afterwards, so ordinary application changes rebuild
# core-api without recompiling every dependency in local Docker builds.
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN touch src/main.rs && cargo build --release --locked

# The default target preserves standalone local builds from source.
FROM runtime-common AS runtime-source
COPY --from=builder /app/target/release/core-api /usr/local/bin/core-api
