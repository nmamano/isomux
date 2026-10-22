# The storefront (control-plane/web) as a container image, for the VPS target.
#
# The build context is the repository root; web.Dockerfile.dockerignore beside
# this file replaces the root .dockerignore, which belongs to the provisioner.
# The install puts the deploy/vercel-root pair at the root, because
# control-plane/ imports `pg` from above the web package, and then runs the web
# package's own install. The storefront builds and serves under Node; Bun only
# installs.

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun

FROM node:24.22.1-bookworm-slim AS deps
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

FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY --from=runtime-deps /app ./
COPY control-plane ./control-plane
COPY --from=build /app/control-plane/web/.next ./control-plane/web/.next
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
USER node
WORKDIR /app/control-plane/web
CMD ["node", "node_modules/.bin/next", "start"]
