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

- [x] S1  Hostname ledger + label allocation (registry only, dark).
         (Isomuxer1/Reviewer1, plan-gate 7 adjustments, diff-gate approved
         3cb361eb first round, committed with this edit. apps.json is now an
         envelope {apps, issuedLabels} - one file so a crash cannot separate
         a live app from its ledger row; legacy array files migrate LAZILY
         on read, no write on the read path. 11 mutations, all killed.
         Product-visible notes for Nil's pass: origin_retired permanently
         bans one exact string as a future NAME (clean error over silent
         -g2-g2 walk); grandfathered 60-63 char names cannot re-register
         after delete; a 59-char name exhausts generations at g100.)
- [x] S2  Office cookie `__Host-` hardening (independent; before S5).
         (Isomuxer2/Reviewer2, plan-gate 2 rounds, diff-gate approved
         d4f52f15 round 2, committed with this edit. Two-step migration:
         re-issue under __Host- first, clear legacy only after the new
         cookie is SEEN coming back - nothing cleared before its
         replacement is observed. HTTPS signal: buildPublicOrigin().isHttps,
         never a request header. Round-1 blocker: logout must clear BOTH
         names on EVERY deployment (browsers hold cookies from the office's
         past arms). 14 mutations killed. Inert on this office (no https
         publicOrigin). Parked: recover_owner_session's Secure-cookie-to-
         127.0.0.1 curl dependency predates the slice - queued for Nil.)
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

## SLICE-2 PICKUP (authored after S1's commit; baseline = that commit)

What S1 taught (real, from its report): apps.json is an envelope
{apps, issuedLabels}; ledger rows are {label, name, gen, issuedAt} and the
registry's invariants match live apps against the exact issuance TUPLE, not
the label. New AppErrorCodes origin_retired and no_label_available (both
409). A NUL byte in any source file breaks grep/ripgrep and trips
source-hygiene.test.ts - pick separators that are printable or use
JSON.stringify keys.

Goal: the office session cookie gets the `__Host-` prefix wherever the
deployment can carry it, WITHOUT logging anyone out anywhere. This closes
the cookie-shadowing hole (an app page on a subdomain setting a
`Domain=<office>` cookie that shadows the office session) BEFORE any app is
reachable; port-proxy-design.md:276 filed it as eventual cleanup, S5 makes
it load-bearing.

Load-bearing mechanics and traps:
- `server/auth.ts:1587` COOKIE_NAME ("isomux_session") and every read/write
  path in auth.ts + auth-middleware.ts. Grep for other cookie touchpoints
  (login flow, logout, WS upgrade auth) before planning - the plan-gate
  should list every site that reads or writes the cookie.
- `__Host-` rules (browser-enforced): requires Secure, no Domain attribute,
  Path=/. So the new name is only WRITABLE on HTTPS deployments.
- HOW THE SERVER KNOWS IT IS HTTPS: the office server sits on loopback
  behind a terminator (Caddy, tailscale serve), so the request itself is
  plain HTTP. Decide the signal with the reviewer (publicOrigin scheme is
  the honest deployment-level signal; do NOT trust a client-supplied
  X-Forwarded-Proto without establishing why it is trustworthy here).
  State the chosen signal and its failure mode in the report.
- DUAL-READ, one release: accept BOTH cookie names on every auth path
  (HTTP + WS). Writes use the new name on HTTPS, the legacy name otherwise.
  An existing session under the legacy name keeps working; decide with the
  reviewer whether/when it is re-issued under the new name (e.g. on next
  successful auth touch) and whether the legacy cookie is then cleared.
  Logout clears BOTH names.
- SHADOWING TEST: the point of the slice - prove that when both a
  `__Host-isomux_session` and a Domain-set `isomux_session` arrive, the
  `__Host-` one wins on HTTPS deployments, and a bogus injected legacy
  cookie cannot displace an authenticated `__Host-` session.
- Loopback-HTTP installs (dev, plain localhost): behavior byte-identical to
  today. Feature-inert there, like everything in this loop.
- This is Nil's own login path (flagged in PARKED FOR NIL): dual-read is
  the no-logout guarantee - test it hard. Fail toward "existing sessions
  keep working"; fail-closed only against cookies that violate the rules.
- Tests: cookie-attribute pins for both arms; dual-read acceptance matrix
  (HTTP + WS upgrade); shadowing; logout clears both; mutation-check and
  say so.

Acceptance: isolated-instance demo transcript for BOTH arms (an HTTPS-shaped
instance - publicOrigin https - sets and accepts `__Host-isomux_session`;
a plain-HTTP instance is byte-identical to today); the shadowing proof;
always-run gates green (test:systemd not expected - no supervisor files);
reviewer approve on the final announced fingerprint; all new prose (there
should be none user-visible) confirmed absent or quoted.

Decide with reviewer: HTTPS signal, re-issue timing, legacy-cookie clearing.

Locked: no logout of existing sessions anywhere, dual-read for at least one
release, everything in Standing rails.

## SLICE-3 PICKUP (authored after S2's commit; baseline = that commit)

What S1/S2 taught (real, from their reports): the registry's ledger is the
label authority (issuedLabels tuples; live apps carry hostLabel/hostGen).
The deployment-arm signal is `buildPublicOrigin().isHttps` - operator-
authored, boot-frozen, NEVER a request header (X-Forwarded-Proto is
client-settable because the office socket is directly reachable). Bun trap:
multi-value Set-Cookie on `server.upgrade()` must go through
Headers.append - an array in a plain headers object is silently dropped.

Goal: the office learns to tell request hosts apart. A request whose Host
is `<label>.<apps domain>` routes to a new app-host arm (which serves only
fail-closed placeholders this slice - no app bytes, no auth yet); every
other request behaves byte-identically to today. Dark: with no apps domain
resolvable the feature cannot be reached.

Load-bearing mechanics and traps:
- New `server/app-hosts.ts`: host normalization (lowercase, strip one
  trailing dot, strip :port, punycode/IDN - decide the honest scope with
  the reviewer and TEST the weird forms) + label lookup against the
  registry (live label -> the app; issued-but-retired or unknown -> both
  the SAME neutral 404, externally indistinguishable).
- Dispatch: the Host check runs AHEAD of pathname dispatch in the
  isomux-office.ts fetch handler (~4200). THE REGRESSION SURFACE IS EVERY
  EXISTING ROUTE: only a Host that positively matches `<label>.<apps
  domain>` diverts; the office host, bare IPs, localhost, tailnet names,
  garbage Hosts - all fall through to today's path untouched. Pin that
  with tests (office dispatch with apps domain configured, weird Hosts).
- Apps domain resolution: `apps.<office host>` derived from publicOrigin,
  overridable by an explicit office-config key (installer-written later;
  name it with the reviewer). Loopback/no-publicOrigin -> no apps domain ->
  arm unreachable. Boot-frozen like isHttps.
- `/__isomux/*` is RESERVED on app hosts from day one (S4 mounts auth
  there). On the app-host arm this slice, every path including those
  returns the fail-closed placeholder responses - but the reservation must
  be structural (the app relay, when it exists, never sees /__isomux/*).
- WS upgrades on an app host: refuse this slice (S6's job) - but refuse
  DELIBERATELY, not by falling through to the office WS handler. A
  diverted host must never reach office handlers.
- Live label placeholder: decide the exact response with the reviewer
  (neutral 503-ish "not ready" vs same 404) - constraints: no app bytes,
  no office HTML, no session material, no redirect to the office, nothing
  that distinguishes an authenticated caller (auth is S4). State the
  choice + why in the report.
- The apps-domain suffix itself and non-label subdomains
  (`a.b.apps.<office>`, bare `apps.<office>`) -> neutral 404.
- Tests: normalization matrix; dispatch fall-through pins; label hit /
  retired / unknown; reserved path; WS refusal; inert-without-config;
  mutation-check and say so.

Acceptance: isolated-instance demo transcript driven with `curl -H "Host:
..."` against loopback: office host unchanged, app label hits the arm,
retired and unknown labels indistinguishable, bare apps domain 404,
office-behavior regression demo (a normal route works identically with the
feature configured); always-run gates green; reviewer approve on the final
announced fingerprint; any new user-visible strings (the placeholder
bodies!) quoted verbatim.

Decide with reviewer: config key name, normalization scope, placeholder
response shape, internal structure of the app-host arm.

Locked: fail-closed posture (doubt -> neutral 404), no office handler
reachable from a diverted host, boot-frozen config, Standing rails.
