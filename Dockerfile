# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS core
ARG WASM_BINDGEN_VERSION=0.2.129
WORKDIR /build
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY rules ./rules
COPY pricing ./pricing
COPY scripts/build-wasm-server.sh ./scripts/build-wasm-server.sh
RUN cargo run --locked -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules \
    && bash scripts/build-wasm-server.sh

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /build
RUN npm install --global pnpm@10.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/console-web ./apps/console-web
COPY apps/console-api ./apps/console-api
COPY apps/connector-gcp ./apps/connector-gcp
COPY packages/db ./packages/db
RUN pnpm install --frozen-lockfile --filter console-web... \
    && pnpm --filter console-web build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Readmeter" \
      org.opencontainers.image.description="Self-hosted Firebase cost diagnostics" \
      org.opencontainers.image.source="https://github.com/eviatarmor/Readmeter" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
RUN npm install --global pnpm@10.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE.md ./
COPY apps/ingest ./apps/ingest
COPY apps/console-api ./apps/console-api
COPY apps/connector-gcp ./apps/connector-gcp
COPY packages/db ./packages/db
# Services execute TS with tsx, currently declared in their devDependencies.
RUN pnpm install --frozen-lockfile --filter @readmeter/ingest... \
    --filter @readmeter/console-api... --filter @readmeter/connector-gcp... \
    && pnpm store prune
COPY --from=core /build/apps/ingest/wasm ./apps/ingest/wasm
COPY --from=core /build/target/rules ./target/rules
COPY --from=web /build/apps/console-web/dist ./apps/console-web/dist
COPY deploy/entrypoint.sh /usr/local/bin/readmeter
RUN chmod +x /usr/local/bin/readmeter
ENV NODE_ENV=production CONSOLE_STATIC_DIR=/app/apps/console-web/dist
USER node
EXPOSE 8090 8091
ENTRYPOINT ["readmeter"]
CMD ["console"]
