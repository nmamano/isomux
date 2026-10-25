# isomux.com, self-hosted: site/ served by site-host/server.ts. Built by
# .github/workflows/site-image.yml after `bun run build:demo` and
# `bun run build:docs`; this image never builds the site.
# Run: docker run --rm --read-only --cap-drop ALL -p 127.0.0.1:3000:3000 \
#        --env-file <root-only file with ANTHROPIC_API_KEY, DISCORD_WEBHOOK_URL> isomux-site
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY node_modules/path-to-regexp-6 ./node_modules/path-to-regexp-6
COPY vercel.json middleware.ts ./
COPY api ./api
COPY site-host/server.ts ./site-host/server.ts
COPY site-host/deploy/egress-proxy.ts ./site-host/deploy/egress-proxy.ts
COPY site ./site
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/robots.txt').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "site-host/server.ts"]
