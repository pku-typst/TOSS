FROM node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS node-runtime

FROM rust:1.92.0-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS compiler-builder
COPY --from=node-runtime /usr/local /usr/local
RUN rustup component add rust-src \
    && rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.13.1 --locked
WORKDIR /src/typst.ts
COPY third-party/typst.ts .
RUN cd packages/compiler \
    && wasm-pack build --target web --scope myriaddreamin -- \
      --no-default-features --features web,misc \
    && node ../tools/wasm-debundle.mjs
