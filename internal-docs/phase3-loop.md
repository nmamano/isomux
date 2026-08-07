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
- URL shape is FLAT (Nil, 2026-08-06 evening): apps live at
  `<label>.<office host>` - no `apps.` tier. Shorter wins; the reserved-name
  list guards the office's own namespace. Known accepted consequence: an
  apex-hosted office's wildcard record covers its whole domain.
- WS relay caps (Nil, 2026-08-07): total concurrent relayed sockets 64
  office-wide, 32 per app. Both plain named constants, own pool separate
  from S5's HTTP permits.

## Manager-accepted defaults (reversible unless marked)

1. Label shape: first registration of a name gets `<name>`, later ones get
   `<name>-g<N>`. Reversible only until S7 lands on a real domain.
2. Ledger: `issuedLabels[]` in apps.json, never pruned, inside the backup set.
3. (Settled by Nil, 2026-08-06 evening, after two manager amendments both
   overridden - FINAL.) Flat shape, PURE DERIVATION, no config: the parent
   domain IS the office host from `publicOrigin` whenever it is https; no
   appsDomain key, no installer-written state, no override knob. Arm inert
   when publicOrigin is absent or plain-http. The exact canonical office
   host is the ONLY structural fall-through; every other single-label host
   under it is the app arm; no reserved-label fall-through. Known accepted
   consequence (Nil's explicit call - "cleanest, not the most backward
   compatible"): an operator who aliased another subdomain at their office
   box gets neutral 404s there after updating; S10 documents it in one
   sentence. History for the record: Isomuxer1 found the alias breakage,
   manager ruled opt-in key + reserved fall-through, Reviewer1 killed the
   fall-through, Nil killed the key.
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

After sending ANY gate request (plan or diff), END YOUR TURN and wait
idle - replies queue behind an active turn, so working on is how you
miss a CHANGES-REQUIRED verdict. Silence is never approval. (Lesson
from S7: a worker coded past a queued plan verdict.)

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
- MEMORY SANDBOX (mandatory after the 2026-08-06 incident): any test run
  during a mutation cycle that touches resource-bound code (caps, ceilings,
  backpressure, buffers, limits) runs inside
  `systemd-run --user --scope -p MemoryMax=2G --quiet bun test <files>` -
  a mutation that removes a cap turns the test into an unbounded
  allocator, and the sandbox makes it fail fast instead of taking the box
  down (five earlyoom kill waves came from one disabled ceiling + a flood
  test). If unsure whether code is resource-bound, sandbox it.
- A mutation cycle must restore the pristine file BEFORE running anything
  else, and restoration must be verified (diff against the pristine copy)
  as the FIRST action after any interruption - an interrupted cycle leaves
  the mutation live on disk.

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
- Nothing outward-facing turns on by default: without an https publicOrigin
  the app-host arm is inert, and nothing is reachable from outside until the
  operator adds DNS + the Caddy site block (S7).
- No new dependencies without queueing for Nil.
- Scope fence: policy or API-surface choices not covered by the design docs,
  the accepted defaults above, or this file go to the manager, not into code.

## Decision protocol

- Worker + reviewer settle: implementation details, exact validation rules,
  state-file shape, test strategy.
- Manager settles: slice scope calls, naming, anything worker+reviewer
  deadlock on.
- PARKED FOR NIL (end-of-batch, never decided in-loop):
  - ~~URL shape~~ ANSWERED (Nil, 2026-08-06 evening): flat `hello.<office>`.
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
- [x] S3  Host matching, pure-derivation shape (dark without https origin).
         (Isomuxer1/Reviewer1, 3 mid-flight ruling changes absorbed, diff-
         gate approved ac34bb4d round 2, committed with this edit. Host
         classified before URL parse/auth/ws; strict single-label child of
         the office host diverts and can NEVER reach office handlers;
         office host itself protected structurally (suffix can't equal the
         whole). Round-1 P1s: pre-boot appHostDomain() read would have
         silently disabled the feature - now throws; office-Host tests
         didn't send the office Host; placeholder assertions were
         contains-weak. 13 mutations killed incl. U+212A Kelvin-sign
         case-fold attack on labels. PARKED, pre-existing: malformed Host
         (space) -> uncaught TypeError at new URL() -> connection reset;
         predates this slice, queued for Nil as a task candidate.)
- [x] S4  Auth handshake (single-use code, app cookie; no app bytes yet).
         (Isomuxer2/Reviewer2, 3 rounds total, approved cfb86d89, committed
         with this edit. Callback carries the CODE ONLY - return path is
         server-side state per port-proxy-design.md:203, overriding the
         pickup's &r=. No persisted state: codes + app sessions in memory,
         restart costs one invisible redirect. Bounce predicate final: GET
         AND ([navigate+document] OR zero Sec-Fetch headers); HEAD out.
         Round-1 finds: mint response skipped S2's cookie migration
         (shadowable-cookie window S2 exists to close); present-but-empty
         app cookie never cleared. S5 MUST strip __Host-isomux_app before
         forwarding - nothing in S4 enforces it. Accepted consequences for
         Nil's list: GET /auth/app CSRF shape (bounded, SSO-standard);
         codes visible ~45s in the terminator's access log; headerless
         clients bounce (keeps old browsers able to sign in). Manager
         edited one stale test describe label post-approval.)
- [x] S5  HTTP relay (first slice where a real app answers).
         (Isomuxer1/Reviewer1, diff-gate approved bae2fc55 round 2,
         committed with this edit. Cookie strip WIDENED beyond the design
         text with reviewer endorsement: all three isomux credentials
         (__Host-isomux_app, __Host-isomux_session, isomux_session) are
         stripped, exact case-sensitive names only. Prove-active-before-
         connect demonstrated against a literal port squatter. Content-
         Encoding rewrite mirrors Bun's MEASURED decoder set, not the RFC -
         the RFC form corrupts bytes; a canary test fails loudly if a Bun
         upgrade widens the decoder. 27 mutations killed (4 first-pass
         survivors were weak tests, rewritten). Constants: TTFB 30s, stall
         5m, 128/app, 512 total; request size rides the listener's 512MB.
         For Nil's list: apps cannot see the visitor IP (XFF = terminator
         peer; real fix needs an authenticated Caddy boundary, not now).)
- [x] S6a WebSocket upstream: frame codec + in-house WS client over a raw
         TCP socket, pure, wired into nothing. Split from S6 after a
         measured finding (Bun's WS client buffers browser->app
         unboundedly); Nil cut WS then reinstated it on the parity
         principle ("no artificial restriction a non-managed app wouldn't
         have"). (Isomuxer2/Reviewer2, diff-gate approved d43a3da4 round
         5, committed with this edit. 4 new files, nothing existing
         modified, imported by nothing. 100 tests / 620 assertions;
         34 mutations, 32 killed, 2 documented equivalents. Stated
         per-connection memory bound ~3.5MB + one Bun read. Post-incident
         hardening: test fill loops are byte-budgeted and THROW if the
         queue never refuses - a broken ceiling fails in ms; carry this
         pattern to any future resource-bound tests. The cap question is
         ANSWERED - see Rulings and the SLICE-6B pickup.)
- [x] S6b WebSocket relay: wiring S6a into the app-host arm, office
         plumbing, lifecycle/auth per the SLICE-6 pickup (BACK in force)
         as amended by the SLICE-6B pickup.
         (Isomuxer2/Reviewer2, diff-gate approved 1e79adbd, committed
         5bcdcbe. server/app-ws-relay.ts owns the WS surface; check
         order reserved -> auth -> origin -> prove-active -> permit ->
         dial -> subprotocol -> upgrade, everything refusable BEFORE the
         101. Caps 64/32 own pool keyed by issuance. WsData is now a
         discriminated union in isomux-office.ts; the upgrade thunk must
         carry response headers or Bun silently replaces the app's
         subprotocol selection with its own guess. Measured: Bun's
         server accepts peer close codes only in 1000-1011 + 4000-4999
         (1013 arrives as 1006), and cannot emit a status-less close.
         Subprotocol refusal per manager ruling, verified against WHATWG
         2.2 by BOTH lane agents. NOT_READY_BODY deleted - the app-host
         surface has no placeholder left. Session/app revocation cuts
         live sockets within 30s (timer, not per-message). 43 mutations,
         39 killed, 4 chased to redundant-pair explanations. Full test
         baseline now 3271 pass / 173 files. Product-visible notes
         queued for Nil's pass in the manager's report.)
         Loop order: S6a -> S6b -> S8 -> S9 -> S7 -> S10.
- [ ] S7  Caddy + DNS (GATED ON NIL: domain + URL-shape answer; only slice
         needing a real box; installer site block + tls-ask; update path
         deliberately does NOT rewrite the Caddyfile - enabling app
         hostnames stays an explicit operator step, documented).
- [x] S8  ISOMUX_APP_URL injection (renderUnit + reconcile pass; absent when
         no domain configured).
         (Isomuxer1/Reviewer1, diff-gate approved b8411222 FIRST ROUND,
         no findings, committed dcf0eac. New pure leaf server/
         app-domain.ts holds the hostname grammar + appPublicUrl -
         moved out of app-hosts.ts to break the supervisor import
         cycle. UnitRenderOpts.appUrl is REQUIRED (present-iff, never
         empty); reconcile compares only the URL assignment, not the
         whole unit, so future template edits don't bounce every app;
         advisory at boot, wired after token reconcile. test:systemd
         proves the full domain transition on real systemd incl.
         restart-exactly-once by MainPID. Mutation lesson: nothing
         exercised label != name until two mutations survived - a
         hello-g2 test pair now pins hostLabel-not-name at both the
         unit and the wire. No user-visible prose. Full test baseline
         3308 / 176 files.)
- [x] S9  UI: link the hostname when present; keep port link otherwise.
         (Isomuxer2/Reviewer2, diff-gate approved 2f9e452e FIRST ROUND,
         committed ca7c29f. Exported pure helper appHref(app,
         officeHostname): url verbatim when non-empty, port link
         otherwise; call site not unit-testable (no React harness) -
         the browser run was the only cover, KNOWN GAP if that line is
         ever touched. Demo fixture standup-board now carries a url so
         the public demo renders both arms - Reviewer2 ruled it stays;
         flagged for Nil (demo shows a hostname link before S7). No
         new user-visible strings. Baseline 3311 / 176 files.)
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

## SLICE-4 PICKUP (authored after S3's commit; baseline = that commit)

What S3 taught (real, from its report): `server/app-hosts.ts` classifies
the Host before URL parse, auth, and /ws; its arm has commented seams -
`/__isomux/*` is structurally reserved for THIS slice, the WS branch is a
deliberate refusal (S6's seam), and the live-label placeholder ("this app
is not reachable yet\n") is what S4/S5 progressively replace. The derived
domain is boot-frozen; appHostDomain() before freeze THROWS. Host
normalization already handles case (incl. the U+212A Kelvin trap), ports,
trailing dots; a malformed Host (embedded space) still hits a PRE-EXISTING
uncaught TypeError upstream - do not fix it, do not regress it, it is
queued for Nil. Bun trap from S2 still applies: multi-value Set-Cookie
needs Headers.append.

Goal: the auth handshake from port-proxy-design.md, ending at an
authenticated placeholder page on the app host. After this slice: an
office user who hits `https://<label>.<office>/...` with no app cookie is
bounced through the office, comes back with a single-use code, and lands
authenticated (placeholder body - relay is S5); everyone else gets
fail-closed refusals. No app bytes move.

Load-bearing mechanics and traps:
- New `server/app-auth.ts`: single-use code store (in-memory; codes are
  30-60s, one redemption, bound to app id + generation + user session +
  exact target host). Mint and redeem rate limits as plain named constants.
- Office-origin route `/auth/app?app=<label>&r=<path>`: requires a live
  office session (no session -> the existing office login flow -> back to
  the requested app path after login - reuse the office's existing
  login-return machinery if it exists; decide shape with reviewer). Mints
  the code, 302 to `https://<label>.<office>/__isomux/auth?code=...&r=...`.
- App-host route `/__isomux/auth` (mounting into S3's reserved seam):
  validates code (single-use, TTL, binding), sets the app cookie, 302 to
  `r`.
- App cookie `__Host-isomux_app` per the design doc: Secure, HttpOnly,
  SameSite=Lax, Path=/, bound to app id + GENERATION + user session. It
  must die with: app delete, name re-registration (generation bump - the
  cookie of gen N never authenticates gen N+1), and office session
  logout/revocation (decide the liveness-check mechanism with reviewer;
  fail-closed if the session cannot be verified).
- `r` is a PATH, never a URL: reject `//evil`, backslashes, control chars,
  anything not starting with a single `/`; it must never appear reflected
  in a response body and the code must never appear in a Referer
  (Referrer-Policy: no-referrer on every response that carries either;
  Cache-Control: no-store).
- Access ruling (accepted default #4): ANY signed-in office user may open
  any app. No per-app ACL this loop.
- The unauthenticated placeholder on a live label changes from S3's 503-ish
  body to the redirect flow; the NOT-live cases stay byte-identical to S3
  (neutral 404s - pin that nothing about auth leaks which labels exist...
  beyond what the redirect itself necessarily reveals for live ones).
- Tests: full handshake happy path through the REAL server (harness, fake
  supervisor); code single-use/expiry/wrong-host/wrong-session/wrong-gen
  matrix; r-validation matrix; cookie attribute pins; death-on-delete,
  death-on-regeneration, death-on-logout; rate-limit behavior; S3
  regression suite untouched and green; mutation-check and say so.

Acceptance: isolated-instance demo transcript (curl with a real office
session cookie: app host -> 302 office -> mint -> 302 back -> Set-Cookie ->
authenticated placeholder; then the same code again -> refused; logout ->
app cookie dead); always-run gates green; reviewer approve on the final
announced fingerprint; ALL new user-visible strings (placeholder body,
any error bodies) verbatim in the report.

Decide with reviewer: login-return shape, session-liveness mechanism, code
storage internals, exact placeholder wording (flagged for Nil's pass).

Locked: access = any signed-in office user; cookie binding incl.
generation; r is a path; fail-closed everywhere; Standing rails.

## SLICE-5 PICKUP (authored after S4's commit; baseline = that commit)

What S4 taught (real, from its report): `server/app-auth.ts` owns the
handshake and per-request app-session validation; `server/
app-host-responses.ts` owns every body/response the app-host surface emits
- add relay errors THERE, not inline. The arm's authenticated branch ends
at the placeholder line - that line is what S5 replaces with the relay.
Codes/app sessions are in-memory by design. The office's cookie migration
wraps mint responses (GET only). Login has no return-path plumbing; a
fresh visitor clicks the app twice - accepted.

Goal: an authenticated request on an app host gets the app's actual bytes.
`server/app-proxy.ts`: relay to `127.0.0.1:<port>`, streamed both ways.
After this slice a registered app is genuinely usable through its hostname
(minus WebSockets, S6) on a box with DNS+Caddy (S7).

Load-bearing mechanics and traps:
- SECURITY HANDOFF FROM S4 (load-bearing, their words): strip
  `__Host-isomux_app` from the forwarded Cookie header. The app must never
  see the credential that admits to it. The app's own cookies pass through
  untouched, both directions.
- Refuse before connecting: unit not active (supervisor seam, cached state
  ok) -> 503, NO connection attempt - a stopped app's port can be squatted
  by any local process. Named body in app-host-responses.ts.
- Header hygiene: hop-by-hop headers stripped per RFC 7230 (Connection and
  everything it names, Keep-Alive, TE, Transfer-Encoding, Upgrade,
  Proxy-*); relay SETS Host (the app-host value), X-Forwarded-Proto
  (https), X-Forwarded-For (peer address), X-Forwarded-Host - never
  passing through client-supplied values for headers the relay owns.
- Redirects: `redirect: "manual"` - 3xx from the app passes to the browser
  untouched, never followed by the relay.
- Streaming: request and response bodies stream (uploads and SSE both
  work); client abort cancels the upstream fetch (AbortController wired to
  the request signal); backpressure via the streams, no buffering of
  bodies. Response TTFB timeout + an idle/stall guard as plain named
  constants - do NOT cap total duration (SSE lives long by design) -
  decide exact values with reviewer.
- Caps as plain named constants: concurrent relayed requests per app (with
  a shared-total sanity bound), request body size consistent with the
  office's own maxRequestBodySize story. 429/503 with named bodies.
- Connection errors (refused, reset mid-stream): a named 502 body; if
  bytes already streamed, terminate the stream honestly (no way to
  retroactively 502 - state this in a comment).
- The app answers plain HTTP on loopback; it may set its own cookies -
  pass Set-Cookie through untouched (its `__Host-` cookies are its
  problem; the browser scopes them to the app host, which is the design).
- WS refusal from S3/S4 stays exactly where it is (S6's seam).
- Tests: byte-exact passthrough (binary bodies both directions), streaming
  (chunked/SSE with client abort killing upstream - observe via a test
  server that records), cookie strip in, Set-Cookie out, header hygiene
  matrix, 3xx not followed, stopped-app 503 with zero connection attempts
  (assert via listener that must NOT be hit), caps, 502 shapes. Real HTTP
  through the harness with a real scratch upstream server on a loopback
  port (NOT a registered app's production port range - keep the fake
  supervisor authoritative about state). Mutation-check and say so.

Acceptance: isolated-instance demo transcript: register a real tiny app,
authenticate per S4's flow, then through the app HOST: GET the app's page
byte-exact, POST a body and get it echoed, an SSE stream ticking, client
abort observed upstream, app's Set-Cookie landing in the jar and NOT the
app-session cookie in the app's request log, stop the app -> 503 without
connection, delete -> S3's 404. Always-run gates green; test:systemd only
if supervisor files touched; reviewer approve on final announced
fingerprint; all new user-visible strings verbatim.

Decide with reviewer: timeout/stall constants, cap values, 502/503/429
wording (flagged for Nil's pass), internal structure.

Locked: cookie strip (S4 handoff), no-connect-when-inactive, manual
redirects, streaming with abort propagation, Standing rails.

## SLICE-6 PICKUP (authored after S5's commit; baseline = that commit)

What S5 taught (real, from its report): `server/app-proxy.ts` owns the
relay; `handleAppHostRequest` is deliberately NOT async (office path stays
synchronous; only the diverted path returns a promise). The WS refusal in
app-hosts.ts is the LAST placeholder seam - its body "this app is not
reachable yet\n" exists only there now. Relay order is prove-active ->
permit -> connect; concurrency is keyed by issuance (hostLabel#hostGen),
never the reusable name. The relay strips ALL THREE isomux credential
cookies (exact names) - the app never sees what admits to it. Bun 1.3.11
measured behaviors matter: fetch decodes only exact lowercase gzip/
deflate/br/zstd; multi-value headers need append; RelayContext carries
test-only override seams.

Goal: WebSocket apps work through the app host. The refusal seam becomes
a real bidirectional frame relay: authenticated upgrade on
`wss://<label>.<office>/...` connects to `ws://127.0.0.1:<port>/...` and
frames flow both ways until either side closes.

Load-bearing mechanics and traps:
- AUTH BEFORE UPGRADE: the app-session check (S4's per-request
  validation, incl. generation binding and office-session liveness) runs
  before `server.upgrade`. No session -> the neutral refusal (an upgrade
  cannot bounce through a login redirect; a browser app's page loads
  first via S5, so the session exists in practice - state this honestly
  in a comment).
- ORIGIN CHECK, decide exact policy with reviewer and state it: a
  browser upgrade carries Origin - require it to be exactly
  `https://<app host>` when present; decide absent-Origin handling
  fail-closed vs non-browser-client parity with S4's metadata-less arm,
  and SAY WHICH in the report. The office /ws Origin logic is precedent
  (isomux-office.ts) but its answer need not be the same.
- Cookie strip on the upgrade request: same three exact names as S5, same
  helper - do not reimplement it.
- Prove-active-before-connect applies to the upstream WS dial exactly
  like S5's fetch (squattable port, same argument, same 503-equivalent
  refusal pre-upgrade).
- Frame relay: text/binary passthrough without inspection; close-code AND
  reason propagate BOTH directions (including abnormal closes mapping
  honestly - decide the 1006-ish mapping with reviewer); ping/pong -
  decide who answers pings (Bun auto-pong?) by MEASURING, not assuming,
  and pin the measured behavior.
- Backpressure: a slow browser must not balloon memory when the app
  floods (and vice versa). Measure what Bun's ws send() returns
  (backpressure signal) and wire it; decide a bounded-buffer policy with
  the reviewer, plain named constants.
- Lifecycle accounting: WS connections are long-lived - decide with
  reviewer whether they share S5's permit pool or get their own cap
  (lean: own cap, named constant); either way a dropped/closed socket
  MUST release exactly once (S5's release-on-cancel lessons apply).
- App deleted / name re-registered / office session revoked MID-CONNECTION:
  decide honest behavior (immediate close on next validation opportunity
  vs ride-until-close) with reviewer, state it, test what is testable.
- The office's own /ws stays byte-identical and unreachable from app
  hosts (S3 pin stays green).
- Upstream dial failure after upgrade already accepted: close with a
  sensible code/reason - the HTTP-shaped refusal is impossible post-101.
  Decide the code with reviewer.
- Tests: echo both ways (text + binary), close propagation matrix, Origin
  matrix, unauthenticated refusal, stopped-app refusal pre-upgrade,
  strip-on-upgrade, office /ws regression, both-sides-flood sanity,
  release-exactly-once; mutation-check and say so. Real WS end-to-end in
  the harness with a scratch WS app.

Acceptance: isolated-instance demo transcript: register a real WS echo
app, sign in per S4, wss:// echo through the app host (binary too), app's
close code arrives at the client, client's close arrives at the app, stop
the app -> refusal pre-upgrade, squatter untouched; office /ws still
works. Always-run gates green; reviewer approve on final announced
fingerprint; all new user-visible strings verbatim; locked constraints
quoted back in the report.

Decide with reviewer: Origin policy details, close-code mappings, buffer
policy + cap constants, permit-pool question.

Locked: auth before upgrade, the three-cookie strip via S5's helper,
prove-active before the upstream dial, office /ws untouched, Standing
rails.

## SLICE-6B PICKUP (authored after S6a's commit; baseline = cc00e1b)

The SLICE-6 PICKUP above is BACK IN FORCE - it is your spec. This section
adds what S6a settled, what Nil ruled, and what changed since it was
written. Where they disagree, this section wins.

What S6a built (real, from its report): a pure, dependency-free WS
upstream stack - `server/ws-frames.ts` (frame codec) +
`server/app-ws-upstream.ts` (in-house client over a raw TCP socket),
plus their test files. Imported by NOTHING yet; wiring it in is this
slice. It exists because Bun's own WS client buffers browser->app
unboundedly (measured); the in-house client has a bounded send queue
that REFUSES when full, stated per-connection memory bound ~3.5MB + one
Bun read. Do not re-measure Bun's client - that question is closed.
Bun's SERVER-side ws (`server.upgrade`) is still what faces the browser;
its `send()` backpressure return values are still yours to measure and
wire, per the SLICE-6 pickup.

RULED BY NIL (2026-08-07, final - also in Rulings): total concurrent
relayed sockets 64 office-wide, 32 per app. Plain named constants, own
pool separate from S5's HTTP permits. This settles SLICE-6's
"permit-pool question" and cap constants - do not relitigate values.

Carry-forwards the S6a report flags for you:
- Reuse S5's helpers, do not reimplement: the three-cookie strip (exact
  names) on the upgrade request, and prove-active-before-connect ahead
  of the upstream dial (squattable port).
- Auth before upgrade (S4's per-request validation incl. generation
  binding and office-session liveness) - locked in the SLICE-6 pickup.
- S6b owns every refusal body the WS surface emits - put them in
  app-host-responses.ts like S5 did, and quote ALL of them verbatim in
  the report for Nil's pass.
- Close-code/reason propagation was where S6a's review drew blood (5
  diff-gate rounds) - expect the same scrutiny on the relay side: both
  directions, abnormal-close mapping stated, post-101 upstream-dial
  failure code decided with the reviewer.
- Resource-bound code: the memory-sandbox gate applies to your mutation
  runs, and any fill-loop test must follow S6a's byte-budgeted
  throw-if-never-refused pattern.

Acceptance: as the SLICE-6 pickup states (real WS echo app end-to-end,
close propagation both ways, refusals, office /ws untouched), plus: cap
behavior demonstrated (65th office-wide socket and 33rd per-app socket
refused, release-exactly-once proven so caps do not leak).

Decide with reviewer: Origin policy details, close-code mappings,
buffer policy wiring, mid-connection revocation behavior.

Locked: everything the SLICE-6 pickup locks, plus the ruled cap values.

## SLICE-8 PICKUP (baseline = 5bcdcbe, after S6b; originally authored
after the S6 cut - the SLICE-6 PICKUP was voided then reinstated, see
SLICE-6B. S6b addendum: full-test baseline is 3271 pass / 173 files;
the app-host surface now has NO placeholder bodies, so do not grep for
"not reachable yet" expectations in tests you touch)

What the relay slices left for you: an app's public URL is
`https://<hostLabel>.<office host>` exactly when `buildPublicOrigin().
isHttps` (S3's derivation, boot-frozen); hostLabel/hostGen live on
AppRecord (S1). `renderUnit` (server/app-supervisor.ts:386) writes the
unit env; `server/app-token-reconcile.ts` is the boot-reconcile precedent
(self-heals token/unit pairs, restarts at most once, idempotent).

Goal: apps learn their own address. `ISOMUX_APP_URL` is present in the
app's environment exactly when a public URL exists, and the API tells the
UI the same URL (S9 consumes it).

Load-bearing mechanics and traps:
- `renderUnit` gains ISOMUX_APP_URL when the derived domain exists;
  ABSENT (not empty, not wrong) when it does not - an app must be able to
  test `if (process.env.ISOMUX_APP_URL)`.
- The URL uses hostLabel, NOT name (a -g2 generation's URL differs from
  its name - that is the whole point of the ledger).
- Boot reconcile modeled on app-token-reconcile: if the unit on disk
  disagrees with what renderUnit would write NOW (domain appeared,
  changed with publicOrigin, or vanished), re-render + daemon-reload +
  restart THE RUNNING apps at most once each; stopped apps get the new
  file and stay stopped; failed stay failed (S2b's least-surprise rule).
  Idempotent: a second boot with no change restarts nothing - pin that.
- `AppWire` gains `url?: string` (same present-iff rule). Fixture files
  will need the field - S1's report says 8 of them carry AppRecord/
  AppWire literals; expect similar.
- No new persisted state: the URL is DERIVED, never written to apps.json.
- This slice touches supervisor files: `bun run test:systemd` REQUIRED.
- Tests: unit-render matrix (domain present/absent/changed x running/
  stopped/failed), reconcile idempotence, restart-at-most-once, URL uses
  hostLabel, wire field presence rule; golden unit files; mutation-check
  and say so.

Acceptance: isolated-instance demo transcript: register app on a plain
office -> env has no ISOMUX_APP_URL; enable https origin, reboot instance
-> unit re-rendered, app restarted once, env carries the URL, GET
/api/apps shows the same url; second reboot -> no restarts (idempotence
proven from the supervisor call log or unit mtimes); stopped app across
the same transition stays stopped with the new file. Always-run gates +
test:systemd green; reviewer approve on final announced fingerprint; any
new strings verbatim (expect none user-visible).

Decide with reviewer: reconcile structure (extend the token reconcile vs
sibling pass), detection mechanism (compare rendered bytes vs stored
domain marker), test seam details.

Locked: present-iff-URL-exists env semantics, hostLabel not name, derived
never persisted, restart-at-most-once + run-state preservation, Standing
rails.

## SLICE-9 PICKUP (authored after S8's commit; baseline = dcf0eac)

What S8 taught (real, from its report): `AppWire.url?: string` now
carries `https://<hostLabel>.<domain>` on the wire, PRESENT IFF a
public URL exists (https publicOrigin + derived domain) - the UI never
computes an app URL itself, it consumes this field. server/app-domain.ts
is the grammar authority; the supervisor injects the same URL as
ISOMUX_APP_URL.

Goal: the Apps tab links an app's hostname when it has one, and keeps
today's port link otherwise. Small, UI-only, dark on every office
without an apps domain (auntie included - verify via fixtures, not the
live office).

Load-bearing mechanics and traps:
- `ui/components/AppsView.tsx:386`: the link is
  `http://${window.location.hostname}:${app.port}/` with a comment
  block (~381) explaining the pre-hostname story - update that comment;
  it is the exact thing this slice obsoletes when url is present.
- When `app.url` exists: link it (it is already the full https origin).
  When absent: today's port link, byte-identical behavior. Decide with
  the reviewer what the visible link TEXT shows in each arm and whether
  the port Meta row (~430) changes - flag any new user-visible string
  for Nil's pass (expect one or two at most; the room's copy rules
  apply: short, no overexplaining).
- The office UI reaches the server through the SAME origin scheme
  either way; app.url is absolute and self-contained - do not derive
  anything from window.location for the url arm.
- Mobile: whatever is rendered must not depend on glyphs iOS
  auto-emojis (room lesson); plain text/existing patterns only.
- No new endpoint, but demo fixtures: the demo bundle's fixture apps
  (demoApi) need at least one app WITH url and one WITHOUT so both arms
  render - the repo has NO DOM test harness; visual verification runs
  through the demo-bundle recipe in room memory (build to /tmp, serve
  over http not file://, headless Chrome via playwright-core
  channel:"chrome"). Delete any harness files before the freeze.
- ui changes: `bun run build:ui` gate is the load-bearing one;
  eslint + bun test as always (unit-test exported helpers if you add
  any logic worth testing; a pure href-chooser function is the
  testable shape).
- Screenshots of both arms (with-url and without-url) go in the report
  so Nil can see the rendering without running anything.

Acceptance: demo-bundle screenshots of both arms; always-run gates
green (test:systemd NOT expected - no supervisor files); reviewer
approve on the final announced fingerprint; every new user-visible
string quoted verbatim; mutation-check stated for any new test.

Decide with reviewer: link text in each arm, Meta row treatment,
helper extraction.

Locked: url consumed from the wire only (never derived in the UI),
port-link arm byte-identical when url is absent, Standing rails.

## SLICE-7 PICKUP (authored after S9's commit; baseline = ca7c29f)

The gate is OPEN: Nil answered both blockers. URL shape is flat
(Rulings), and the domain exists - wildcard DNS `*.test.isomux.app ->
116.203.73.126` is live and verified; the test office runs at
https://test.isomux.app on the Hetzner box (server id 153720692,
auntie's SSH key works; box conventions in room memory and task
236b1c9d's lessons).

Goal: the transport reaches the outside world. Caddy on an
https-published office terminates TLS for app hostnames and proxies
them to the office socket; a fresh hosted install gets this without
manual steps; an EXISTING install gets a documented one-time operator
step (the updater deliberately never rewrites the Caddyfile -
release-design.md consistency). Acceptance is a real browser-shaped
end-to-end on the test box: a registered app answering on
https://<label>.test.isomux.app with a real certificate.

Load-bearing mechanics and traps:
- `deploy/install.sh` owns the managed-Caddy site block (CADDY_MARKER
  machinery; tests in deploy/install-sh.test.ts). Extend the generated
  block: a wildcard-capable site for `*.<office host>` using ON-DEMAND
  TLS (`on_demand`), proxying to the office socket like the main site.
  Keep the block inside the managed markers so install stays
  idempotent; the UPDATE path must not touch it (verify against
  scripts/update.sh - enabling app hostnames on an existing install is
  an explicit documented operator action, not an update side effect).
- tls-ask: on-demand TLS means ANY SNI pointed at the box triggers a
  CA request unless gated. Caddy's `on_demand_tls { ask <url> }` calls
  an endpoint BEFORE issuance: the office serves it (localhost route,
  no auth - Caddy calls it; decide the exact path with the reviewer,
  it is public surface). Policy fail-closed: approve ONLY the exact
  office host and currently-LIVE app labels (registry lookup; retired/
  unknown -> deny). Per-hour issuance cap as a plain named constant
  (sanity bound, not a knob) - this implements the 'proposed per-hour
  cap rides S7' line from PARKED FOR NIL; quote the chosen value in
  the report for Nil's pass.
- DNS for self-hosters is documentation, not code: one wildcard record.
  S10 owns the prose; this slice may leave a draft note in the report.
- Certificates: wildcard DNS + on-demand HTTP-01 per label (no DNS
  provider API assumed). The office host's own cert story is unchanged.
- E2E ON THE TEST BOX (the sanctioned target for this slice - the
  never-touch-a-live-office rail is about auntie, not this box, but
  treat it with care: it is Nil's dogfood box. Leave it running and
  healthy; document every change you make there in the report):
  getting this branch's code onto the box WITHOUT pushing to GitHub -
  task 236b1c9d's recipe (local bare mirror + REPO_URL override in
  /etc/isomux/update.conf) or rsync of the working tree; decide with
  the reviewer, state the method. Register a scratch app, verify
  https://<label>.test.isomux.app end-to-end (page + auth handshake +
  WS echo if quick), verify an unknown label is DENIED at the tls-ask
  (no cert issued, neutral failure), then clean up the scratch app.
- The office-side code for all of this already exists (S1-S6b, S8) -
  expect this slice to be mostly install.sh + tls-ask route + the box
  work. If office code gaps surface (they may - first real-world
  contact), fix them in-slice if small, escalate if structural.
- Gates: always-run set; deploy/install-sh.test.ts must cover the new
  block (idempotence + marker containment); test:systemd only if
  launcher/unit files change (not expected).

Acceptance: transcript of the test-box E2E (real cert on a real label,
denied unknown label, office host unaffected, update.sh run leaves the
Caddyfile untouched); gates green; reviewer approve on the final
announced fingerprint; every new user-visible string (tls-ask denials
are machine-facing - still quote them) verbatim; box left healthy with
changes documented.

Decide with reviewer: tls-ask route path + response shape, cap value,
site-block details, code-delivery method to the box.

Locked: on-demand TLS gated by fail-closed tls-ask, updater never
rewrites the Caddyfile, flat URL shape, Standing rails (no push).
