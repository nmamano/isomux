# Phase-3 loop - standing orders + slice handoffs

Working artifact for the app-hostnames slice loop started 2026-08-06 (task
f51fe505), orchestrated by Isomux Manager. Workers: re-read this WHOLE file at
the start of every slice - conversations compact, files don't. Delete or
archive after the loop closes.

## North star

Phase 3 of `agent-apps-design.md`: registered apps get stable per-app
subdomain origins - `<name>.apps.<office domain>` - riding the transport and
auth handshake of `port-proxy-design.md`, TLS from the same Caddy terminator
every install uses. One generic design; hosted customers and self-hosters
share the structure. Build plan drafted by Isomuxer1, citations verified and
accepted by the manager 2026-08-06.

## Three facts that shape the loop (from the accepted plan)

1. **Everything ships dark.** Slices 1-6 and 8 are inert until an apps domain
   is configured; main stays deployable and external self-hosters see no
   change until they add DNS. No state-schema break: apps.json grows fields
   additively; the updater's rollback restores the whole state root.
2. **Not observable on Nil's own office.** Tailscale MagicDNS has no wildcard
   names, so `*.apps.auntie...` cannot exist. End-to-end verification lives on
   the Hetzner test box with a real domain (S7, gated on Nil). This is not a
   tailnet arm - the design is generic, just unreachable on a tailnet-only
   name.
3. **`__Host-` on the office cookie is now load-bearing.** Once apps are
   descendants of the office host, an app page could set a `Domain=<office>`
   cookie and shadow the office session cookie. port-proxy-design.md:276 filed
   the `__Host-` prefix as eventual cleanup; it must land BEFORE any app is
   reachable (S2, before S5).

## Rulings (final - do not relitigate)

- One generic design, no tailnet-specific arm (Nil, task f51fe505).
- Generation labels: names/ports are reusable since 64a91fb, so a reused name
  lands on a FRESH hostname label, never the predecessor's origin
  (service-worker/storage attack, port-proxy-design.md).
- Auth: office login required, host-only cookies, no anonymous access
  (port-proxy-design.md handshake).
- No approval click on anything agents do; no arbitrary caps beyond sanity
  constants; no env-var knobs unless genuinely per-deployment.

## Manager-accepted defaults (reversible unless marked)

1. Label shape: first registration of a name gets `<name>`, later ones get
   `<name>-g<N>`. Reversible only until S7 lands on a real domain.
2. Ledger: `issuedLabels[]` in apps.json, never pruned, inside the backup set.
3. Apps domain defaults to `apps.<office host>` derived from `publicOrigin`,
   overridable by an installer-written key. Changing `publicOrigin` moves
   every app URL - accepted.
4. Access: any signed-in office user.
5. Effective name cap 59 chars on new registrations (room for `-g<N>`);
   existing names grandfathered.
6. No enable click for registered apps (restating Nil's ruling, not new).

## Process per slice

1. Manager authors the SLICE-N PICKUP section below, clears the worker's
   session, sets its effort, sends it the pickup.
2. Worker reads this file + the design docs, writes a short plan, sends it to
   its counterpart reviewer (plan-gate). Adjust on feedback before coding.
3. Worker implements IN MAIN (`~/nil/isomux`, no worktree), one slice only.
4. Worker runs the always-run gates (below), fixes until green.
5. Worker freezes (no further edits), fingerprints the diff
   (`git diff HEAD | wc -l` + `md5sum`, untracked included via
   `git add --intent-to-add .`), sends the reviewer the diff-gate request
   quoting the fingerprint. Applies verdict findings, re-fingerprints,
   re-verdicts until approve.
6. Worker reports to Isomux Manager: what changed, how verified, reviewer
   verdict, ALL added/edited prose quoted verbatim, mutation statement,
   anything parked.
7. Manager sanity-checks, runs `bunx prettier --write` on touched files,
   commits ONE focused commit ("Implemented by IsomuxerN; reviewed by
   ReviewerN" + Co-Authored-By), ticks the checkbox, authors the next pickup
   folding in what this slice taught.

Never two slices in flight. Never start N+1 with N uncommitted.

## Gates per slice (always-run, exact commands)

- `bunx eslint <touched files>` - clean.
- `bun test > /tmp/slice-test.log 2>&1; echo exit=$?` - exit=0. NEVER pipe
  the run through tail/grep in the same command; redirect, echo $?, then read.
- `bun run build:ui > /tmp/slice-build.log 2>&1; echo exit=$?` - exit=0.
- Server-behavior slices: isolated-instance smoke - boot with
  `ISOMUX_HOME=$(mktemp -d) PORT=141xx bun server/isomux-office.ts`, drive the
  new behavior with curl (Host-header spoofing is fine for app-host slices),
  judge by responses + state files, kill, rm the temp dir.
- `bun run test:systemd` when launcher/unit/supervisor files change.
- New/changed tests must FAIL when the feature is reverted (mutation-check;
  state how you know in the report).

Manager-only, before any live-office restart: full `bun run ci` green AND the
isolated boot smoke green AND a wake-up message scheduled to self (~2.5 min
out). Restart authorization per the 2026-08-06 program (handoff brief).

## Standing rails (prohibitions)

- NEVER touch the live office state (`~/.isomux`) or the live service from
  tests or dev runs. Isolated instances only: own PORT + mktemp ISOMUX_HOME.
- Workers never restart the isomux service. Only the manager does.
- No `git push`. No commits by workers - the manager commits each slice.
- Test systemd units use the derived test prefix and are cleaned up even on
  failure. No unit created by testing survives.
- Never weaken or skip a gate to pass. A gate failure is fixed in-slice or
  the slice stops and the blocker is queued.
- Security posture is fail-closed everywhere: unknown/retired label -> 404,
  no session -> login, doubt -> refuse. Auth/proxy code gets the strictest
  review; assume a hostile app and a hostile network.
- Nothing outward-facing turns on by default: with no apps domain configured
  the whole feature is inert.
- No new dependencies without queueing for Nil.
- Scope fence: policy or API-surface choices not covered by the design docs,
  the accepted defaults above, or this file go to the manager, not into code.

## Decision protocol

- Worker + reviewer settle: implementation details, exact validation rules,
  state-file shape, test strategy.
- Manager settles: slice scope calls, naming, anything worker+reviewer
  deadlock on.
- PARKED FOR NIL (end-of-batch, never decided in-loop):
  - URL shape: `hello.apps.<office>` (working default) vs flat
    `hello.<office>`. Cosmetic but needs answering BEFORE S7 lands on a real
    domain.
  - S2 touches session auth on his own box (dual-read keeps sessions alive,
    but it is his login path - flag, don't ask mid-loop).
  - DNS: a wildcard record for the test box; tailnet offices can never have
    app hostnames.
  - New public surface: wildcard DNS + on-demand TLS means any SNI triggers a
    CA request gated by tls-ask; proposed per-hour issuance cap rides S7.
  - Final wording sign-off on ALL prose (docs, UI strings, system-prompt).

## Slice plan (accepted 2026-08-06; details in each pickup as authored)

- [ ] S1  Hostname ledger + label allocation (registry only, dark).
- [ ] S2  Office cookie `__Host-` hardening (independent; before S5).
- [ ] S3  Apps domain config + Host matching (dark until configured).
- [ ] S4  Auth handshake (single-use code, app cookie; no app bytes yet).
- [ ] S5  HTTP relay (first slice where a real app answers).
- [ ] S6  WebSocket relay.
- [ ] S7  Caddy + DNS (GATED ON NIL: domain + URL-shape answer; only slice
         needing a real box; installer site block + tls-ask; update path
         deliberately does NOT rewrite the Caddyfile - enabling app
         hostnames stays an explicit operator step, documented).
- [ ] S8  ISOMUX_APP_URL injection (renderUnit + reconcile pass; absent when
         no domain configured).
- [ ] S9  UI: link the hostname when present; keep port link otherwise.
- [ ] S10 Prompt + docs (system-prompt app-URL guidance, README/docs,
         design docs marked resolved, documentation.md surfaces).

## Resources

- Design: `internal-docs/port-proxy-design.md` (transport + handshake),
  `internal-docs/agent-apps-design.md` section 4 (generation labels),
  `internal-docs/release-design.md` (update consistency).
- Registry: `server/app-registry.ts` (+ its tests); supervisor seam:
  `server/app-supervisor.ts`; reconcile precedent:
  `server/app-token-reconcile.ts`.
- Office cookie: `server/auth.ts:1587` (COOKIE_NAME), `auth-middleware.ts`.
- Request dispatch: `server/isomux-office.ts` fetch handler (~4200).
- Apps tab link: `ui/components/AppsView.tsx:386`.
- Installer: `deploy/install.sh` (managed-Caddy machinery, CADDY_MARKER);
  installer tests: `deploy/install-sh.test.ts`.
- Testing patterns: `internal-docs/testing-guide.md`; doc surfaces:
  `internal-docs/documentation.md`.
- Baseline: commit 64a91fb; `bun run ci` green (log: /tmp/ci-out.txt).

## SLICE-1 PICKUP (authored 2026-08-06, baseline 64a91fb)

Goal: the hostname ledger exists - every app carries a hostname label and a
generation, labels are unique forever, and a re-registered name provably
never gets its predecessor's label. Registry only; nothing serves on any
hostname yet.

Load-bearing mechanics and traps:
- `shared/types.ts`: `AppRecord` gains `hostLabel` + `hostGen` (additive);
  apps.json gains `issuedLabels[]`, never pruned. Persistence follows the
  registry's existing fail-closed posture - do not weaken it.
- Label allocation per the accepted default: first registration of a name
  gets `<name>`; if that label was ever issued before, walk `-g2`, `-g3`, ...
  until an unissued label is found. The ledger is the single source of truth.
- Collision both directions: a REGISTRATION whose name equals a previously
  issued label is refused with a clear error (otherwise a future generation
  of another app could collide with it, or vice versa). Decide the exact
  error code with the reviewer; match the AppErrorCode -> HTTP table pattern.
- Name cap on NEW registrations drops to 59 chars so `<name>-g<N>` fits in a
  63-char DNS label. Existing names grandfathered: boot migration must accept
  them.
- Boot migration: a label-less apps.json (every install out there) gets gen-1
  labels stamped (`hostLabel = name`, `hostGen = 1`, ledger seeded). Must be
  idempotent and must not touch systemd.
- Delete keeps its current shape (archive-aside, frees name + port) - the
  ledger is what changes: the label stays issued forever.
- The reserved-name list already guards registration; check it still makes
  sense as the label namespace (www, api, ...) and extend with the reviewer
  if a hostname-specific entry is missing.
- Tests: allocation walk incl. the collision refusals; ledger survives
  reload; migration of a label-less file; delete -> re-register yields a
  different label; 59-char boundary incl. suffix fit; mutation-check and say
  so in the report.

Acceptance: isolated-instance curl demo transcript (register -> record shows
hostLabel/hostGen -> delete -> re-register same name -> DIFFERENT label,
ledger on disk shows both); always-run gates green (test:systemd only if
supervisor files are touched - they should not be); reviewer approve on the
final announced fingerprint; all new prose verbatim in the report.

Decide with reviewer: ledger representation details, error code naming,
migration mechanics.

Locked: label shape default (manager-accepted, reversible until S7), the
registry's fail-closed posture, everything in Standing rails.
