# isomux.com on the shared VPS

The same pattern as bigOspeedrun and nilmamano.com (`~/nil/self-host-playbook.md` on the office box). This file holds no secret, address or zone ID.

- **Build.** `.github/workflows/site-image.yml` runs on every push to `main`: the site build, the tests, and a push to `ghcr.io/nmamano/isomux-site` with the tags `main`, `sha-<commit>` and `inputs-<key>`. A push that changes no image input only moves `main` to the existing image, so its digest stays and the VPS swaps nothing.
- **Run.** `compose.yaml`: the site (`site-host/server.ts`) and an egress allowlist proxy (`egress-proxy.ts`), both from the same image, read-only, no capabilities, a dedicated user. The site has no route out except through the proxy, which opens tunnels only to `api.anthropic.com` and `discord.com`. No port is published: Caddy connects to `/run/isomux-site/site.sock`. Limits: site 0.5 CPU / 256 MiB, proxy 0.25 CPU / 128 MiB.
- **Deploy.** `isomux-site-autodeploy.timer` runs `auto-deploy.sh` five minutes after the last run. A new digest on `main` is pulled by digest and swapped in; a failed check rolls it back. The check asks the socket for `/` and `/robots.txt`, and for `/` with `Accept: text/markdown`, which must answer `text/markdown` with `Cache-Control: no-store`. After a healthy swap, it removes this site's old images (the running one and the rollback stay) and purges `isomux.com`, `www.isomux.com` and `stage.isomux.com` at Cloudflare (by host: the zone also holds `cloud.isomux.com`; three tries, and a failure is logged and does not fail the deploy).
- **Caddy.** `isomux-site.stage.caddy` serves `stage.isomux.com`; the DNS cut-over (task e51d5d1c) installs `isomux-site.caddy` (`isomux.com`, `www.isomux.com`) in its place and removes the stage name. Plain HTTP on each name gets a 308 to HTTPS, path and query kept, as Vercel answers: the host's catch-all `http://` block would answer 421.

## Page caching

Pages send `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate`; the Markdown answers and the 406 send `no-store`. One Cloudflare cache rule on the isomux.com zone (phase `http_request_cache_settings`) makes pages cacheable at the edge:

```
(http.host in {"isomux.com" "www.isomux.com" "stage.isomux.com"}
 and not starts_with(http.request.uri.path, "/api/")
 and (len(http.request.headers["accept"]) eq 0
      or (len(http.request.headers["accept"]) eq 1
          and (lower(http.request.headers["accept"][0]) in {"*/*" "text/html"}
               or starts_with(lower(http.request.headers["accept"][0]), "text/html,")))))
```

Action: eligible for cache, edge TTL "respect origin", browser TTL "respect origin". An override TTL would ignore `no-store`.

The cache key does not include `Accept`, so the rule caches only requests that always get HTML. The site answers Markdown or HTML by `Accept` on `/` and `/docs/*` (`middleware.ts`), and on every unknown path (`api/not-found.ts`). `negotiate()` in `api/_content-negotiation.ts` gives HTML to these `Accept` values, and `cache-rule.test.ts` holds it to that:

| `Accept`               | Why it is HTML                              |
| ---------------------- | ------------------------------------------- |
| no header              | `negotiate(null)`                           |
| `*/*`                  | a tie, which goes to HTML                   |
| `text/html`            | only HTML is named                          |
| `text/html,<anything>` | HTML at q=1 and first, which wins every tie |

Every other request goes to the origin, which answers exactly. Free plans have no regular expressions in rules, so the rule cannot test the paths; assets fetched with another `Accept` miss the rule and fall back to Cloudflare's default caching by file extension.

## First install (by hand, once)

| Path                               | Mode      | Content                                                                                                                        |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| user `isomux-site`                 |           | `useradd --system --no-create-home --shell /usr/sbin/nologin isomux-site`                                                      |
| `/etc/isomux-site/`                | 0700 root | The env directory.                                                                                                             |
| `/etc/isomux-site/auto-deploy.env` | 0600 root | `auto-deploy.env.example`, with `ISOMUX_SITE_CF_ZONE`.                                                                         |
| `/etc/isomux-site/site.env`        | 0600 root | `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`. Piped from the office box, never printed.                                          |
| `/etc/isomux-site/purge-token`     | 0600 root | The Cloudflare purge-only token for the isomux.com zone, one line.                                                             |
| `/etc/tmpfiles.d/isomux-site.conf` | 0644      | `isomux-site.tmpfiles.conf`, then `systemd-tmpfiles --create`.                                                                 |
| `/opt/isomux-site/compose.yaml`    | 0644      | A copy of `compose.yaml`.                                                                                                      |
| `/opt/isomux-site/release.env`     | 0600      | `ISOMUX_SITE_UID=`, `ISOMUX_SITE_GID=` (of `isomux-site`) and `ISOMUX_SITE_IMAGE=ghcr.io/nmamano/isomux-site@sha256:<digest>`. |
| `/opt/isomux-site/release.commit`  | 0600      | The image's `org.opencontainers.image.revision` label (40 hex characters).                                                     |
| `/opt/isomux-site/ops/`            | 0755      | `auto-deploy.sh` and the two `isomux-site-autodeploy.*` units (the script keeps the installed units equal to these copies).    |
| `/etc/wg-caddy/isomux-site.caddy`  | 0644      | `isomux-site.stage.caddy`, imported by the host's Caddyfile; a drained reload.                                                 |

Until all of these exist, a tick changes nothing, and `/opt/isomux-site/auto-deploy/status.json` names the phase that stopped it (`config` for the env directory or `auto-deploy.env`, then `install` or `current` with `result: refused`).

## Rehearsal (main never moves)

`.github/workflows/site-image-rehearsal.yml`, run by hand, pushes `rehearsal-good` or `rehearsal-bad`: each is main's image with one layer added, so it has its own digest. `rehearsal-bad` adds a health check that always fails. Run it once with each tag, then follow them in `auto-deploy.env`:

1. `ISOMUX_SITE_TAG=rehearsal-good`: the next tick deploys it (`result: deployed`).
2. `ISOMUX_SITE_TAG=rehearsal-bad`: the next tick deploys it, the health check fails, and the tick rolls back to `rehearsal-good` (`result: rolled_back`, the digest on `auto-deploy/failed`).
3. Remove the line: the next tick deploys main again (`result: deployed`).

To run it again, push new rehearsal images: a digest on `auto-deploy/failed` is never tried again.

## Rollback

- A failed check after a swap: automatic (the previous digest runs again, the new one goes on `auto-deploy/failed`).
- A bad commit: `git revert` and push; the next image deploys within about 10 minutes.
- A pin: create `/etc/isomux-site/auto-deploy.hold`, put the wanted digest in `release.env` and its commit in `release.commit`, then `docker compose -p isomux-site -f /opt/isomux-site/compose.yaml --env-file /opt/isomux-site/release.env up -d --wait`.
- Back to Vercel during the soak: remove the `cloudflare_only` gate first (a drained Caddy reload), then point the DNS records back at Vercel.
