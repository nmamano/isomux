# Build with deploy/container/build.sh from a committed source revision.
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential ca-certificates git tini chromium chromium-sandbox bubblewrap && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/isomux
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:ui && mkdir -p /var/data && chown node:node /var/data
ARG ISOMUX_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/nmamano/isomux" org.opencontainers.image.revision=$ISOMUX_REVISION
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD bun deploy/container/probe.ts
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "deploy/container/entrypoint.sh"]
