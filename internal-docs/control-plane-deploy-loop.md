# Control-plane deploy loop (standing orders)

Fourth control-plane loop: deploy the control plane for real - web app on
Vercel at cloud.isomux.com, store on Neon Postgres, provisioner on fly.io -
authorized by Nil 2026-08-11 (slice cut approved in chat). Conventions
identical to the previous loops; their standing orders live in git history:
`git show 08486cf:internal-docs/control-plane-loop.md`,
`git show b1213a9:internal-docs/control-plane-ui-loop.md`,
`git show 52e384e^:internal-docs/control-plane-pg-loop.md`.
Workers re-read this whole file each slice, plus
`internal-docs/control-plane-design.md` (rulings final) and
`control-plane/README.md`. Delete this file at loop close.

North star: the control plane running deployed - `next start` on Vercel
serving cloud.isomux.com against Neon, the provisioner ticking on fly.io
with the key master and provider credentials, and one full
signup -> provision -> handoff -> cancel pass through that deployed stack
against the recycled test box. The Postgres port broke the production wall
(committed evidence: `control-plane/web/e2e/production-server.e2e.ts`);
this loop walks through it.

Cut (approved 2026-08-11):

- D1: Neon readiness - the real Neon project carries the schema and passes
  the suites; bootstrap procedure codified. No new accounts, no deploys.
- D2: provisioner to fly.io - packaged, deployed, ticking, secrets held as
  fly secrets, attention surfacing verified.
- D3: web to Vercel - project, env wiring, production deploy, Google OAuth
  live, cloud.isomux.com serving.
- D4: end-to-end + ops floor - the full customer pass through the deployed
  stack against test box 203474835; operator runbook; close-out.

## Rulings (final)

1. All rulings of the previous three loops stand, including the design-doc
   rulings, R-2026-08-09-1 (fail-closed expiry ceiling), R-2026-08-09-3
   (30-day access-window backstop), R-2026-08-10-1-AMENDED (async one-shot
   invite seam), R-2026-08-10-2 (60s liveness cadence, 5-min claim),
   R-2026-08-10-3 (retention beats provider term), retention = 1 calendar
   month, grace week.
2. Deploy targets are fixed: web = Vercel (Nil's existing personal team;
   new project, default name `isomux-control-plane`), DB = the existing
   Neon project `isomux-control-plane` (pg18, Frankfurt), provisioner =
   fly.io. Public hostname: cloud.isomux.com (settled in
   `internal-docs/hosted-isomux-design.md`).
3. Vercel plan: Hobby through this loop; Pro upgrade when checkout goes
   live (Nil, 2026-08-11). isomux.com already runs on this team.
4. Neon branch discipline (Nil, 2026-08-11): suites and e2e runs target a
   CHILD branch of the Neon project, never the production branch. The
   bootstrap procedure is codified and run against the production branch's
   empty state (schema only - no test data ever lands there).
5. Neon connections use the DIRECT endpoint, not the pooled `-pooler`
   host (the pooled endpoint rejects the startup-parameter timeouts;
   `control-plane/README.md` documents this). DSN lives in
   `~/nil/secrets/control-plane-neon.env`; account-wide Neon API key in
   `~/nil/secrets/neon.token`.
6. DNS reality (Nil, 2026-08-11): only the isomux.app zone is on
   Cloudflare (migrated 2026-08-10). isomux.com is still on Namecheap
   BasicDNS and carries live email forwarding (llc@) - it is not migrated
   casually. The `cloud` CNAME is added by Nil in Namecheap when D3 hands
   him the exact record, unless the manager proposes an isomux.com
   migration mini-runbook first (isomux.app runbook pattern, with the
   email-forwarding branch handled). No DNS API token exists and nothing
   in this deployment automates DNS.
7. Cloud accounts: no worker creates or signs up for anything. The fly.io
   app is created at D2 start under Nil's account (approved 2026-08-11,
   pending his dashboard check for an existing app); the API token lands
   in ~/nil/secrets/ first, smallest machine tier, and any paid action is
   reported immediately. Provider spend target for customer boxes stays
   EUR 0: test box Contabo 203474835 only (paid through 2026-08-29),
   list first, never a second box. cp1.test.isomux.app is LE-rate-limited
   until ~2026-08-16; cp2.test.isomux.app has cert budget.
8. Secrets (two prior incidents; this is load-bearing): never shell-source
   an env file; env files carry single-quoted values; secrets are read
   inside the consuming process, never expanded in a logged shell; only
   boolean checks (`grep -qE` + echo ok/bad) and metadata on
   ~/nil/secrets/ files; never print any content-derived fragment of one.
9. Nil-side pre-launch items stay outside worker scope: Google OAuth
   client (Nil creates it before D3; manager re-sends the walkthrough at
   D3 dispatch), CONTROL_PLANE_MINT_TOKEN/URL, pricing (bf127061),
   terms/privacy final read (c1d6ed82), Vercel Pro upgrade.
10. R-2026-08-11-1 (connection governance, ruled on Isomuxer2's measured
   escalation): D3 deploys with the ungoverned web-tier worst-case
   aggregate recorded as a DATED FINDING (2026-08-11: Neon direct
   max_connections 901; Vercel publishes no concurrency ceiling on any
   plan; the pooled endpoint refuses the store's options string with
   SQLSTATE 08P01, correcting D1's README). The finding has a hard
   expiry: slice D3.5 lands an engine-or-pooler-enforced aggregate
   posture with a provisioner reserve BEFORE D4 begins, and D4 must not
   open any real signup path while the finding is open. Option B
   (role-level ALTER ROLE ... SET for both bounds, open-time read-back
   retained, pooled eligibility for the web tier) is the preferred
   shape; option A (a web role with CONNECTION LIMIT) may compose with
   it; the D3.5 plan-gate settles the design with measurements. Moving
   the bounds' enforcement point to the role while keeping the read-back
   that refuses to run unproved preserves the design's guarantee -
   implementation locus, not semantics. Per-instance pool hygiene stays
   an ordinary D3 plan-gate item.

## Lanes

Alternate Isomuxer1/Reviewer1 and Isomuxer2/Reviewer2 only (Nil,
2026-08-11); I3-I6 stay free for parallel work. The Postgres loop ended on
I1/R1, so: D1 = I2/R2, D2 = I1/R1, D3 = I2/R2, D4 = I1/R1. Manager clears
both lane sessions, then sets effort, then dispatches - in that order,
every slice. At most two worker lanes on this box, prefer one while any
lane runs builds or full suites.

## Standing rails (prohibitions)

As the previous loops, short: no commits/prettier by workers (manager owns
both), one slice in flight, work in main, freeze + fingerprint against the
merge base + formal reviewer approval on the exact fingerprint, end turn
after any gate request (silence is never approval), surface permission
denials instead of working around them, no isomux server code changes, no
restarts, no DNS writes, no new cloud accounts, no schema changes without
a plan-gate. Deploys are allowed only where the slice's pickup section
names them - nothing outside the named surface.

Gate baseline every slice: full `bun run ci` green (it typechecks; `bun
test` alone does not), plus the slice's own live evidence. Never pipe a
suite run through a filter in the same command - redirect to a file, then
`echo $?`.

Harness caveats: long foreground Bash calls can be auto-rejected mid-flight
and kill the backend - run gates as separate short calls, background the
full suite, never chain sleeps. If a session dies, the manager resumes it;
verify any mutation-cycle files are pristine before continuing.
next-env.d.ts is rewritten by any `next dev`/`next build`: restore it
(`git checkout control-plane/web/next-env.d.ts`) before fingerprinting.

## Process per slice, gates, decision protocol

Identical to the previous loops (see the git-history files above): worker
plan-gates with the reviewer before code, implements, runs gates, freezes,
fingerprints (`git add --intent-to-add . ; MB=$(git merge-base main HEAD);
git diff HEAD | wc -l` + `md5sum`), diff-gates on the announced
fingerprint until formal approval, then reports: what changed,
verification, verdict + fingerprint, all user-visible prose verbatim,
mutation statement, parked items. Worker-reviewer deadlocks go to the
manager; measured evidence beats plausible reasoning. Anything policy- or
money-shaped is PARKED FOR NIL in the end-of-loop queue unless it blocks
the slice.

## Slices

- [x] D1: Neon readiness (I2/R2) - approved fingerprint 98c6631 / 2297 /
      a6bc5ece31b244372d4f4b23eff9c089, commit 97c2821. Facts that outlive
      the slice: Neon silently drops timeouts sent as pool startup fields;
      they hold via the `options` startup parameter, and Store.open now
      verifies both bounds from the engine and refuses to open otherwise
      (measured 2026-08-11). A session proves its own branch
      (`neon.branch_id`); testing/target.ts fails closed on any remote
      target that cannot. Neon production is schema-ready and zero-user-data
      (bootstrapped 2026-08-11, idempotence re-run included); the `suites`
      child branch persists for D3/D4 - delete at loop close
      (`bun control-plane/exercises/neon.ts branch --delete suites`).
      Deployed DSNs: DIRECT host + sslmode=verify-full, no options needed.
      Full suite vs Neon: 732/0 in 9m15s (bun --timeout 30000 is
      load-bearing; no source timeout moved).
      ~/nil/secrets/control-plane-neon.env still holds the pooled host -
      tidiness item for Nil, nothing depends on it anymore. Three tests'
      assertions moved from engine prose to SQLSTATE codes (worker
      self-edit, reviewer-approved as stricter and portable).
- [x] D2: provisioner to fly.io (I1/R1) - approved fingerprint 77ab640 /
      2828 / f461eb8ed7d30d2ffdde65c0322e955e, commit dcef44f. Facts that
      outlive the slice: the provisioner is LIVE - app isomux-provisioner
      (org personal), machine 080e977db16d18 (shared-cpu-1x 256MB, fra),
      volume vol_rnz65n6qm378pn1r (1GB, encrypted, scheduled snapshots
      OFF - a manual snapshot would still carry 5-day retention, parked
      to the D4 ops floor with task 962965dc). Surface
      https://isomux-provisioner.fly.dev, bearer-enforced, /internal/health
      behind the same bearer. Spend: ~USD 1.94/mo machine + ~EUR 0.15/mo
      volume + Depot minutes (all reported live, 2026-08-11). Boot refuses
      without a proved branch pin or writable state marker; tick loop
      idles gracefully without Contabo creds (37-min measured window,
      zero operations, zero restarts). D3 reads the SAME bearer file
      (~/nil/secrets/control-plane-mint.env) and sets
      CONTROL_PLANE_MINT_URL to the fly surface. flyctl writes per-app
      bookkeeping into ~/.fly/config.yml - a changed md5 there is not an
      incident. Process lesson: scripted edits (sed) can silently no-op
      and report success - assert the change applied before running the
      check that depends on it.
- [ ] D3: web to Vercel (I2/R2)
- [ ] D3.5: connection governance - role-enforced bounds + provisioner
      reserve, closes the R-2026-08-11-1 finding (I1/R1; pickup authored
      at D3 close)
- [ ] D4: end-to-end + ops floor (I1/R1 becomes I2/R2 - alternation
      shifts with the inserted slice)

## PICKUP - SLICE D1: Neon readiness (Isomuxer2 / Reviewer2)

Goal: prove the store runs against the real Neon project and codify how
the production branch gets bootstrapped, so D3 can point a Vercel deploy
at it without ceremony.

What exists: the Neon project `isomux-control-plane` (pg18, Frankfurt),
created 2026-08-11, empty. Direct-endpoint DSN in
`~/nil/secrets/control-plane-neon.env`; account-wide API key in
`~/nil/secrets/neon.token`. The store and its suites are fully
Postgres-native since the last loop (local docker + CI service container);
`control-plane/web/e2e/production-server.e2e.ts` drives the production
web server against a real Postgres.

The work:

1. Child branch: use the Neon API (key above, read inside the consuming
   process per ruling 8) to create a child branch of production for test
   runs, and derive its direct-endpoint DSN. Decide with the reviewer:
   branch naming, per-run-create-and-delete vs a persistent suites
   branch, and how a run is pointed at it (existing `CONTROL_PLANE_DB`
   mechanics only - ruling: no new env var names without a plan-gate).
2. Suites against Neon: the store suites (store, pg-concurrency, and
   whatever the plan-gate scopes in) plus one production-server e2e run,
   all against the child branch. Expect remote-latency effects
   (Helsinki -> Frankfurt): decide with the reviewer what gets serialized
   and what timeouts move; a timeout bumped for latency needs a comment
   saying so.
3. Bootstrap: codify the procedure that takes the production branch from
   empty to schema-ready (script or documented command sequence - prefer
   whatever the repo already has for docker-Postgres setup), run it once
   against the real production branch, and leave production schema-ready
   and data-empty. No test data on production, ever (ruling 4).
4. Docs: `control-plane/README.md`'s Neon section currently says
   "undeployed / nothing has run against Neon" - update it to what is now
   verified, with dates on every measured claim. Check
   internal-docs/documentation.md for other surfaces.

Acceptance: a transcript showing (a) child branch created via API, (b)
suites green against it with exit codes captured, (c) one
production-server e2e green against it, (d) the bootstrap run against
production and a boolean check that production holds schema + zero rows
of user data, (e) README updated. Plus the standard gate baseline (full
`bun run ci` green locally - CI itself stays on the docker service
container; Neon runs are live evidence, not CI wiring).

Traps:
- The pooled `-pooler` endpoint rejects the startup-parameter timeouts -
  direct endpoint only (README documents it). A child branch has its own
  endpoint host; make sure the derived DSN is the branch's direct one.
- TLS: Neon requires it; the local docker DSN does not use it. If the
  driver config needs an ssl knob, that is config-shape work the reviewer
  sees in the plan, not an ad-hoc edit.
- Free-tier limits (connections, compute autosuspend): a suite that opens
  wide parallel connections may behave differently than docker. Measure,
  do not guess; serialize if needed and say so in the report.
- Secrets: the DSN never appears in output, logs, test names, or error
  dumps. Redaction applies to error paths too - a connection-refused
  error can embed the host; check what the driver prints before letting
  a failing run into the transcript.
- Locked: no Vercel, no fly.io, no DNS, no schema changes, no engine
  changes, no new env vars. A Neon incompatibility with existing SQL is
  a plan-gate escalation, not a workaround.

Report to Isomux Manager with the standard format when done.

(D1 closed 2026-08-11, commit 97c2821 - the pickup above is kept as history;
the tick note in the Slices list corrects what it got wrong, notably that the
env file held the pooled DSN.)

## PICKUP - SLICE D2: provisioner to fly.io (Isomuxer1 / Reviewer1)

Goal: the provisioner running as a fly.io app in Nil's `personal` org -
booted against Neon production with proved branch identity, tick loop idling
cleanly, secrets held as fly secrets, an HTTPS surface guarded by a bearer
for the web app to call later, and a documented, idempotent deploy
procedure. No customer-box operations in this slice.

What exists:
- fly token: ~/nil/secrets/fly.token (org-scoped, org `personal`, named
  isomux-control-plane, expires 2027-08-11). flyctl at ~/.fly/bin/flyctl.
  Pass the token per-command (env assignment reading the file); never
  source it, never echo it, never run `flyctl auth ...`. The machine-wide
  ~/.fly login belongs to wallgame deploys - do not use or mutate it, and
  do not touch any existing fly app.
- Neon production is schema-ready and empty (D1). The deployed
  CONTROL_PLANE_DB must use the DIRECT host and sslmode=verify-full; no
  options incantation - Store.open adds its own governed bounds and
  refuses to open if the engine drops them.
- Branch identity is provable from the session (D1's neon.branch_id
  mechanics in testing/target.ts / exercises/neon-api.ts) - reuse, do not
  reinvent.

The work:
1. Packaging: Dockerfile (Bun runtime) + fly.toml committed; app name
   default `isomux-provisioner`, region fra (Neon is Frankfurt). Machine
   size from a measurement, not a guess (shared-cpu-1x; 256MB vs 512MB).
2. Secrets: Neon DSN (direct host, built the D1 way) and the surface
   bearer as fly secrets. The mechanics must honor ruling 8 - `fly
   secrets set K=V` puts the value in argv; use an stdin path
   (`fly secrets import`) fed by a process that reads the env file.
   Plan-gate the exact mechanics.
3. Boot proof: on start the provisioner opens the store (governed bounds
   verified), proves the branch is production, and logs booleans only.
   A health surface reachable from outside reports the same booleans.
4. Tick loop: runs idle against the empty database over a measured
   window - no operations created, no crashes, no restarts by fly.
5. Web-callable surface: HTTPS + bearer (the mint-seam/transport notes in
   the design doc around "Transport, and the deploy-time note"). D2
   delivers the guarded surface; wiring Vercel to it is D3/D4.
6. Docs: deploy procedure (first deploy AND redeploy) with dates;
   README or internal-docs placement per documentation.md.

Decide with the reviewer:
- Contabo credentials in or out of this slice. Default OUT: the design
  says provisioning stalls gracefully when the provisioner lacks means -
  measure that the tick loop actually idles without provider creds; if
  it crashes instead, that is a real finding to report, not to patch
  silently. Real Contabo creds land no earlier than D4.
- Key-master persistence: read what keys.ts actually needs before
  deciding fly volume vs store-held material.
- What the health surface exposes (booleans only, per ruling 8).
- Machine memory size, from a measurement.

Traps:
- Any paid action (app create, machine create) is reported to the manager
  the moment it happens (ruling 7 - the spend itself is approved).
- The org token sees every app in `personal` (wallgame included): scope
  every flyctl invocation to the new app explicitly.
- Fly's builder may default to remote build (a paid builder machine can
  spin up): know what your deploy command does before running it.
- Locked: no Vercel, no DNS, no Contabo API calls (unless the plan-gate
  rules creds in - default is out), no store-semantics changes, no schema
  changes, no changes to D1's Neon machinery beyond reuse, no isomux
  server code, no restarts.

Acceptance: a transcript showing (a) app created and deployed via flyctl
with the token from the secrets file and no token or DSN in any output,
(b) boot logs with governed-bounds + production-branch booleans true,
(c) external health check green, (d) a measured idle window with zero
operations and zero restarts, (e) an idempotent redeploy, (f) full
`bun run ci` green locally, (g) docs updated with dates.

Report to Isomux Manager with the standard format when done.

(D2 closed 2026-08-11, commit dcef44f - pickup kept as history; the tick
note in the Slices list carries what outlives it.)

## PICKUP - SLICE D3: web to Vercel (Isomuxer2 / Reviewer2)

Goal: the control-plane web app deployed on Vercel as a production build
under Node against Neon production, serving cloud.isomux.com with Google
sign-in live and dev-auth structurally absent, wired to the provisioner's
bearer surface. Hobby plan (ruling 3).

Nil-side dependencies - the manager owns chasing these; plan around them,
do not wait idle:
- Vercel API token at ~/nil/secrets/vercel.token (requested; boolean-check
  for presence).
- Google OAuth client id + secret at ~/nil/secrets/control-plane-oauth.env
  (requested; the redirect URI is
  https://cloud.isomux.com/api/auth/callback/google).
- The `cloud` CNAME lives in Namecheap and only Nil writes DNS: when the
  Vercel project names its target, hand the exact record to the manager
  and continue on what does not need the hostname.

What exists:
- Neon production: schema-ready, empty, direct-host DSN built the D1 way,
  sslmode=verify-full, no options incantation (Store.open self-governs
  and refuses if the engine drops the bounds). The `suites` branch is for
  tests; production never sees test data (ruling 4).
- The provisioner surface and bearer (D2 tick note above). D3 sets
  CONTROL_PLANE_MINT_URL to the fly surface and reads the SAME bearer
  file, in-process, per ruling 8.
- e2e/production-server.e2e.ts proves `next start` under Node serves
  store-backed authenticated pages; its session-cookie minting pattern is
  the documented way to prove store-backed pages without an interactive
  OAuth click (README documents it).
- Vercel: Nil's personal team. NEW project, default name
  isomux-control-plane; the existing `isomux` project is the landing page
  and is not touched.

The work:
1. Local production posture first (needs nothing from Nil): `next build`
   + `node next start` against Neon (suites branch), the full env
   contract enumerated and documented (names only, never values).
2. Vercel project via CLI with the token: root directory
   control-plane/web in a monorepo whose web app imports from ../
   (store, auth) - whether Vercel's build includes files outside the
   root directory is a MEASURED plan-gate item, not an assumption. So is
   the install path (the repo is bun.lock-only).
3. Env vars into Vercel without values in argv (vercel env add reads
   stdin) - ruling 8 mechanics, plan-gate the exact commands.
4. Preview deploy, verify, then production deploy. Add the domain; hand
   the exact DNS record to the manager for Nil; TLS follows DNS.
5. Auth: Google provider wired once Nil's client exists; prove from
   OUTSIDE the deployment that dev-auth is absent in the production
   build and that an unauthenticated request cannot reach store-backed
   pages. The interactive OAuth click-through lands in the acceptance as
   a Nil action at the end (his account, his browser) - stage it last.
6. Provisioner wiring: one authenticated round-trip from the deployed
   web to the fly surface (health is enough; minting real invites can
   wait for D4).
7. Docs with dates; documentation.md check.

Traps:
- The deployed web app holds NO provider credentials and no key material
  (design: that is the whole reason the provisioner exists).
- Vercel serverless means many concurrent connections: the DIRECT
  endpoint is correct for the always-on provisioner, but the web side's
  connection posture (direct vs pooled + how the driver pools per
  lambda) is a plan-gate topic with the D1 finding in hand - the pooled
  host drops governed bounds silently, so any pooled choice must prove
  its bounds the D1 way or be refused.
- next-env.d.ts is rewritten by any next command: restore before
  fingerprinting (standing caveat).
- Vercel CLI output can echo env NAMES freely but must never receive a
  value as an argument; deployment URLs are fine to print.
- Hobby-plan ceilings (function duration, no cron) are fine for this
  slice; anything that needs Pro is a finding, not a workaround.
- Locked: no Contabo, no fly.io changes (reading the D2 surface is not a
  change), no DNS writes, no schema changes, no pricing or customer copy
  changes (pricing sits with Nil), no store-semantics changes.

Acceptance: a transcript showing (a) local `node next start` production
posture green against Neon, (b) Vercel production deployment serving
store-backed authenticated pages against Neon production, (c) dev-auth
proven absent from outside, (d) unauthenticated requests refused, (e) one
bearer round-trip web -> provisioner, (f) the DNS record handed over and,
once Nil lands it, cloud.isomux.com serving with TLS, (g) full
`bun run ci` green locally, (h) docs dated. The final interactive Google
sign-in is verified by Nil and recorded as his action.

Report to Isomux Manager with the standard format when done.
