# Hosted Isomux ("oneclickclaw.io but for isomux")

> Status: scoped (2026-07-19). Not yet implemented, not yet interviewed in
> depth. Author: Isomux Brainstormer. Task: c91af4a4.
> Companion reading: `isolation-design.md` (escalation matrix, hub design),
> `docs/self-hosted.md` (manual operator setup this would automate).

A managed-hosting product where a customer signs up, pays, and gets their own
VPS running isomux at `https://<name>.isomux.app`, without touching a
terminal. Modeled directly on [oneclickclaw.io](https://oneclickclaw.io),
which does exactly this for OpenClaw.

## Domains (decided with Nil, 2026-07-19)

- **Control plane: `cloud.isomux.com`** - subdomain of the existing brand
  (the GitLab/Grafana pattern: apex = the open-source product, `cloud.` =
  the managed version). No standalone brand: oneclickclaw needed one
  because they host someone else's product; we host our own.
- **Customer instances: `<name>.isomux.app`** - a separate apex, NOT under
  isomux.com. Instances serve agent-generated content and uploads; keeping
  them off the main domain isolates cookie scope and origin reputation
  (the github.io-vs-github.com pattern). `.app` is an HTTPS-only TLD;
  Caddy's automatic certs satisfy it.
- **Action item: register isomux.app promptly** (unregistered as of
  2026-07-19, ~$15/yr) before someone squats it. isomux.dev and isomux.io
  are also free if defensive registration is wanted.

## The reference product (what oneclickclaw actually is)

Verified from their site/docs and by fingerprinting the deployment
(2026-07-19):

- **Control plane**: a Next.js app (served behind Google infra, likely Cloud
  Run). Landing, docs, Google OAuth sign-in, Stripe billing, a customer
  dashboard with provisioning progress, metrics (CPU/RAM/disk/uptime), a live
  event log, and toggles (e.g. enable SSH).
- **Data plane**: one dedicated **Webdock** VPS per customer (Ubuntu,
  EU/Denmark). Their installer sets up the product, hardens the box
  (firewall, SSH keys, unattended upgrades), and fronts it with Nginx +
  Let's Encrypt.
- **BYOK**: customers bring their own model API keys and pay the provider
  directly. The host never resells tokens.
- **Pricing**: EUR 14.99 / 25.99 / 49.99 per month for 2/4/8 vCPU tiers;
  7-day free trial, no card. Webdock's equivalent instances cost roughly
  EUR 6-12/mo, so margins are real.
- Provisioning takes ~5 minutes after payment; SSH is off by default and
  opt-in from the dashboard.

"Exact same stack" for us therefore means: **Next.js control plane + Webdock
API data plane + Google OAuth + Stripe + Caddy-or-Nginx with auto-TLS on the
customer box**.

## Architecture

```
Customer ── Google OAuth + Stripe ──> Control plane (Next.js, cloud.isomux.com)
                                          │  Webdock API + DNS API
                                          v
                              Per-customer VPS (Ubuntu)
                              cloud-init installer:
                                bun + isomux + systemd unit
                                Caddy (auto-HTTPS)
                                owner claim + invite mint (loopback)
                                      │
Customer ── https://<name>.isomux.app (isomux's own auth takes over)
```

The control plane owns signup/billing/provisioning/monitoring. Once the box
is up, the customer's relationship is directly with their isomux instance;
the control plane only health-checks it and pushes updates.

Provider notes (Hetzner in practice, 2026-07-21): the cost-optimized CX
line is effectively sold out fleet-wide, so tier pricing must assume
CPX-class costs (~$13-42/box), not the €6-18 CX prices. Every customer box
gets Hetzner's box-level backup option (+20% of box price, 7 off-box
snapshots): it covers box loss, which isomux's own same-disk daily backups
don't (decided with Nil).

## What isomux already has (audit, 2026-07-19)

The hostability foundation is better than expected:

- **Auth**: session cookies (HttpOnly, Secure-on-HTTPS), invite-link
  onboarding with one-time 256-bit tokens, owner/member roles, per-device
  session revocation (`server/auth.ts`, `server/auth-middleware.ts`). No
  password system needed; the invite model is ideal for a hosted handoff.
- **Public exposure anticipated**: `ISOMUX_PUBLIC_ORIGIN`, HSTS + security
  headers, origin validation against the operator-set origin (not Host
  headers). `docs/self-hosted.md` already prescribes the Caddy pattern.
- **Headless bootstrap works today**: pre-claim, the server binds loopback
  only and `/auth/claim` is tokenless on loopback. An installer can
  therefore create the owner and mint the customer's invite link with local
  curl calls, then report the invite URL back to the control plane. No
  interactive step on the box.
- **State is relocatable** (`ISOMUX_HOME`); daily backups already land in
  `~/isomux-backups/`; Codex is bundled as an npm dep (no separate
  install).
- **BYOK fits natively**: per-user env files for API keys; subscription
  OAuth for Claude/Codex can be completed from isomux's own terminal panel.

## Work breakdown

### A. Unattended installer (the tracer bullet, ~3-5 days incl. real-VPS testing)

One script (cloud-init user-data or curl-able bash) that turns a fresh
Ubuntu VPS into a working, HTTPS-served isomux:

1. Install bun; fetch isomux at a pinned release (see C1); `bun install`;
   build UI.
2. Write and enable a systemd unit (system-level or a dedicated user with
   lingering; today's docs assume a user service).
3. Install Caddy; reverse-proxy `:443 -> 127.0.0.1:4000` with automatic
   Let's Encrypt; set the public origin via `PUT /api/office/access` (the
   `ISOMUX_PUBLIC_ORIGIN` env var is deprecated).
4. Harden: ufw (443 + optionally 22), SSH keys only, unattended-upgrades.
5. Claim owner + mint invite via loopback; POST the resulting invite URL and
   a health status back to the control plane callback.

Independently valuable even if the product never launches: self-hosters want
exactly this script, and it de-risks everything downstream. Ship it as the
first slice and test it against a real cheap VPS.

### B. Control plane (Next.js, the bulk, ~2-3 weeks part-time)

- Landing page + docs (copy rules: describe capabilities, no internal
  mechanisms; no "simple/lightweight" small-signaling).
- Google OAuth (NextAuth/Auth.js), Stripe Checkout + webhooks
  (trial -> active -> past_due -> cancelled).
- Provisioning state machine driving the Webdock API: create server, inject
  cloud-init, poll status, `<name>.isomux.app` A-record via the DNS API,
  wait for installer callback, expose progress to the dashboard. This is where the
  reliability engineering lives (retries, partial failure, "stuck at step
  3" recovery, idempotent re-runs).
- Customer dashboard: provisioning progress, the invite link handoff,
  instance health, restart button, SSH toggle, metrics proxied from the
  Webdock API, cancel/deprovision. (SSH decision, Nil 2026-07-20: customers
  may get root access; pair enabling it with a clear warning about what not
  to touch - the isomux service, updater config, Caddy, firewall.)

### C. Gaps in isomux itself (~1 week)

The part oneclickclaw did not have to build, because OpenClaw is a mature
upstream with releases:

1. **Release channel.** Today isomux is "git main on Nil's machine". Hosted
   customers need pinned, versioned releases and a tested update path
   (fetch tag -> `bun install` -> build -> restart). Restarts interrupt
   running agents, so updates should be operator-triggered or
   maintenance-windowed, not silent.
2. **First-run onboarding.** A guided flow for connecting Claude/Codex on a
   headless box (subscription OAuth via `claude setup-token` / terminal
   panel, or API keys via the user env file). This is the fiddliest
   customer-facing step; today it is folklore.
3. Small: no restore-from-backup UI. (The other half of this item, prompts
   deriving human-facing URLs from the public origin, shipped 2026-07-19.)

### D. Ops (ongoing; the real cost)

Fleet health monitoring + alerting, fleet update rollout, support load,
ToS/privacy policy, abuse posture (customers run shell-capable agents, but
on their own dedicated VPS - same liability shape as oneclickclaw; egress
abuse is a Webdock-ToS matter), deprovisioning + data retention on
cancellation.

## Isolation stance

Single-tenant-per-VPS sidesteps the hard multi-tenant problems in
`isolation-design.md`: each customer's agents run on hardware only they
rent. Within one customer's box, the existing trusted-co-tenant model
(per-user env files, room ACLs) applies unchanged. The hub / bwrap /
microVM escalation ladder only becomes relevant if we ever pack multiple
customers onto one machine - explicitly out of scope here.

## Go-to-market note (from the task)

Nil's plan: give **free plans to influencers** so they can play with it.
Implication for scope: the trial/free tier must be first-class (a
"comped" flag on an account that skips Stripe), and the onboarding path
(C2) matters more than breadth of dashboard features - an influencer who
stalls on Claude login churns silently.

## Phasing

1. **Slice 1 - installer**: fresh VPS -> HTTPS isomux + invite link, one
   command. Manually provision the first accounts with it.
2. **Slice 2 - control plane MVP**: OAuth + Stripe + automated provisioning
   + status page + invite handoff.
3. **Slice 3 - fleet ops**: monitoring, updates, SSH toggle, deprovision.
4. Parallel prerequisite: isomux release process (C1).

## Effort and honest risk

- Technically moderate; no single hard problem. MVP (slices 1-2, minimal
  dashboard) ~1-2 weeks of agent-driven work; fully self-serve with fleet
  ops ~4-6 weeks part-time.
- The hard parts are not code: (a) isomux has no release/update process
  yet - that is the true prerequisite; (b) paid customers create a
  standing ops/support obligation; oneclickclaw works because OpenClaw has
  a large user base demanding managed hosting, while isomux demand is
  unproven. The influencer-free-plan route is a cheap way to test demand
  before taking on paying-customer obligations.

## Open questions (for a design interview before building)

1. Webdock confirmed as provider, or nearest-equivalent (Hetzner is
   cheaper; Webdock's API is what the reference uses)?
2. Pricing tiers and whether a paid tier exists at launch, or
   influencer-comped-only first.
3. Update policy: who triggers customer-instance updates, and what is the
   maintenance-window story given restarts kill running agents?
4. Where does the control plane run (Vercel vs. a box we own)?
5. Support channel and expectations for comped users.
