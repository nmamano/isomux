# Build with deploy/container/build.sh from a committed source revision.
# Keep the former Node base's build and workspace tools, without Node itself.
FROM buildpack-deps:bookworm@sha256:b22578185ebfdbd9a4050f697638b9c9696b70616d9b01bddfa79145db2b6dfd
# Preserve the account identity, home and shell used by existing data volumes.
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential ca-certificates git curl procps openssh-client unzip xz-utils tini chromium chromium-sandbox bubblewrap jq && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/isomux
COPY package.json bun.lock ./
# bun install leaves group- and other-writable files in node_modules. Drop
# that write here, in the same layer: a recursive chmod in a later layer
# copies every file into that layer.
RUN ! command -v node && ! command -v npm && ! command -v npx && bun install --frozen-lockfile \
    && chmod -R go-w /opt/isomux
COPY . .
RUN bun run build:ui && mkdir -p /var/data && chown node:node /var/data \
    && ln -s "$(bun -e 'import { CLAUDE_NATIVE_BIN } from "./server/cwd-utils.ts"; process.stdout.write(CLAUDE_NATIVE_BIN)')" /usr/local/bin/claude \
    && install -o root -g root -m 755 deploy/isomux-member-user.sh /usr/local/sbin/isomux-member-user \
    && install -d -o root -g root -m 755 /etc/isomux \
    && install -o root -g root -m 644 deploy/container/member-user-container.conf /etc/isomux/member-user-container.conf \
    && find /opt/isomux ! -type l -perm /022 -exec chmod go-w {} +
ARG ISOMUX_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/nmamano/isomux" org.opencontainers.image.revision=$ISOMUX_REVISION
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD bun deploy/container/probe.ts
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "deploy/container/entrypoint.sh"]
