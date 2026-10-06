# The storefront (control-plane/web) as a container image, for the VPS target.
#
# The build context is the repository root; web.Dockerfile.dockerignore beside
# this file replaces the root .dockerignore, which belongs to the provisioner.
# The install follows the Vercel artifact (deploy/artifact.ts): the
# artifact-root pair at the root, because control-plane/ imports `pg` from above
# the web package, and then the web package's own install. Vercel builds and
# serves under Node, so this image does too; Bun only installs.

FROM oven/bun:1.3.11-slim AS bun

FROM node:24.21.0-bookworm-slim AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY control-plane/deploy/vercel-root/package.json control-plane/deploy/vercel-root/bun.lock ./
COPY control-plane/web/package.json control-plane/web/bun.lock ./control-plane/web/

FROM deps AS build
RUN bun install --frozen-lockfile \
    && cd control-plane/web && bun install --frozen-lockfile
COPY control-plane ./control-plane
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd control-plane/web && node node_modules/.bin/next build && rm -rf .next/cache

FROM deps AS runtime-deps
RUN bun install --frozen-lockfile --production \
    && cd control-plane/web && bun install --frozen-lockfile --production

FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --from=runtime-deps /app ./
COPY control-plane ./control-plane
COPY --from=build /app/control-plane/web/.next ./control-plane/web/.next
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
USER node
WORKDIR /app/control-plane/web
CMD ["node", "node_modules/.bin/next", "start"]
