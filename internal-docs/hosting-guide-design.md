# Hosting guide composition

Implemented for the hosting-guide-0921 lane on 2026-09-21. The hosting decision diagram has eight canonical guide identities. Each leaf
opens a static page with one complete guide. Native navigation supplies direct
links, keyboard activation, browser history, and no-JavaScript access. The
chatbot reads that page's composed body without client-side context switching.

## Leaf map and evidence

| ID | Page | Source and availability evidence |
| --- | --- | --- |
| hosted | `/docs/hosting-hosted` | `docs/hosting/hosted.md`; `site/hosted.html` links to `cloud.isomux.com`; `control-plane/web/app/signin`, `app/signup/page.tsx`, `components/signup-form.tsx`, and `lib/i18n/en.ts` define Google sign-in, saved administrator key, payment, invite, and confirmed handoff. No purchase or provisioning run in this lane. |
| render | `/docs/hosting-render` | `docs/hosting/render.md`; `render.yaml`, `deploy/render/README.md`, and the previous hosting guide define the paid Blueprint, disk, custom domains, and setup key. Nil removed the Preview diagram label on 2026-09-22; incomplete deployment validation does not make the route unavailable. No new Render acceptance claim. |
| aws | `/docs/hosting-aws` | `deploy/container/README.md` is the only maintained body. The public release image and installer are available. Actual new-installer acceptance is separate, recorded in `container-verification.md`. |
| vps | `/docs/hosting-vps` | `docs/hosting/vps.md`; `deploy/install.sh` implements the fresh Ubuntu host installer, owner invite, Caddy, hardening, and updater. |
| local | `/docs/hosting-local` | `docs/hosting/local.md`; README Get Started, `package.json` dev command, and `docs/access-and-invites.md` cover prerequisites and loopback owner claim. The local guide covers Linux/macOS, with the systemd app limitation stated. |
| private | `/docs/hosting-private` | `docs/hosting/private.md`; previous own-hardware path, access settings in `server/isomux-office.ts`, and Tailscale Serve. Always-on instructions explicitly target Linux/systemd. |
| funnel | `/docs/hosting-funnel` | `docs/hosting/funnel.md`; previous Funnel path and its port-sharing check, current access settings, and Tailscale Funnel. No wildcard app-hostname promise. |
| domain | `/docs/hosting-domain` | `docs/hosting/domain.md`; previous Caddy alternative, the installer Caddy shape, `server/tls-ask.ts`, and app-host routing. Public IP/router/firewall prerequisites remain explicit. |

Caddy installation and Tailscale Serve/Funnel documentation were read on
2026-09-21. Their source links are in the relevant guides. External hosting
consoles and provider actions were not exercised.

## Source rules

`scripts/hosting-docs.ts` is the small explicit identity and fragment map.
`docs/hosting/blocks/*.md` holds identical installation, owner, provider,
service, Tailscale, sign-in, invite, update, and backup steps. Includes accept
only named blocks and cannot nest. Provider and route differences stay in the
individual sources. AWS retains a complete GitHub-readable README; the build
maps it directly to its docs page and fixes its relative reference link.

`scripts/build-docs.ts` expands bodies once for HTML, negotiated Markdown, and
chatbot context. Generated guide pages stay out of the top-level docs sidebar;
the decision diagram links to them; each guide links back. Optional configuration lives in
`docs/hosting-reference.md`; AWS operations stay with the AWS guide, and source
hashes, measurements, smoke commands, and acceptance limits live internally.

`/docs/self-hosted` remains the entry point. Every retained fragment has a real
HTML link and a Markdown destination. `site/hosting-links.js` replaces a known
legacy fragment URL with that destination; unknown fragments stay on the entry
page. The old Vercel redirect routes remain unchanged.

## Assertions removed or replaced

- Removed the claim that local use requires no setup; the local guide contains
  prerequisites, installation, owner claim, and a provider-message check.
- Replaced the three-way hosting overview with eight explicit complete paths.
- Replaced the Linux persistence agent prompt and the instruction to adjust it
  for macOS/Windows with concrete Linux service steps. Local macOS use remains
  explicit; there is no new always-on macOS/Windows leaf or roadmap claim.
- Replaced the Funnel-only agent prompt with inline setup and the existing
  shared-port/public-exposure checks. Removed the short Cloudflare Tunnel
  alternative from the setup page; it had no complete maintained product path.
- Replaced Render's unqualified setup presentation with Preview and paid-resource
  wording. The Blueprint instructions remain; no new validation is claimed.
- Moved AWS's image warning before resource creation. The approved server, disk,
  DNS, mount, installer, claim, and recovery detail remains in the canonical body.
- Moved dated source-image verification evidence out of the public container
  reference. No Fargate support, certification, or future route is asserted.
- Corrected the doc-surface index's stale hosted not-live description to match
  the existing sign-in link. Hosted sales and checkout copy are unchanged.
- Replaced the chatbot's old generic setup sequence with guide-specific routing
  and availability context. No chatbot model calls were made.

## Verification

The deterministic gate is `bun test scripts/hosting-docs.test.ts
api/_site-agent-readiness.test.ts scripts/site-widgets-i18n.dom.test.ts`.
It builds real output and checks one-to-one diagram destinations,
guide return links, HTML/Markdown/context agreement, inline shared steps, canonical AWS
commands, notice placement, and local links/fragments without copy literals.

After `bun run build:docs`, run `bun scripts/hosting-browser-check.ts` under the
lane memory limit. It serves only the static build on an ephemeral loopback
port, blocks external requests, and stubs the chatbot endpoint. It checks 1280px
and 390px viewports, each guide route, native keyboard link
activation, back/forward, legacy links, unknown hashes, no-JavaScript navigation,
page overflow, and the outgoing chatbot context. It produces screenshots and a
verbatim rendered English-copy artifact under the ignored
`internal-docs/private/hosting-guide-0921/` directory. The artifact is not a
second maintained source.

Normal lane gates also include build:ui, scoped ESLint, and root tsc. The scripts
receive an extra explicit strict typecheck because the root tsconfig does not
include test files under scripts. Gate logs must start with the committed hash.
