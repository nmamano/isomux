# Control plane: provider adapter and SSH driver

## Hosted certificate configuration

The provisioner refuses hosted certificate work unless its target is complete.
On the Docker host, `provisioner.env` (template:
`deploy/vps/provisioner.env.example`) supplies the pinned production CA,
Cloudflare API, and renewal endpoint, and also these secrets:

- `ISOMUX_CF_ZONE_ID`: the one production zone that the token can edit
- `ISOMUX_CF_TOKEN`: a token limited to DNS records in that zone; it writes
  ephemeral ACME TXT records and permanent office A records
- `ISOMUX_ACME_EMAIL`: the ACME account contact

The same file carries the provisioner's Stripe credentials.

Automated tests use loopback ACME and DNS fakes. The target validator rejects
the production CA, Cloudflare API, or production zone in a test process even if
the caller sets the production opt-in.

The provisioning half of hosted isomux. One command turns a provider API call
into a live HTTPS office with an owner invite in hand and our key removed, with
the removal proven by a failed reconnect using the removed key.

Design: `internal-docs/control-plane-design.md` (the spec; its rulings are
final) and `internal-docs/hosted-isomux-design.md` (the product).

Before deploying a build that adds customer SSH key carriage to an existing
database, run the owner-role migration once:

```bash
bun control-plane/cli.ts migrate-customer-ssh-key
```

Before deploying a build that lets an account hold several offices, run the
owner-role migration once:

```bash
bun control-plane/cli.ts migrate-multi-office
```

It preserves every reservation row, removes the account-only unique constraint,
and replaces its lookup index. Runtime processes refuse the old schema.

Runtime roles cannot apply this DDL. Until the migration lands, both the web
and provisioner processes refuse to open the old schema.

Before deploying a build with pending Checkout recovery, run its owner-role
migration while the current build is still serving:

```bash
bun control-plane/cli.ts migrate-pending-checkouts
```

On the Docker host, `deploy.sh` runs all of them before it starts a release
("Deploying from main").

Operator invocation for any of these: load the owner DSN in-process, never
by shell-sourcing a secrets file -
`bun --env-file=<operator secrets file> control-plane/cli.ts <migrate-command>`.
The file carries `CONTROL_PLANE_DB` and bun parses it inside the process.

It adds nullable reservation columns with `if not exists`, so it does not
rewrite existing reservation rows and is safe before the code deploy. The new
runtime refuses to start until every column is present.

Nothing here runs in the isomux server. It is a CLI driven by an operator, and
it holds no standing access to anything it builds.

## Commands

```
bun control-plane/cli.ts list
bun control-plane/cli.ts recycle --instance <id> --host <name> [--run-id <id>]
bun control-plane/cli.ts connect --run <runId>
bun control-plane/cli.ts resume  --run <runId>
bun control-plane/cli.ts provision --run <runId> --access-window 2h [--stop-after first-contact|install] [--handoff-now] [--owner-name X]
bun control-plane/cli.ts finish  --run <runId> [--handoff-now]
bun control-plane/cli.ts mint    --run <runId>
bun control-plane/cli.ts revoke  --run <runId>
bun control-plane/cli.ts run [--bind ADDR] [--deployment ID]  # the tick loop, as its own process
bun control-plane/cli.ts tick                    # one pass
bun control-plane/cli.ts ops     [--run <runId>] # the operation rows
bun control-plane/cli.ts attention [--ack <instanceId>] [--resolve <instanceId>] [--by <name>]
bun control-plane/cli.ts status  --run <runId>
bun control-plane/cli.ts expiry-test --run <runId> --variant boundary|powered-off [--seconds N]
bun control-plane/cli.ts bootstrap                # an empty database -> schema-ready
bun control-plane/cli.ts set-database-identity    # owner writes CONTROL_PLANE_DB_IDENTITY into the database
bun control-plane/cli.ts regovern                 # owner converges the runtime grants to the matrix
bun control-plane/restore-check.ts fingerprint    # counts, hashes and definitions of CONTROL_PLANE_DB
bun control-plane/restore-check.ts compare <source.json> <target.json>
bun control-plane/state-move.ts export [--data /data] > state.json   # the key-free provisioner state, for a move
bun control-plane/state-move.ts import [--data /data] < state.json   # into an empty state volume
```

A rebuild always issues a fresh hosted TLS key and certificate. The TLS-key
carry shipped in commit `dd21dd5` and was later deleted per Nil's ruling. The
adapter compares complete normalized SPKI keys and forces one renewal if lego
returns the wiped box's stale chain. That costs one duplicate-certificate slot.
A second mismatch fails with operator attention instead of returning stale
material or looping.

lego waits for the challenge TXT at the authoritative name servers only
(`--dns.propagation.disable-rns`). A caching resolver can keep the first
challenge's value past lego's 60-second pause before the second challenge on
the same name, and then a recursive check times out.

Credentials come from the environment (`CONTABO_CLIENT_ID`,
`CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD`); sourcing
the file that holds them is the caller's job. Runtime state - generated keys,
run records, the audit log - lives in `~/.isomux-control-plane/`, never in the
repo.

`--access-window` is required and has no default. It may shorten a diagnostic
run, but it cannot exceed seven days. The driver refuses to rewrite an
authorized_keys line without an absolute expiry instant, and the CLI refuses to
start without one: a missing ceiling stops the run at every layer.

There is no create command. The adapter can create a box and the tests exercise
that path, but no flag reaches it: creating one is latched durably by
`intents.ts` and is a thing a human does on purpose.

`run`'s two deployment flags default to the operator's shape and are set by the
Compose file, not by a person: `--bind` moves the invite seam off loopback
(`0.0.0.0`, so the storefront reaches it on the Compose network), and
`--deployment` carries an opaque release id that the state marker uses. Neither
has an environment variable, because both are properties of how this process was
started rather than of the machine it runs on. See "Deployed: Hosted Isomux on
one Docker host".

## Contabo: what the API actually does

Four findings that shape the adapter. Each cost a real debugging cycle, so they
are written down rather than left as folklore.

### `find` semantics, and why every row is re-verified

**Unrecognised query parameters are silently ignored.** `?foo=bar` returns the
full unfiltered instance list rather than a 400 (verified 2026-08-09).
`?displayName=X` is a real server-side exact match.

So a `find` that trusts the server-side filter would, on a typo or a silent API
change, hand back an unrelated box - and adopting the wrong box is the
paid-duplicate failure class the design exists to prevent. `find` therefore
re-verifies every returned row against the intent stamp and reports `exact`
only when all three hold:

- every row the server returned matches the stamp (so the filter was honoured);
- exactly one row matches;
- the reported total is no larger than the page we read.

Anything else is `unproven`, which raises a human rather than being acted on.
The intent is stamped into `displayName` as `isomux-cp-<intentId>`.

**The separator is a hyphen because a colon is rejected.** Measured live
2026-08-09: Contabo validates `displayName` and answers `400 {"message":["Only
numbers, letters, spaces and - allowed."]}`. Slice 1 shipped a colon here, which
would have made every live create fail at the provider - invisible to fixtures,
and invisible to slice 1 because it never ordered a box. `intentStamp` now
refuses an intent id it cannot stamp legally, so the failure lands locally
instead of on the one call that must never be repeated blind.

Absence gets the same treatment. `null` is a CLAIM - "no such box" - and an
unsound search has not earned it: if the filter was ignored, the rows are a
slice of the whole account and the box may exist just off the page. So `find`
returns `null` only when the filter was honoured AND the response was provably
complete, and otherwise throws `IndeterminateFindError`. Exactness likewise
needs affirmative evidence: a response carrying no pagination metadata tells us
nothing, and nothing is not proof.

### There is no create idempotency key

Contabo documents `x-request-id` as "Uuid4 to identify individual requests for
support cases" - a support-correlation id. `POST /v1/compute/instances`
documents no idempotency, retry-safety or deduplication mechanism at all.

**Create is never replayed.** An ambiguous create - timeout, 5xx, dropped
connection - is resolved by `find`/list only. `intents.ts` latches this
durably: the pre-call record is written and fsynced _before_ the call and
already means "the paid call may have happened; create is permanently forbidden
for this intent", so death at any instruction boundary fails safe.

Three properties make that latch worth trusting:

- **It fails closed.** Only "this file does not exist" reads as absent. A
  permission error or corrupt JSON throws, because an unreadable journal is not
  a licence to buy another box.
- **The filesystem arbitrates.** Reservation is an exclusive create (`O_EXCL`),
  not a read followed by a write - two workers can both observe "absent" in the
  same instant and both pass a check-then-act.
- **There is one seam.** `CreateCoordinator` is the only thing that may spend
  money: it reserves, then calls, then records. `ProviderAdapter.create` exists
  to satisfy the portable interface and must not be called directly.

Not live-verified, deliberately: establishing it empirically would mean issuing
duplicate paid creates.

### The documented default login user is wrong

`defaultUser` is documented as defaulting to `"admin"`, and its accepted values
are `root`, `admin`, `administrator`. A create that omits it produces an
`ubuntu` account - which is not one of the accepted values.

So `defaultUser` is always sent explicitly, on create and on reinstall, and the
resulting account is carried forward as run evidence that first contact
consumes. First contact connects as exactly that user and treats anything else
as a precondition failure; there is no username guessing loop in a
security-critical step.

Measured on a live reinstall (2026-08-09): requesting `root` is accepted, and
root is then the sole account carrying the injected key, with no forced-command
line and no other key present.

### Reinstall works on a cancel-scheduled instance, and preserves the term

`PUT /v1/compute/instances/{id}` (imageId, sshKeys, defaultUser) rebuilds in
place. Contabo's documentation says nothing about whether a cancelled instance
can still be reinstalled; measured 2026-08-09, it can, and `cancelDate` survives
the rebuild, so recycling inside an already-paid month costs nothing.

This is why `recycle` is proven before anything is revoked: after revocation the
box has no keys at all, and a provider reinstall is the only way back in.

`reinstall` is a Contabo-specific extension, not part of the portable
`ProviderAdapter`. The installer needs nothing from a provider beyond a fresh
Ubuntu box with our key on it, so requiring every adapter to wipe and rebuild in
place would be inventing a requirement the product does not have.

## Operations, leases and deadlines

Provisioning is not a script; it is a set of durable rows. Service state stays
coarse (`provisioning`, `live`, `suspended`, `deprovisioned`) and the
fine-grained progress lives in typed **operation** rows, which is what makes
recovery deterministic: "installing" is no longer one word covering
not-launched, running, and exited.

`provision --stop-after` and `--handoff-now` are not control flow any more. They
set the instance's **goal** (`first_contact`, `installed`, `live`,
`handed_off`), and `nextKind(completed, goal)` decides what follows what - so a
restart continues to the same place without being told again where it was going.
Completing an operation and enqueueing its successor is ONE transaction, and the
partial unique index on `(instance_id, kind) where status in
(pending, running, ambiguous)` is the final arbiter of who gets to open it.

**Nothing sleeps inside a tick.** Slice 1's three blocking loops - wait-for-SSH,
the installer poll, the HTTPS wait - are single probes now, and the waiting is
persisted as `next_attempt_at`. That is what makes a crash between two polls a
tick that did not happen rather than a flow nobody can resume.

**A version CAS fences a stale write; it does nothing about a stale ACT.** So a
handler declares a hard bound on its remote work, `SpawnExec` enforces that bound
by killing the child, and the tick refuses to begin unless it provably owns the
lease for longer than the bound plus a margin (`LEASE_MS` 300s, `LEASE_SAFETY_MS`
60s, `maxRemoteMs` at most 150s - see the per-kind table in operations.ts). A holder that loses or cannot renew its lease
does not touch a remote seam at all. The residual - a process stopped between the
check and the kill - is covered by the box: `flock -n` plus the wrapper's refusal
to reuse a generation directory is what stops two installers, not our bookkeeping.

A killed child throws `RemoteTimeoutError`, which is **ambiguous by default**
rather than a clean failure: it proves nothing about whether the remote side
acted. Only read-only probes opt down to a plain retry.

The instance row and its provider asset are created in ONE transaction: a death
between them would leave an instance with no provider axis, and the restart would
take the "already exists" branch and never look again - the four-axis model
quietly down to three. A restart also repairs a row that is missing its asset,
for the databases an older build could have left.

**There are two fences and they are not the same one.** TIME bounds the right to
BEGIN remote work: the budget caps itself by `lease_until - LEASE_SAFETY_MS`, so
once a lease is spent nothing new can start. The VERSION/HOLDER token bounds
whether a late RESULT may be recorded: if another holder adopted, or a deadline
flag landed, or anything else touched the row, the old result is refused.

So an expired holder that nobody has adopted yet may still write down what it did
while it legitimately held the lease. Requiring the lease to still be live at
write time would discard valid evidence without preventing a single conflicting
write - the version predicate already prevents those - and that evidence is often
the record of a real remote effect the next holder would otherwise rediscover the
hard way.

**A losing writer re-reads and DECIDES; it never replays.** For provider truth
the decision is to DROP the response: re-applying an older answer on top of the
winner's newer one is a blind retry wearing a fresh version number. A fresh `get`
on the next tick is what settles it, and a failed read never pushes out a
schedule somebody else has since made more urgent.

**Deadlines flag; they never conclude.** Each operation carries an inactivity
deadline that resets when its evidence advances and a larger absolute ceiling.
Blowing either raises attention and leaves the operation exactly as it was, still
retrying. `revoke_access` has no fatal arm at all: a failed revocation is an
attention case that keeps trying, because the box-local timer means the failure
costs a broken promise about _when_, not a broken guarantee.

Attention is persisted, and every reason is its own row. The instance's attention
columns are a written summary of the still-open reasons, recomputed in the same
transaction - so an installer deadline cannot clear or overwrite an open
revocation failure. Acknowledging is **not** clearing: `attention --ack` records
that a human saw it, and the instance keeps reporting `needs_operator` until the
condition itself goes away. `attention --resolve` clears only a broken promise,
the one condition that never goes away by itself.

## Where the state lives

Postgres, named by `CONTROL_PLANE_DB` as a `postgres://` connection string.
There is no default: a file path could be derived from a home directory, and a
connection string cannot be derived from anything, so a command with no
`CONTROL_PLANE_DB` refuses rather than guessing which database it is about to
write to. `~/.isomux-control-plane/` still holds the keys, run records and the
audit JSONL.

The SQL stays constrained rather than idiomatic, because it is the part a second
engine would have to agree with: service state, goal, attention state and
severity, operation status, intent state and PROVIDER ASSET STATE all carry CHECK
constraints, so every finite set is enforced by the database and not only by a
TypeScript union; times are BIGINT ms-epoch, booleans are 0/1, JSON travels as an
already-serialised TEXT parameter, the audit log's event id comes from a
`sequences` row bumped in the same transaction rather than an identity column,
and every mutation is one statement with a version predicate. Private key
material still never enters the database: the run record and the 0600 key files
on disk remain the authority, and the schema stores only the runId, the public
blob and paths.

**Times are `bigint`, and that is not a preference.** A millisecond epoch does
not fit `integer`: the unported schema answers `22003` the moment one is bound.
The driver is configured to hand `bigint` back as a JS number rather than as the
string it defaults to - a string timestamp compares, sorts and serialises without
ever complaining, so it would simply be wrong wherever a deadline is evaluated.
The parser is attached to the store's own pool rather than installed globally,
and a test round-trips a written instant and asserts it comes back a number.

Durability is not decoration: `create_intents` is the latch that stops us buying
a box twice, so `synchronous_commit` stays at its default `on` and nothing in
this codebase turns it off, in production or in a test container.

There is no schema migration, and a database written before this build REFUSES TO
OPEN rather than failing somewhere in the middle of a run: `create table if not
exists` is silent about a table that exists with the wrong columns, so the store
checks the catalog for the columns it needs and names the database to move aside.

It names it by naming CONTROL_PLANE_DB, and nothing else. Stripping the password
was the earlier answer and is not enough: measured 2026-08-11, the host carries
the provider's endpoint id and the driver's own SQLSTATE 28P01 message carries
the role, so every part of a DSN is something somebody could copy out of a log.
`Store.describe()` is now a fixed sentence and `describeDatabase` is gone.

**The driver's message is never forwarded.** `redactConnectionDetails` wraps
every failure at the store's two seams and emits a fixed sentence chosen by
error class plus an allowlist of the STRUCTURED fields a Postgres error carries

- severity, table, column, constraint, routine - which are literals of ours
  rather than provider text. It keeps the SQLSTATE and attaches NO CAUSE, because
  a cause is how the original message comes back one layer down.

**The stack is rebuilt from frames, not copied.** A stack's first line is
`Error: <the driver's own message>`, so retaining a stack that merely passed a
component check would have carried the free text across this boundary through
the back door, and put the completeness of a substring list back in the middle
of the guarantee. The header is discarded unconditionally and replaced with the
sanitized one; only `at ...` frames are kept, and only if every one of them is
clean, so one suspect frame drops the lot instead of being filtered out
quietly. The call site survives, which is what makes the thin message tolerable.

Two designs were tried and rejected before this one, and both failed in review:
replacing each component substring mangles a diagnostic into holes and cannot
handle a one-character role, and skipping short components to avoid that lets a
short role, a two-letter database or a port straight out. Forwarding a message
that merely LOOKS clean is the same bet with an extra step - it depends on the
component list being complete, and the list was not: a message quoting only the
endpoint id passed a whole-hostname check. So the message is not forwarded at
all, and what is left is checked against every component of the DSN (password,
role, host and each of its non-numeric labels, port, database name, every query
parameter name and value including `options`, and each token inside a value) at
ANY length.

The price is stated rather than hidden: a unique violation now reads `the
database refused a statement (SQLSTATE 23505) constraint=operations_pkey
table=operations` instead of the engine's prose, and three tests that asserted
that prose now assert the SQLSTATE - which is the portable fact anyway.

A live check against the managed endpoint, `exercises/neon-redaction.ts`, ran
four deliberate connection failures through these surfaces. It was removed with
Neon on 2026-10-15.

### What a managed Postgres gave this build (Neon, measured 2026-08-11)

Neon was the production database until the move to the Docker host, and the
project was deleted on 2026-10-15. This section is the record of the runs
against it. The store's managed-session path below came from them and stays.

- **THE TWO BOUNDS DO NOT SURVIVE AS STARTUP FIELDS, AND NOTHING SAYS SO.**
  `statement_timeout` and `idle_in_transaction_session_timeout` used to travel
  as `pg` pool options, which the driver sends as protocol startup fields.
  Against the local container `current_setting` reports `30s` for both. Against
  Neon's DIRECT endpoint, with the identical pool configuration, it reports `0`
  and Neon's own `5min` - no error, no warning, no failed connection. A build
  deployed on Neon before this was found had no statement_timeout at all, which
  is the bound the paragraph below argues is load bearing.
- **They DO apply through `options`**, the same startup parameter the test DSNs
  already use for `search_path`, and the two travel together in one value. That
  was the store's route on every engine until 2026-08-11, and it is now the
  route on UNMANAGED ones only - on a managed branch the bounds come from the
  role, because the pooled endpoint refuses `options` and a serverless tier
  wants a pooler (see the posture section below). Where it still applies,
  `withGovernedOptions`
  merges `-c statement_timeout=30s -c idle_in_transaction_session_timeout=30s`
  into whatever `options` the DSN carries, dropping any conflicting token first
  (both the `-c name=value` and the `--name=value` form, and duplicates) and
  preserving unrelated ones. It is the store's guarantee rather than a default
  it offers, so a value written into `CONTROL_PLANE_DB` does not override it.
- **And it is read back.** `assertBoundsInEffect` asks the engine what it
  actually applied, before `Store.open` returns, and REFUSES to hand back a
  store if either answer is wrong. A provider that accepts `options` and
  ignores it looks exactly like one that honours it, right up to the incident;
  this is the difference between a stated bound and an enforced one.
- **TLS is DSN configuration.** `sslmode` goes in `CONTROL_PLANE_DB`, where
  `pg` reads it from the connection string like any other parameter. Prefer
  `verify-full` explicitly: pg 8.23 currently treats `require` as `verify-full`
  and warns that a future major will stop doing so, so leaving it at `require`
  is a certificate check that expires on somebody else's release schedule.
- **The DIRECT endpoint, not the pooled one - and the answer depends on the
  CHANNEL, which is why this paragraph has been measured twice.** As pool
  startup FIELDS, the two bounds were silently dropped by both endpoints: a
  pooled connection was accepted and reported neither bound, exactly as the
  direct one did. That is the reading behind the earlier note here, and it was
  a reading about a channel this build no longer uses. Through the `options`
  startup PARAMETER, which is the authoritative channel now, the two endpoints
  differ: the direct one accepts it and applies both bounds, and the pooled one
  REFUSES THE CONNECTION with SQLSTATE 08P01. Measured 2026-08-11, four
  connections with the same credentials against the same branch - direct plain
  connects, direct with `options` connects, pooled plain connects, pooled with
  `options` fails 08P01. So `Store.open` cannot open against the pooled
  endpoint at all, and it fails closed rather than running unbounded.
- **What bounds connections**, and why the direct endpoint is affordable: the
  web app holds ONE store per process with a pool capped at 4 and a 10s idle
  timeout, so a warm instance holds a handful of connections and an idle one
  holds none. Round trip Helsinki to Frankfurt is 26ms warm; a cold connect,
  TLS and first query together measured 764ms.
- **Nothing needs superuser, and nothing needs an extension.** `SCHEMA` and
  `LATE_INDEXES` contain `create table if not exists` and `create unique index
if not exists` and nothing else. Confirmed by running the bootstrap against
  the real production branch: it came up with no role, extension or system
  statement of any kind.
- **`synchronous_commit` is never turned off by this codebase**, in production
  or in a test container, because `create_intents` is the latch that stops us
  buying a box twice. That is a statement about our code; what a provider does
  with the setting is the provider's to state.
- **A serverless instance that is frozen and thawed can hold a dead
  connection.** The pool's error handler covers the idle case - the client is
  discarded and the next checkout makes a new one - but a query whose socket
  dies mid-flight fails that request. It is one failed request, which the
  caller must retry as a new HTTP request: nothing here retries it for them,
  and this document does not pretend the recovery is transparent.
- **The engine says which branch is answering.** `current_setting('neon.branch_id')`
  is present on every session and equals the id the Neon API reports for that
  branch.

### The connection posture, and the number it is stated as

The provisioner is one always-on machine, so "direct endpoint, small pool" is a
complete answer for it. A Vercel deployment is not one machine, and that turns
the same choice into a different question: the platform decides how many
instances exist, each one holds its own pool, and what the database sees is the
product of the two. A client-side pool cap bounds one factor and says nothing
about the other, which is how this section came to carry a dated FINDING
(R-2026-08-11-1) rather than an answer: the aggregate was ungoverned, and
nothing reserved any of the ceiling for the component that holds the keys.

**The finding is closed for the deployed tiers, and the enforcement is in the
engine.** Two login roles, each with a `rolconnlimit` the engine checks when a
backend is created (manager ruling R-2026-08-11-3):

```
web budget          40      cp_web, direct endpoint (deployed 2026-08-12)
provisioner budget  12      cp_provisioner, direct endpoint
deployed worst case 52      the sum, and nothing else
usable ceiling     894      max_connections 901 - superuser_reserved 7
unallocated        842
```

Every term is a catalog fact rather than a promise, and no term can borrow from
another - which is what makes the provisioner's twelve a RESERVE rather than an
expectation. The budgets are not predictions about how many processes will
exist: a budget is what the engine allows whatever the platform does, and that
is the whole difference between this posture and the one it replaces.

**Closed live, 2026-08-12** (supervised manual run, Nil at the keyboard): a
signed-in page load against the deployed site produced a `cp_web` backend on the
engine while the owner held zero, the owner DSN is deployed nowhere - it lives
only in the operator's secrets file - and both roles' live counts sat inside
their budgets (1 of 40, 1 of 12). R-2026-08-11-1 is closed on exactly that
evidence, and the run that produced it is recorded below under "What the
2026-08-12 moves completed".

Stated at the bar it was accepted at: these are SINGLE final observations,
not bounded series - the lingering pre-cutover owner backend had retired by
the final reading, and Nil accepted the readings at the supervised
manual-run bar. No P0 pre-flight battery, no environment-change
classification, no long sampling series and no rollback rehearsal ran;
rollback was never needed. The row evidence covers the four counted tables
(`accounts`, `name_reservations`, `instances`, `operations`); a full
every-table before/after comparison was not run.

**What the number does NOT cover, stated rather than implied.** Three facts,
all measured 2026-08-11, and the third follows from the first two:

- **The project's owner role cannot be capped.** `ALTER ROLE ... CONNECTION
LIMIT` against it is refused with 42501 from every identity available to us,
  including after `set role neon_superuser`. Locking it out instead - transfer
  the database to a capped role, revoke CONNECT from PUBLIC and the owner - was
  measured and rejected as UNENTERABLE rather than merely hard: no role is a
  member of the owner, no grant of it carries admin option, and creating that
  membership is refused 42501, so a transferred database could never be handed
  back. The owner is therefore MANUAL BREAK-GLASS, outside the aggregate: after
  the deployment rotation its DSN is deployed nowhere, and it is used for
  migrations, bootstrap and operator tooling only.
- **Two provider login roles already hold CONNECT on this database** and are
  Neon's rather than ours. No design of ours removes them, and no aggregate we
  state can include them.
- **So every aggregate claim here is a claim about the roles WE create.** That
  was true of every option considered, including the one that tried to cap the
  owner - which is why the narrowing is a change in what is CLAIMED rather than
  in what is enforced.

**894, not 901, and it is proved for one configuration.** Both endpoints report
`max_connections` 901 and `superuser_reserved_connections` 7, and every role
here is non-superuser. The reading was taken on the suites branch 2026-08-11
from a compute that had just COLD-STARTED at the minimum autoscaling size (the
API reported the endpoint inactive before the run), so it is the smallest
ceiling this configuration can present rather than the value at whatever size
happened to be serving - and `max_connections` is a postmaster setting that
cannot move while a compute runs. It follows the endpoint's autoscaling MAXIMUM,
so the number is proved for the 0.25-2 CU configuration measured on that date
and must be re-measured BEFORE any change to it, not after.

**The bounds moved to the role, and that is what made a pooler usable.** They
used to travel in the `options` startup parameter, which the pooled endpoint
refuses outright (SQLSTATE 08P01), so the standard way a serverless tier bounds
its connections was closed to this build. On the role they are delivered by both
endpoints - measured 2026-08-11, a fresh session with no `options` at all
reports `30s` for each through the direct endpoint AND through the pooler.

**A pooled web is proved on the suites branch; the DEPLOYED web is direct.**
Measured on the suites branch with a role capped at 10 before its first connection: 80
concurrent clients, 80 statements of four seconds each, ZERO failures, server
backends pinned at exactly 10, and 32 seconds of wall clock for 320 seconds of
work. The pooler queued inside the cap. Pooled CLIENT sessions are not charged
against `rolconnlimit` - server backends are - so the cap bounds the aggregate
without refusing clients, and a frozen Vercel instance holding a client session
costs the engine nothing. Uncapped, the same load opened 80 server backends and
held them: the pooler's own ceiling is at least 80 and is not a number this
posture leans on. THE CAP IS THE BOUND; the pooler is what turns exceeding it
into a queue instead of an error.

The deployment did not land there, and the reason is dated: during the
2026-08-12 cutover the artifact then serving was a pre-posture build whose store
still sent the `options` startup parameter, so its first pooled connection was
refused (08P01, measured live). The cutover completed on the DIRECT endpoint
with the current build, and every enforcement claim above - `rolconnlimit`,
role-delivered bounds, the aggregate - holds there identically. Moving the web
to the pooled endpoint stays available on these measurements and is its own
gated step; nothing has exercised the current build against the production
pooler.

One ordering fact that a rollback has to know: `rolconnlimit` is checked when a
backend is CREATED, so sessions that already exist are grandfathered. A cap
applied while more sessions than the budget are open leaves them running and
refuses the next one.

### Roles, and what each one may touch

Created in SQL, not through the Neon API. Measured 2026-08-11: an API-created
role arrives as a member of `neon_superuser` - owner-equivalent by construction -
and the project's own owner cannot ALTER it at all (42501 for both a connection
limit and a role SET), so it can carry neither half of the posture. A
SQL-created role arrives with zero memberships and is ours to govern.

`roles.ts` holds the matrix, and each entry names the caller that needs it. The
grants are per table and per verb, and the absences are the point:

- **Neither role may DELETE anything**, because nothing in this build deletes a
  row.
- **Neither role may run DDL.** A role with USAGE and full DML still cannot run
  `create table if not exists` on a table that ALREADY EXISTS - Postgres checks
  CREATE on the schema during parse analysis and never reaches the IF NOT EXISTS
  skip (measured 2026-08-11). That is why `Store.openRuntime` exists.
- **The web cannot reach the create latch** (`create_intents`), the table that
  stops a second box being bought for one intent.
- **The web may enqueue work but not drive it**: `insert` and `select` on
  `operations`, no `update`. Leasing, completing and re-driving belong to the
  provisioner, and that sentence is now a grant rather than a convention.
- **The web cannot read the billing event journal** (`stripe_events`).
- **Subscription state is read-only on the web tier.** The provisioner's
  reconciler is its only writer and writes from fetched Stripe truth, never from
  a delivery payload. The provisioner also claims delivery ids in
  `stripe_events` and reads the cancellation-policy cutover in `schema_meta`.
- **The provisioner is not granted `instances` INSERT or `name_reservations`
  INSERT**, because instance rows and reservations are created at signup.
- **The provisioner may UPDATE four `name_reservations` columns and no
  others**: `checkout_state`, `checkout_next_check_at`, `updated_at` and
  `version`, the columns the Checkout poll writes. A column grant is enough for
  the poll's `select ... for update`, which needs UPDATE on at least one
  column. `TableGrant.updateColumns` carries it, and the matrix read-backs
  (`matrixSql`, `effectivePrivilegeSql`) read column privileges as well as
  table ones.
- **The provisioner MAY READ `name_reservations`**, and that grant is a
  correction the live run forced (see below).

**The provisioner's matrix is EXACT, and a test says so in both directions.**
`PROVISIONER_REACHABLE` in `roles.ts` is the audited call graph of the deployed
command - every verb, with the line that issues it - and
`provisionerMatrixAgainstReachable` compares it against the matrix at
table-and-verb precision. MISSING is a 42501 waiting on a live path; EXCESS is a
grant nobody can reach, which is a boundary saying something untrue about what
the machine can do. The weaker question - "is everything the code touches
granted" - can only ever find the first kind, and it is what let the matrix be
wrong in both directions at once:

| verb                       | audited 2026-08-12                                      |
| -------------------------- | ------------------------------------------------------- |
| `name_reservations` SELECT | ADDED - the invite seam proves tenant ownership from it |
| `accounts` SELECT          | removed - only signup and the operator check read it    |
| `subscriptions` SELECT     | removed - the lifecycle tick is not on this command     |
| `provider_assets` INSERT   | removed - signup always creates the placeholder asset   |
| `create_intents` UPDATE    | restored 2026-08-21 - automatic create records outcomes |

**Added 2026-10-08:** UPDATE on four `name_reservations` columns. The Checkout
poll (2026-08-23) writes them, and the matrix did not grant them: production
answered 42501 on every poll pass, and the poll retried every 5 s instead of
every 60 s. The pin below missed it because it read only `cmdRun`'s own body.

**Reversed 2026-08-16:** `subscriptions` SELECT is required again because the
deployed command now runs the lifecycle cadence.

**Automatic provisioning is wired as of 2026-08-21.** A reconciled paid
Checkout opens `create_instance` on the existing signup instance. The deployed
cadence also scans linked active subscriptions and opens missing creates from
the same gate. That scan repairs ignored or out-of-order local reconciliation;
it cannot repair a subscription for which no Stripe event ever created a local
row. Stripe event identity and the permanent create-row check prevent replay
from buying a second box.

**And the audit's PREMISE is pinned too, not just its conclusion.** A verb list
is a claim about a particular set of registered handlers and a particular set of
non-handler surfaces, and it cannot state that set itself. So the roster moved
out of an array literal inside `cli.ts` into `run-roster.ts` - the function
`makeTicker` actually calls - and `cmdrun-reachability.test.ts` builds the REAL
roster and requires every kind in it to be audited. The non-handler surfaces are
read from `cli.ts` as text (importing it runs `main()`), and the set of names
`cmdRun` calls must equal `AUDITED_CMDRUN_SURFACES`. Since 2026-10-08 the test
also follows every `cli.ts` function `cmdRun` reaches, and each one's calls must
equal its entry in `AUDITED_CMDRUN_HELPER_SURFACES`. A handler or a surface
added without an audit entry fails a test; `startMintSeam` is why the second
half matters, because the verb the 2026-08-12 run was refused is reached from a
surface rather than from a handler.

No `ALTER DEFAULT PRIVILEGES`. Default privileges can only say "every future
table, these verbs", which cannot mirror a per-table matrix and would grant on
tables nobody has reviewed. The statement list in `roles.ts` is the one place a
table's grants are decided, and it is re-run after any migration that adds a
table - so a table nobody granted is a 42501 inside a gated step rather than a
silent widening.

**It CONVERGES rather than being merely idempotent, and the difference is the
whole point.** `GRANT` only ever adds, so re-running a narrowed matrix would
leave the wider privilege standing in the catalog while this repo's tests went
on asserting it was absent - a boundary that exists in prose and not in the
database. So each role's privileges are REVOKED first and then granted exactly,
and its role configuration is `RESET ALL` before the two bounds are set. The
same applies to the read-back: the live check compares the actual per-table,
per-verb matrix and reports EXCESS as well as missing, because excess is the
direction a floor-shaped posture drifts in. The owner is deliberately not
converged - its configuration may carry provider or operator settings this build
did not put there, so a governance run REFUSES BEFORE MUTATING if it finds
anything outside "empty, or exactly our pair".

### Where a session's bounds come from, and what refuses

`Store` still refuses to hand back a handle unless both bounds are in effect.
What moved is where they come from, and the route is read from the ENGINE rather
than from any caller:

- **A managed session says so itself.** `neon.branch_id` is present on every
  session of the managed engine and on nothing else. On that path the bounds
  MUST come from the role: `rolconfig` has to carry exactly the governed pair
  and the engine has to report both. THERE IS NO FALLBACK THERE, and the absence
  is the point - a fallback would answer a reverted `ALTER ROLE` by quietly
  reinstating the client-side mechanism, and nothing would look wrong.
- **Everywhere else** - a local container, CI - the older mechanism is
  unchanged: if the bounds are already in effect the session is kept, and
  otherwise the pool is rebuilt with `withGovernedOptions` and the answer is
  read back. A contributor's `bun test` needs no setup it did not need before.
- The first connection is READ ONLY either way, and it is the only session that
  exists before the bounds are proved.

`store-governance.test.ts` holds the cases, and the one that matters is the last:
a role whose configuration was reverted, on a connection string that still asks
for both bounds the old way, REFUSES - the session would have reported the right
answer, and the deployment would have looked healthy while the guarantee had
stopped being true.

**The open-time schema check reads `pg_class`, not `information_schema`, and
that is a posture fix.** `information_schema` shows a role only the objects it
holds a privilege on: measured 2026-08-12 on Postgres 18, a role with NO
privilege on a table sees ZERO of its columns there while `pg_class` /
`pg_attribute` show all of them and a SELECT is still refused 42501. The check
therefore used to be silently VOID on exactly the deployment it exists for - a
least-privileged runtime role skipped every table outside its own matrix,
`stripe_events` included, because "zero columns" was read as "not this build's
table". The same clause hid a worse case for every caller: a MISSING TABLE also
answers zero columns, so it passed. The catalog read cannot express either: EVERY
table in the product roster must be there, must be an ordinary table rather than
a view wearing the name, must resolve to exactly one relation in
`current_schema()`, and every required column must be a live one. Missing,
ambiguous or unreadable all refuse.

**Existence is asked of the whole roster, not of the tables with version
columns.** The required-COLUMN list names five tables; asking only about those
would leave eight - `name_reservations` among them - able to be absent while a
runtime process booted cleanly and failed at first use, which is the exact shape
of the 2026-08-12 incident. The roster is `PRODUCT_TABLES` in `store.ts`, and
`bootstrap.ts` re-exports it as `EXPECTED_TABLES` rather than keeping a second
copy: the open-time check, the bootstrap evidence and the grant sweeps all read
one list.
`store-schema-check.test.ts` holds the cases and runs them as a least-privileged
role, because the owner would pass either implementation.

**Two entry points, and only one of them builds a database.** `Store.open` runs
the schema statements, the catalog check, the late indexes and the audit seed:
it is the bootstrap and operator path, and it is what every test and exercise
uses. `Store.openRuntime` proves the bounds, checks the catalog and ASSERTS the
audit seed exists - it writes nothing at all. The web tier and the provisioner's
tick loop are its only two callers. A runtime process no longer migrates the
database it connects to, and one that finds an unbootstrapped database fails at
boot instead of quietly building itself.

### What the web deployment may carry

The boundary is worth stating precisely, because the web app plainly DOES hold
credentials: a Production database DSN, its own `AUTH_SECRET`, Google's client
secret, and the provisioner's bearer. What it holds none of is
INFRASTRUCTURE-PROVIDER credentials or provisioning key material - no Contabo
credential. It can talk to its own database and ask the provisioner for something;
it cannot create, destroy or reach a customer's box, and it holds nothing that
would let it. That is the whole reason the provisioner exists.

### Which database a test may touch

Loop ruling 4: suites and transcripts never write to production, and production
receives SCHEMA ONLY - no test row, ever. `testing/target.ts` is called by
`testing/pg.ts` before the first schema is acquired and by
`e2e/production-server.e2e.ts` before it seeds anything, and it accepts only
`LOCAL_DATABASE_URL`, the throwaway Postgres on 5433. Any other database
refuses, so pointing `CONTROL_PLANE_DB` at production and running `bun test`
is refused by the harness itself. There is no flag that skips it.

Until 2026-10-15 a Neon child branch (`suites`) was the other allowed target,
proved by the engine's `neon.branch_id`, and `exercises/neon.ts` managed the
branches. Both were removed with Neon.

### Bootstrapping a database, and the two booleans

`bun control-plane/cli.ts bootstrap` brings the database named by
`CONTROL_PLANE_DB` to schema-ready and reports what it did:

```
schema-ready: true
zero-user-data: true
  accounts: 0 rows
  ...
```

The procedure is THREE steps in the one order that works: the ROLES (created and
governed, naming no table), then the SCHEMA built by the owner, then the GRANTS.
Each half of the posture is one transaction. The order is forced from both ends -
on a managed engine the store refuses to open unless the connecting role already
carries the governed bounds, so role configuration cannot go through the store;
and a grant names a table, so it cannot run before the tables exist. An earlier
version put the grants first and worked everywhere the schema already existed,
which was every database anybody had run it against. If the schema step fails,
the roles created by the first step are left behind - NOLOGIN, with no grants and
no password, so they can reach nothing - and that residue is disclosed rather
than cleaned up, because a rollback that dropped roles an earlier successful run
had created would be worse than the residue. What the command adds is evidence produced by
the same run that did the work, and a refusal to exit zero if either boolean is
false. It deliberately does NOT go through `cli.ts`'s
`openStore`, which also imports this box's legacy intent journal - a bootstrap
that carried an operator's local intent files into a customer database would be
putting rows there that ruling 4 forbids.

Row counts are CONTENTS evidence and are not offered as identity evidence: an
empty database says nothing about WHICH database it is. That proof belongs to
the operator who names the database.

### Checking a restored copy

`restore-check.ts fingerprint` reads `CONTROL_PLANE_DB` (the owner's string) in
a read-only transaction and prints, per table: the columns by name, type,
nullability and default in order, the row count and a content hash; then
sequence state, constraints and indexes. Run it on the source and on the
restored target, and then `compare` the two files; it names each difference
and exits non-zero. It never compares raw `attnum`: pg_restore drops the gaps
that dropped columns leave. The `database_identity` row is left out of the
hash, so a target that already has its own identity still compares equal.

### The store API is Promise-based, and the engine handle is private

Every method that reaches the database returns a promise, readers included, and
`Store.open` replaces `new Store`, because a pool cannot be opened in a
constructor. `now()` and `inTransaction()` stay synchronous, because neither
reaches the database.

`pool` is private. The handful of callers whose SQL does not fit a typed method -
the create latch's INSERT, the name reservation, the billing tables - go through
`sqlAll` / `sqlGet` / `sqlRun`, which carry the SQL text verbatim. The names are
deliberately ugly so `grep 'sql[A-Z]'` finds every one of them, and the web app's
boundary test forbids them outright. `tx` issues its own `begin`, `commit` and
`rollback` through `sqlRun` like everything else, so a test that needs to make a
COMMIT fail has one seam to patch rather than a private path it cannot reach.

`close()` is idempotent: a second close is a no-op, where the engine handle used
to throw. Only a close after a SUCCESSFUL one is silent - a first close that
fails is reported.

### A transaction owns its connection

`tx` checks a connection out of the pool for the body's whole life, and the
frame travels in async context - so every statement the body issues lands inside
those `begin`/`commit` brackets and inside no others, without a handle the caller
has to thread through. That is what makes the transaction boundary comments in
`store.ts` true ON THE WIRE rather than true by convention, and it is why the
previous engine's caller rule - _a transaction body may await only store calls,
never remote I/O and never a timer_ - is gone. A body that waits now holds one
connection out of the pool, which is a cost rather than a correctness problem.

Two consequences the tests pin with the engine's own answer, by reading
`pg_backend_pid()` from inside the bodies:

- **Concurrent transactions are no longer an error.** Two overlapping flows take
  a connection each and commit independently. The single-connection engine could
  not tell that case from nesting and refused both.
- **Nesting still throws.** A `tx` opened inside another one, across an await or
  not, is a programming error: every money and attention invariant here is stated
  as "these statements commit together", and a nested call would quietly widen
  someone else's boundary. A transaction on a DIFFERENT store is not nesting and
  is allowed - it is a second database on a second connection, and it cannot
  widen this one's boundary.

### A failed statement takes the transaction, unless somebody said otherwise

Postgres aborts the whole transaction on any statement error: every later
statement answers 25P02 until a rollback. Two rules here are built on the
opposite behaviour - the name reservation, where the INSERT IS the uniqueness
decision and the conflicting row is read back inside the same transaction, and
the one-active operation index, where a refusal becomes a customer-facing
"already in progress". `store.recoverable(fn)` wraps those in a savepoint:
release on success, rollback-to and release on failure, and the ORIGINAL error
rethrown. If the rollback itself cannot run, the connection is discarded rather
than returned to the pool and the transaction is failed, because at that point
nobody can say what state it is in.

It is used at exactly four sites - the reservation insert and the three
dashboard operation opens - and it is deliberately not the default. Making every
statement implicitly savepointed would make "this failure is expected" the
assumption, and the failures that are not expected are the ones that must take
the transaction down with them.

That leaves one quiet failure class, and it is closed separately: **a COMMIT
issued on an aborted transaction SUCCEEDS and commits nothing** - Postgres
answers it with the command tag ROLLBACK. A body that caught a statement error
and returned normally would otherwise be told its writes landed. The store reads
that tag where every statement passes and fails the transaction, so the caller
gets an error instead of a false receipt.

Isolation is READ COMMITTED, argued from the one-statement arbiters rather than
assumed: every mutation is a single UPDATE or INSERT carrying its own predicate,
so a loser sees the winner's row once the lock releases and its predicate no
longer matches. Nothing needs a stable snapshot ACROSS statements - every "these
commit together" here is about atomicity, not isolation. `statement_timeout` and
`idle_in_transaction_session_timeout` are both 30s: measured statements run in
under a millisecond, so those bound a wedged row lock and a holder that died with
`begin` open, not slow SQL.

The slice-1 audit JSONL is still written, as a post-commit mirror. It is not half
of a state transition: an attention raise and its `audit_events` row commit
together, and a failure there fails the tick loudly rather than persisting one
without the other.

### The create latch moved into the schema

A successful INSERT into `create_intents` permits only its returning call stack
to issue one call; the persisted row permanently forbids all later calls. The
intent INSERT and the fenced CAS of the operation's evidence to
`create_call_armed` commit TOGETHER, so "latched but nobody knows which operation
owns it" cannot exist, and a stale fence rolls the intent back - correct, because
nothing was sent. On commit the latch mints a `CreatePermit` into the caller's
stack frame: not serialisable, never stored, consumed before the await. A crash
loses it permanently, which is what makes restart recovery find-only by
construction rather than by a check somebody could forget.

Slice 1's O_EXCL journal is retained as VETO-ONLY evidence. It is imported into
the schema on open - a corrupt file still forbids, using the id from its
filename; an unrecognised state imports as `ambiguous` rather than being trusted,
because a legacy file is bytes on disk and the column's type is a claim about our
own writes; a directory that cannot be enumerated refuses to open the store at
all. It is never deleted or rewritten, and it can only ever refuse a create.

## Deployed: the web app on Vercel

The storefront ran on Vercel against Neon until the move to the Docker host
(see "Deployed: Hosted Isomux on one Docker host"). Vercel was retired
2026-10-06 and Neon was deleted 2026-10-15, so no rollback is left. The deploy
programs (`deploy/*-phase.ts`, `deploy/vercel-*.ts`, the artifact builder and
the two probes under `web/e2e/`) were removed on 2026-10-15. Git history keeps
them. `deploy/vercel-root/` stays: the storefront image installs from it.

## Deployed: the provisioner

The provisioner ran on Fly.io as the app `isomux-provisioner` until the move to
the Docker host (see "Deployed: Hosted Isomux on one Docker host"). The Fly app
was destroyed in 2026-10, and its deploy programs, `deploy/fly.toml` and the
certificate forwarder were removed from the repository. Git history keeps them.
The subsections below hold for the provisioner on any host.

### The image, and why it has a manifest of its own

`control-plane/deploy/Dockerfile` builds from the repository root and installs
`control-plane/deploy/package.json`, which names ONE dependency. The
provisioner's only runtime dependency is `pg`; the repository's manifest also
carries a UI, an agent SDK and a native terminal, and a machine that holds
provider credentials has no business running any of them.

The manifest is installed at `/app`, an ANCESTOR of `/app/control-plane`, so
every import inside the control plane resolves up into it - measured
2026-08-11: an import from below `control-plane/` resolves to
`/app/node_modules/pg`. Nothing is installed under `control-plane/deploy/`.
The price of a second manifest is drift, and `deploy/image.test.ts` is what
stops it: the two `pg` specs must be identical or the suite fails.

`/.dockerignore` denies everything and then names what the provisioner is made
of. The allowlist includes `deploy/install.sh`, which the provisioner uploads
to each new customer box. The image build runs `deploy/assert-runtime-files.ts`
against `/app`, so a missing payload stops the build at its deployed path.
That is not tidiness: `control-plane/` is 903 MB, of which
`control-plane/web` is 901 MB, and `COPY control-plane` would otherwise ship a
Next.js app into the machine holding the keys. The same test holds the intent of
those rules, and a build whose reported context is not about 2 MB means they
stopped working.

### What the machine proves about itself

At boot, before it serves or ticks:

- **The bounds.** `Store.open` returning IS the evidence - it built the
  `options` string and read both timeouts back from the engine, and refuses to
  return a store otherwise.
- **The database identity.** The database owner writes one row, `schema_meta`
  key `database_identity`, with `cli.ts set-database-identity`, which refuses
  a role that does not own `schema_meta`. `boot.ts` requires it to equal
  `CONTROL_PLANE_DB_IDENTITY` and REFUSES to start on a missing row, a
  different value, or a session role that can write `schema_meta`, per table
  or per column. `cp_web` and `cp_provisioner` can only read it. The web app
  runs the same proof when the variable is set. Unset means no claim was made,
  so `database_identity` is false rather than true, and a deployment that lost
  its value is visibly not ok.

  A restored copy carries its source's row. Write the target's own value after
  the restore check and before any runtime points at it.

Neither identity value is ever printed. The boot line is booleans.

`GET /internal/health` answers the same booleans and the running release's
identity, behind the SAME bearer as the invite verb. `deploy/vps/deploy.sh`
reads it inside the container after each deploy:

```
ok  bounds_governed  database_identity  database_reachable  tick_recent  state_persisted  provider_configured
```

The release identity has three independent arms. `release_source` names the
40-hex commit and the deploy-start time that `deploy.sh` passes as build
arguments. `release_payload` names a SHA-256 that every image computes
inside the Dockerfile from the files actually installed in `/app`.
`release_deployment` names the id that `deploy.sh` generates and the
`--deployment` flag carries. Each arm is
either `{ known: true, ... }` with a strictly validated value or
`{ known: false }` with no placeholder value. A missing or damaged identity
file therefore makes no claim rather than returning an empty or default-looking
string.

None of the three identity arms enters `ok`. An unknown identity does not stop
the process from provisioning an office; it stops an operator from claiming
which build is running.

`ok` is the conjunction of the five readiness properties - not of every
reported field, because
`state_persisted` is correctly false on a first deploy and a healthy machine
must not be reported sick for having been deployed once, and
`provider_configured` is a state the design deliberately supports: a provisioner
with no provider credentials idles correctly, and D2 measured it doing so for 37
minutes. That boolean is REPORTED so an operator can see it, and asserted at the
gate that puts the credentials there (D4, 2026-08-12), rather than folded into
`ok` where a deliberate state would read as a fault.

`provider_configured` is answered by the ticker - it asks whether the
provider-dependent handlers are registered in the roster it actually built -
rather than by re-reading the environment beside it. A second derivation of the
same answer is a copy that can drift, which is the class of omission
`run-roster.ts` was extracted to prevent. `database_reachable` is
a `select 1` whose failure discards the error object entirely. `tick_recent`
means the drive loop's one-row schedule read succeeded within three idle
intervals. That statement reaches every work table, so it distinguishes "the
port answers" from "the drive loop can read its work" without marking a healthy
idle process stale. A missing `subscriptions` grant does not break `select 1`;
it does stop the schedule read from refreshing `tick_recent`.
`cadence_healthy` is separate: it stays true while no cadence pass is due,
resets on a successful pass, and turns false after three consecutive attempted
passes fail. `ok` requires both readings.

After one startup pass, an idle provisioner runs one scheduling statement at a
60-second ceiling. That row names the independent due classes and their next
actionable timestamp: claimable operations/provider reconciliation, lifecycle
work (including missed-webhook Checkout recovery), liveness, and a silent
provisioning-stall check. Only due classes run. A committed Stripe event also
wakes the in-process loop, so paid provisioning does not wait behind the idle
ceiling; a missed wake falls back to the durable scheduling row. Claimable
operation work retains the five-second cadence, and handler step retries remain
five seconds. As designed 2026-08-27, a fully idle interval is one query; due
liveness still carries its existing instance scan and certificate-contact
reads.

The route ALWAYS answers 200 while the process is serving. A database that
blinked is a boolean, not a dead process, so an outage upstream cannot turn
health into a restart loop.

### The state marker

Proving the volume works needs more than a directory: a fresh filesystem
recreates the state root the moment the store opens it. So `state-marker.ts`
writes a file naming the deployment that wrote it, and `state_persisted` means
THE MARKER was there - something no image can recreate. The boot line also
reports `marker-crossed-release`, which is true only when the marker named a
different release, and that is the one that discriminates a redeploy from a
restart.

Two rules about that write, and both are about not lying:

- **A failed refresh REFUSES TO BOOT**, with a fixed sentence that quotes
  nothing it read. Reporting "the state survived" from a marker this release
  could not rewrite would be evidence about the LAST deployment presented as
  evidence about this one - and a state root that cannot be written is not a key
  master at all, it is a machine that will fail the first time a run needs to
  store a private key.
- **The rewrite is atomic**: temp file, then rename, with the temp removed if
  the rename fails. A write interrupted halfway would otherwise destroy the
  proof of the last deploy in the act of recording the current one.

### Converging the runtime grants on every redeploy

`regovern` (`convergeMatrix` in `bootstrap.ts`) brings the runtime grants of a
deployed database to exactly this build's matrix. `deploy.sh` runs it on every
redeploy, after `migrate-all` (a grant names a table a migration may add) and
while the previous release still serves. A refusal fails the deploy before any
app container is replaced. The deploy log gets each privilege it granted or
revoked, as `<role> <table> <verb>` or `<role> <table> update(<column>)`.

It accepts any before-matrix: two matrix changes between deploys, a reverted
change, a deploy of an older commit and a restored older dump all converge. A
privilege granted by hand and not in `roles.ts` is revoked at the next deploy.
When the catalog already holds exactly the matrix, it writes nothing.

To remove a grant, follow the migration rule: stop using it in one deploy and
remove it from the matrix in a later one. The previous release still serves
while the grants converge, and the deploy's rollback does not grant anything
back.

`bootstrap` is not this step: it creates the roles, and its preflight refuses
runtime roles that can log in. A deployed database has both.

**One exemption, measured on the provider rather than reasoned about.** Both
runtime roles have the OWNER as a member, with admin option, and that is not a
third party: Postgres 16+ grants a NON-SUPERUSER creator ADMIN OPTION in the
role it creates, and Neon's owner is not a superuser. The local container's
owner IS one and records no such row, so no rehearsal here could have seen it -
it was found by the pre-live probe (Neon suites branch AND production, both
2026-08-12: one member each, the owner, with admin option, `belongs_to` and
every ownership count zero). Left unexempted, `residueIsInert` was false for
both roles and every governance step refused before it started.

So `roleIdentitySql` counts `members_other_than_owner` and the predicate uses
that; `members_of_it` is still read and still reported. The exemption grants
nothing - the owner already owns every table the matrix names, and the
membership is what lets a non-superuser owner ALTER or DROP the role it
created - and it is ONE-DIRECTIONAL: `belongs_to`, our role being a member of
something else, stays zero-tolerance. A member that is not the owner still
refuses. `governance-converge.test.ts` stages the condition on a real engine by
having a non-superuser CREATEROLE role create a role, and asserts the same row
reads as inert from the creator's session and as a third party from anyone
else's.

It refuses BEFORE writing unless: the owner already carries exactly the governed
bounds, neither runtime role belongs to a role, has a member other than the
owner or owns anything (LOGIN and live sessions are expected), their budgets,
bounds and memberships are exactly the approved posture, PUBLIC holds nothing
on this build's tables, and neither role holds anything outside the table
matrix: schema USAGE without CREATE, and no privilege on any sequence. That
last pair is the class a matrix read cannot see: a role that can CREATE on the
schema can make a table this matrix has never heard of. Such a drift stops the
deploy, because the matrix cannot describe it.

It then applies the matrix in ONE transaction and reads back the WHOLE posture
rather than the half it moved - direct and effective matrices, schema
privileges, sequence privileges, memberships and logins. Acceptance that only
re-read what it wrote could not see a transaction that did more than it meant
to. Any false claim is a non-zero exit.

**The pre-live predicate closed 2026-08-12**, a provider question answered by
measurement rather than argument:

- Catalog visibility: Neon reports the same shape the local Postgres 18
  measured - 0 rows for the invisible class, all rows for the visible one,
  42501 where refusal was expected - so the schema-check change holds on the
  provider it was written for.

## Deployed: Hosted Isomux on one Docker host

`deploy/vps/` runs the storefront, the provisioner and their PostgreSQL 18.6 as
one Compose project on a plain Linux host with Docker. The project shares no
network, volume or env file with other projects on the host. The Vercel path
above stays only for a rollback.

```
control-plane/deploy/vps/deploy.sh <commit>            # on the host, from a clone that has the commit
control-plane/deploy/vps/deploy.sh --prepare <commit>  # a first install that starts no app, for a move
control-plane/deploy/vps/restore.sh <dump> <fingerprint>  # the old database into a prepared install
control-plane/deploy/vps/local-proof.sh <commit>       # the same, on throwaway names, then torn down
control-plane/deploy/vps/auto-deploy.sh                # one run of the deploy from main (below); the timer runs it
```

`deploy.sh` builds from `git archive <commit>`, never from the working tree, in
a BuildKit builder capped at 3 GiB and 2 CPUs (a scope around `docker build`
does not cap it: the daemon does the build). Both images carry the commit as
their `org.opencontainers.image.revision` label, and the provisioner also bakes
it into `release-identity.json`, so `/internal/health` reports it. The
script then runs every owner migration with the new image, starts the services
and proves: each running container's image is
the one it built, with the commit's label; health is `ok` with
`database_identity` true at that commit; the storefront home page answers 200;
the database publishes no port. It keeps the release before this one, for a
rollback, and removes older images and release trees. When a step fails after
it starts to replace the running release, it puts the previous release back
(see "Deploying from main").

| Service     | Image                                 | Networks | Published      | Ceiling          |
| ----------- | ------------------------------------- | -------- | -------------- | ---------------- |
| db          | `postgres:18.6`, pinned by digest     | db       | none           | 1.0 CPU, 2 GiB   |
| provisioner | `deploy/Dockerfile`                   | db, edge | 127.0.0.1:4311 | 0.5 CPU, 512 MiB |
| web         | `deploy/vps/web.Dockerfile` (Node 24) | db, edge | 127.0.0.1:3100 | 0.5 CPU, 768 MiB |
| owner       | `deploy/Dockerfile`, profile `owner`  | db       | none           | 0.5 CPU, 512 MiB |

The `db` network is internal. The storefront reaches the seam at
`http://provisioner:4311` on the project network. `owner` runs only as
`docker compose ... run --rm owner bun control-plane/cli.ts <command>` and gets
only the owner's DSN: no provider or Stripe values and no state volume. The
provisioner state root is the named volume `provisioner-state` at `/data`.
Containers restart with the Docker daemon, so the host needs no
unit of its own.

The provisioner and web use Docker's `journald` log driver. The tags are
`<compose project>-provisioner` and `<compose project>-web`; container replacement
does not remove their journal entries. `docker logs` and `docker compose logs`
still read the current containers. Use `journalctl` by tag to read across deploys.
The reader needs root or membership in `systemd-journal` or `adm`.

Retention belongs to the host journal, not Compose. Checked 2026-10-11: the
deployed host has persistent storage, `MaxRetentionSec=7day`,
`MaxFileSec=1day`, `SystemMaxUse=1G`, and `RuntimeMaxUse=100M`. Journald
deletes whole files, so without `MaxFileSec` one file can span the whole week
and go at once. With daily files it keeps about a week and drops one day at a
time, less if the host journal reaches 1 GiB first. These limits cover all host services.
The deployment script does not change journal settings or reader access.

The host layout, with the defaults that `ISOMUX_HOSTED_PROJECT`,
`ISOMUX_HOSTED_ENV_DIR`, `ISOMUX_HOSTED_ROOT`, `ISOMUX_HOSTED_WEB_PORT` and
`ISOMUX_HOSTED_PROVISIONER_PORT` change:

```
/etc/isomux-hosted/              0700, owned by the deploying user (root on a host)
  web.env, provisioner.env       0600, written by the operator from deploy/vps/*.env.example
  auto-deploy.env                0600, the clone and the GitHub repository for the deploy from main
  auto-deploy.hold               present: the deploy from main does nothing
  generated/                     0700, written by deploy.sh on the first install only
    db.env                       the superuser password, used only through the container socket
    owner-db.env, web-db.env, provisioner-db.env
                                 CONTROL_PLANE_DB for cp_owner, cp_web, cp_provisioner, and CONTROL_PLANE_DB_IDENTITY
    seam.env                     CONTROL_PLANE_MINT_TOKEN, for the storefront and the provisioner
    installed                    written last, when the first install is complete
/opt/isomux-hosted/
  releases/<commit>/             the archived tree; compose.yaml runs from it
  current -> releases/<commit>
  release.env                    the image tags, deployment id and ports compose.yaml interpolates; no secret
  release.env.previous           the release.env a deploy replaced, for its rollback
  auto-deploy/                   status.json, the failed list and the stopped marker of the deploy from main
  deploy-<time>.log              build and Compose output, which can hold a database error
  restore-<time>.log             restore.sh's database output, which can quote a row
```

**The first install** is the run that finds neither `generated/` nor the
database volume. It generates every password, the identity and the seam token
(random hex), creates `cp_owner` (login, `CREATEROLE`, not a superuser) and the
`isomux` database it owns, runs `bootstrap` as `cp_owner`, gives `cp_web` and
`cp_provisioner` their logins (after bootstrap, whose preflight refuses runtime
roles that can log in), and stamps the identity with `set-database-identity`.
Every later run builds, runs the owner migrations, converges the runtime grants
(`regovern`, see "Converging the runtime grants on every redeploy"), replaces
the two app containers and checks them. It never bootstraps, creates a role,
changes a login, resets a password or stamps the identity. A
restored database carries its source's identity row, and `restore.sh` stamps
this install's over it.

`--prepare` does the first install and stops before the provisioner and the
storefront start. It creates the state volume empty and writes `installed` and
`generated/prepared`. It refuses when any part of an install exists. The next
run without it starts the apps; it does not require `state_persisted` on that
first start, and removes `prepared` once health passes.

The install is `generated/` and the two named volumes together: `pgdata` and
`provisioner-state`, which holds the keys that revoke our access, the intent
records and the ACME account. Any other state refuses before it builds or
creates anything. Exit 4: a part is missing, for example a volume without
`generated/` (credentials are never regenerated for existing volumes) or
`generated/` and the database without the state volume (no empty volume is
created in place of a lost one). Exit 3: all three exist but `installed` does
not, so the first install did not finish; the database can hold data, so
inspect it before you change anything. A redeploy also requires health to
report `state_persisted` true. The operator never types a database password or
the seam token, and no value goes on a command line, into an image or into the
transcript.

Every deploy unpacks the commit again into `releases/<commit>`, so a tree
changed on the host after an earlier deploy never reaches a build labelled with
the commit.

**Live Stripe.** `stripe/mode.ts` accepts live mode in two production
runtimes: Vercel production and `ISOMUX_PRODUCTION_RUNTIME=vps`, which only
`deploy/vps/compose.yaml` sets.

**Caddy.** `deploy/vps/hosted.caddy.example` holds the two site blocks with
example hostnames, to drop beside the host's Caddyfile. The storefront block
sets X-Forwarded-For to the client address Caddy resolved; the storefront's
per-address limits on sign-in and checkout start (`web/lib/rate-limit.server.ts`)
key on it. Behind a CDN proxy, the host's global options must trust the CDN's
ranges, or every visitor shares the CDN's addresses. The provisioner block
passes only `/stripe/webhook` and the two `/internal/certificates/*` paths that
customer offices call. Set `ISOMUX_CERTIFICATE_ENDPOINT` in `provisioner.env` to
the public renew URL. New offices are enrolled with it, and every renew answer
carries it, which moves an office enrolled with an older URL (see "Moving
offices to a new renewal URL").

**The local proof** (`local-proof.sh`) deploys the commit with synthetic
values: Stripe test mode, the staging certificate target, no provider account.
Before the first run it checks that a leftover state volume blocks a first
install. It installs the way a move does: `--prepare`, which must create no app
container and leave the state volume empty, and must refuse a second time; a
restore of a dump whose column order differs from the bootstrap's, which must
keep that order and stamp the install's identity, after a cut dump that must
fail and change nothing; a state import with one latched intent, which must
refuse a second time; a normal run, whose provisioner must hold the imported
latch in `create_intents`, and after which a restore refuses. Then it
checks each container's ceilings as Docker applied them, that the unfinished and
the incomplete install refuse without a build, and it changes the cached release
tree and redeploys. After the redeploy it checks that
the identity, the generated credentials, a row and a state-volume file written
between the runs are unchanged, that both images hold the commit's bytes and
not the changed tree's, that the previous release is kept and an older one is
pruned. Auto-deploy ticks from a local origin then deploy a commit whose
provisioner needs its new migration, and roll back three: a provisioner that
cannot start, a second migration that fails (the running containers stay), and
a migration followed by a provisioner that cannot start. After each rollback
the previous release reads and writes the migrated schema. Last, a missing
state volume must refuse without a build or a new volume, and teardown must
leave no container, volume, network, image, builder or file. Measured 2026-10-07 on the office box: about
27 minutes, most of it the image builds.

### Deploying from main

A commit on `main` that changes what Hosted runs deploys itself.
`isomux-hosted-autodeploy.timer` starts `auto-deploy.sh` as root five minutes
after the last run ends. The script runs from the release that last passed
(`/opt/isomux-hosted/current`). One run:

1. Fetches `main` from the public repository into the clone named in
   `/etc/isomux-hosted/auto-deploy.env`, with no credential.
2. Picks T: the newest commit on `main` after the deployed commit D (in `main`'s
   ancestry, not by run time) whose GitHub Build is green. A green Build is the
   newest `build.yml` run for a push to `main` with that head commit, completed
   with `success`. The script reads up to three pages of 100 runs from the
   public API, with no token, inside the provisioner image.
3. Deploys T only when `git diff --no-renames D T` touches a Hosted input: any
   path under `control-plane/`, `deploy/install.sh` or the root `.dockerignore`.
   T's own `deploy.sh` does the deploy, under the deploy lock that
   `auto-deploy.sh` holds for the whole run. A manual `deploy.sh` meanwhile
   refuses.
4. Checks which commit runs healthy, with the check from the release that
   started the run (its physical directory, not the `current` link), and writes
   `/opt/isomux-hosted/auto-deploy/status.json`.

**A failed deploy.** When `deploy.sh` fails after it starts to replace the
running release, it puts the previous release back: the provisioner and the
storefront only, never the database. It then checks that the previous release
serves, and exits 5. There is a gap while the containers are replaced.
`auto-deploy.sh` marks T failed and never deploys it again; a newer green
commit can deploy. A failure before the replacement, such as a build, is tried
on two more runs before T is marked. When the previous release does not serve
after a failure, `auto-deploy.sh` writes `auto-deploy/stopped` and deploys
nothing until an operator recovers the host and deletes that file.

**It deploys nothing** when the fetch or the API read fails (`tick_error`;
no commit is marked), when D is not on `main`, when T changes
`control-plane/deploy/vps/compose.yaml` (deploy it by hand), while
`/etc/isomux-hosted/auto-deploy.hold` exists, while another deploy holds the
lock, and on an install that `--prepare` left or that did not finish.

**Migrations.** Before it replaces the running release, `deploy.sh` runs
`bun control-plane/cli.ts migrate-all` with the new image, while the previous
release still serves. It runs every `migrate-*` command in the order of
`OWNER_MIGRATIONS` in `bootstrap.ts`; a new migration is an entry there. A
failed migration rolls back like any other failure, and the migrations before
it stay applied. A migration that waits more than 5 s to acquire a table lock
fails.

**Compatibility.** A rollback restores the app images, not the data. The
previous release runs on the migrated schema during the deploy and after a
rollback, so every migration must keep the previous release reading and
writing correctly: change the schema additively, and remove the old shape only
in a later release (expand, then contract). Every deploy runs every migration
again, so each one must be idempotent. For a migration that cannot meet this
rule, set the hold before the commit reaches `main` and deploy it by hand.

**Rolling back.** Revert the commit on `main`; the next run deploys the revert.
When that is too slow: create the hold file, run `deploy.sh <good commit>` by
hand, and remove the hold once `main` is fixed.

**The status file** is replaced on every run. business-health reads it.

| Field                      | Value                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tick_at`                  | when the run ended (UTC)                                                                                                                                                                                                                                        |
| `deployed`                 | the commit that runs, or null                                                                                                                                                                                                                                   |
| `result`                   | `deployed`, `up_to_date`, `waiting` (an input change waits for a green Build), `rolled_back`, `build_failed`, `failed`, `failed_target`, `manual_deploy_needed`, `diverged`, `tick_error`, `rollback_failed`, `stopped`, `held`, `locked`, `refused` or `error` |
| `phase`                    | where the run ended, for example `api`, `fetch`, `clone`, `build`, `config`                                                                                                                                                                                     |
| `target`                   | T, when the run got that far                                                                                                                                                                                                                                    |
| `stopped`, `held`          | whether the stopped marker and the hold file exist                                                                                                                                                                                                              |
| `waiting`, `waiting_since` | whether main has an input change that is not deployed, and since when (null when not waiting; a run that stops before it reads main reports false)                                                                                                              |
| `tick_error_since`         | the start of the current run of fetch or API failures, or null                                                                                                                                                                                                  |
| `units`                    | `ok`, `absent` (never installed) or `error`                                                                                                                                                                                                                     |
| `last_attempt`             | `at`, `target` and `result` of the last deploy attempt                                                                                                                                                                                                          |

Each run installs the units under the deploy lock, before the hold and stopped
checks. New unit bytes stay pending until `systemctl daemon-reload` and the
timer restart both succeed, so a failed activation is tried again on the next
run.

**First install**, once per host: a clone of the public repository that
`deploy.sh` has run from, `auto-deploy.env` from `control-plane/deploy/vps/auto-deploy.env.example`
(0600), a manual `deploy.sh` of a commit that carries `auto-deploy.sh`, and the
two unit files from `control-plane/deploy/vps/` copied to `/etc/systemd/system`, then
`systemctl daemon-reload` and `systemctl enable --now
isomux-hosted-autodeploy.timer`. After that, the units follow the deployed release, so a unit
change ships like code.

### The support lookup

`deploy/vps/support/` is a read-only lookup of one customer account by email,
for the support runbook: an SSH login whose forced command prints one JSON
line, read by a role with SELECT on the needed columns only. Its README has the
install steps. Run its `role.sql` again after every `restore.sh`.

### Moving Hosted Isomux to a Docker host

Hosted Isomux moved from Fly.io and Vercel to its Docker host this way in
2026-10. No app starts on the new host before the database is restored and the
provisioner state is imported: a provisioner that starts with live provider
credentials before the create latches arrive can pay for a box twice. In order:

1. Ahead of the move: `deploy.sh --prepare <commit>` on the host; the
   provisioner hostname in DNS and its Caddy block; the storefront hostname's
   DNS TTL lowered to a minute, at least one old TTL before step 2. Register
   `https://<provisioner host>/stripe/webhook` in Stripe with the old
   endpoint's events and put its signing secret in `provisioner.env`. Stripe
   retries deliveries there until the provisioner starts, and the provisioner
   claims each event id once, so an event that both endpoints get applies once.
2. Stop every writer on the old database: the old provisioner (with no
   automatic restart) and the old storefront. The provisioner writes a row on every tick, so a
   fingerprint matches a dump only when both come from a stopped source.
3. Fingerprint the old database and then dump it:
   `restore-check.ts fingerprint > source.json` with the old owner's string, and
   `pg_dump -Fc` 18.6 from its direct endpoint, not a pooler, with the password
   in `PGPASSWORD` and not on the command line.
4. On the host: `deploy/vps/restore.sh <dump> source.json` (below). Then
   install the support lookup (`deploy/vps/support/README.md`): its `role.sql`
   grants on the restored tables, and restore keeps only the bootstrap's grants.
5. Export the provisioner state from the old provisioner (below).
6. On the host, into the empty state volume:
   `docker compose ... run --rm --no-deps -T provisioner bun control-plane/state-move.ts import < state.json`
7. `deploy.sh <commit>`, which starts the apps.
8. Point the storefront hostname at the host, and only then add its Caddy block:
   Caddy backs off for minutes after a certificate order fails. Disable the old
   Stripe endpoint. Keep the old renewal URL reaching the new provisioner until
   every office has moved (see "Moving offices to a new renewal URL").

`restore.sh` runs only on an install that `--prepare` left and whose apps have
never started. A fresh bootstrap can order a table's columns differently from
the old database, so the data does not go into the bootstrap's tables. In one
transaction, the script drops them, restores the dump's tables as `cp_owner`
and grants the bootstrap's privileges again. It commits only when every table
has the bootstrap's owner and privileges, and every column its privileges. Then the owner stamps this install's
identity, and `restore-check.ts compare` must find the copy equal to the
source. A failure before the commit leaves the database as it was, and a newer
dump can be restored until the apps first start.

`state-move.ts` moves only what a new provisioner needs, as freshly serialized
records, never as copied files:

- `intents/`, the legacy create latch. Every latch moves; a record that does not
  read as a valid one moves as `ambiguous`, which still forbids a create.
- `audit.jsonl`, without the free-text `detail`. A line that does not fit the
  fixed fields stays on the old volume and is counted.

Nothing else moves. Keys, `known_hosts`, run records, CSRs, the lego directory
and the `.deployment` marker stay on the old volume. With an empty
`certificates/`, lego registers a new ACME account on first use (lego 5.3.1,
`run` creates the account key and registers it when no account file exists).
The export refuses while a run is not revoked (its key is the only way to finish
or revoke it) and while either DNS challenge journal
(`<state root>/certificate-dns-intents`, `/data/certificate-dns-intents`) holds
a file; the refusal names each one and says how to clear it. A lego run killed
mid-challenge leaves its TXT record and its file in the data-directory journal.
The provisioner removes each such file older than an hour, with its record,
when it starts and before each renewal. It lstats every
path it reads and refuses a symlink or a file that is not regular. The import
re-validates the document field by field and refuses a volume that holds
anything.

An old provisioner without the exporter takes the script on stdin: it imports
only node built-ins. It is read-only, so it can run on the live provisioner
first to show what would refuse. At the cutover, with the old provisioner
stopped, start its container idle (no provisioner process), run
`bun run - export < control-plane/state-move.ts > state.json` in it, and stop
it.

### Moving offices to a new renewal URL

The provisioner's renew answer carries
`ISOMUX_CERTIFICATE_ENDPOINT` as `endpoint`. The renewal helper in
`deploy/install.sh` sends its ok report to that URL's status path after a good
install, and only when that answers 200 does it write the new URL into the
enrollment, atomically and with the same bearer. A failed report there, a
redirect, a URL that is not `https://<host>[:port]/internal/certificates/renew`
or a failed write leaves the enrollment as it was. An office gets this helper
from an update its owner starts (`isomux-update`, which refreshes the helper),
or from a new install. An office that never updates keeps calling its old
URL.

**When the old URL can go.** The provisioner logs every renew and status call as
`certificate renewal|status: <outcome> office=<instance id> via=direct|forwarder`,
with no office id when the bearer did not authenticate:

```
journalctl -t isomux-hosted-provisioner --since '2 days ago' --no-pager | grep -E 'certificate (renewal|status):'
```

A failed renewal line ends with `cause="..."`: the last lines of lego's
stderr, with credentials replaced.

The old URL can go when every office with an active certificate credential
has a `certificate status: ok office=<id> via=direct` line and no
`via=forwarder` line after it (a forwarder on the old URL marks its calls with
the `isomux-forwarded` header). A silent office proves nothing: the helper runs daily, so read
the log over at least two days. That window no longer needs a period without
a deploy. Use the configured Compose project name in the tag if it differs
from `isomux-hosted`, and confirm the journal retained the full window.

## The driver protocol

Marker polling alone cannot tell a slow step from a dead process, and a blind
retry can run two installers over each other. So the box runs a wrapper
(`wrapper.sh`), not a bare `curl | bash`.

- **Every run has its own generation** under
  `/var/lib/isomux-cp/runs/<runId>/{pid,started,exit,log}`. A retry allocates a
  new runId, so a previous run's `exit` can never be read as this run's verdict.
- **The supervisor publishes; the launcher only observes.** The detached
  supervisor writes its own pid and `/proc` start ticks into a complete
  generation and only then swaps `current` by atomic rename, while still holding
  the lock. Launch is three-valued: `CONFIRMED`, `FAILED` (the supervisor died
  before publishing), or `UNCONFIRMED` (timeout) - and **unconfirmed is resolved
  by the next tick, never by launching again**, for the same reason an ambiguous
  create is never replayed.
- **The installer never sees the lock fd.** The supervisor owns it and runs the
  installer with `9>&-`; otherwise a background child of the installer inherits
  the lock and holds single-flight shut after the installer has exited.
- **The exit status is captured when the trap fires**, via a single-quoted
  `trap 'printf %s "$?" >"$RUN_DIR/exit"' EXIT`. Double quotes would expand `$?`
  at installation time and record whatever ran before it.
- **A tick reads exit, then pid, then the last `--- step:` marker**, and
  re-reads `exit` before calling anything a crash: a process that exited between
  the two reads is finished, not crashed. The recorded start ticks bind the pid
  to that generation, so a reused pid cannot make a dead run look alive.

During provisioning, a failed installer run reads the tail of its own generation
through `isomux-cp-run tail <runId>`. A failed tail read does not stop the retry.
Failed on-box SSH commands also supply diagnostics, except invite minting, whose
output is never recorded. The operation keeps only the
latest `failure: {step, exit, logTail}`: credentials are removed before clipping
to 40 lines, 512 bytes per line and 8 KiB total. A new failure replaces the old
one, including with an empty tail when the read fails. Installer progress and
success keep the last failure for later inspection. Logs do not enter audit
details, attention reasons or the customer progress projection.

Three distinct consecutive installer runs with the same known nonzero exit and
step raise a critical `operation_condition` through the usual attention path.
An empty step counts; a crash without an exit does not. Retries continue, the
absolute deadline remains active, and success clears the repeated-failure reason.

## Zero standing access

Our key is identified by its **exact base64 blob field**, never by a substring.
A substring match also claims a longer key that contains ours, and any line
whose comment contains ours - and a comment is attacker-controllable text. That
is enough to rewrite or delete a customer's key, and enough for a read-back to
certify the wrong line. The same rule is implemented twice, in `blobOf` and in
`ak_blob_of`, and both are tested against the same adversarial fixtures.
Replacement of `authorized_keys` is durable: fsync the temp, rename, fsync the
parent directory.

The order is the guarantee, and it is not adjustable:

1. On first contact, rewrite our authorized_keys line to carry
   `expiry-time="YYYYMMDDHHMMSSZ"` and read it back **from disk**. Until that
   read-back succeeds the box holds an unexpiring key, so the step is not
   complete and nothing else happens.
2. Arm a root-owned systemd timer at the same instant (`Persistent=true`), so an
   overdue timer still fires after a boot - and then read systemd's own answer
   back and parse it. `systemctl enable --now` exiting 0 says the command was
   accepted, not that a timer is loaded, active, persistent and pointed at our
   instant. systemd echoes the `OnCalendar` spec verbatim, so the loaded value
   is compared exactly against the one we asked for - an enabled, active,
   persistent timer left over from an earlier run would otherwise satisfy every
   other check while enforcing somebody else's deadline. The expiry tests refuse
   to add a scratch key without that evidence, so the box is never in a state
   where a key exists without a ceiling.
3. At handoff: remove our line and our artifacts, confirm from disk, close the
   session.
4. Reconnect **authenticating with the key just removed** and require sshd to
   refuse it. Only a classified public-key rejection counts - a timeout, a
   refused connection, an unresolvable name or a changed host key prove nothing
   about our key and are reported as inconclusive, which is an attention case.
   Run the proof while the key is still INSIDE its validity window: a refusal
   collected after the ceiling has passed proves expiry, not removal.
5. Only then destroy our private half.

`expiry-time` is the guarantee; the timer is cleanup. Verified on Ubuntu 24.04
(OpenSSH 9.6p1) rather than assumed - both across a running deadline and across
a deadline that passed while the box was powered off.

The backstop **verifies before it claims**. It fails fast, and it writes its
success record only after reading back from disk and finding our key gone and
the artifacts gone. That matters because the unit deletes the script and the
timer on success: a false success would remove the enforcement and the evidence
together, so a failure deliberately leaves everything installed for the next
fire and for a human.

**The cleanup timer is deliberately left armed through the proof**, and
self-removes at its deadline. It is the backstop that must still be in place if
the proof comes back saying the removal did not take, and with no customer key
there is no post-proof SSH path to remove it. The consequence is real and worth
stating: the timer units outlive revocation until their deadline, which is a
deviation from "nothing we installed for our own convenience outlives the access
window". Its script lives in `/usr/local/sbin` and its record in
`/var/lib/isomux-access-record.json`, outside the directory revocation deletes,
so it stays runnable afterwards.

### Two hazards that only showed up live

**Host keys are pinned from the connection that authenticated.** `accept-new`
records a host key when the connection is made, _before_ authentication is
decided. During a recycle the old system answers for minutes after the provider
accepts the reinstall, so probing straight into the run's known_hosts pins the
host key of the machine being destroyed - and every later connection then fails
as a host-key mismatch, which is meant to be a hard stop. Each probe therefore
pins into a throwaway file, and only the probe that authenticates has its file
promoted.

**Acceptance must mean "this box".** `*.test.isomux.app` resolves through a
wildcard, so a stale or wildcard A record plus a healthy office elsewhere is
enough for TCP, TLS and `/readyz` to all pass against a machine we did not
build. The resolved address is checked against the instance's own address
before any lower rung is allowed to count.

**The recovery record goes down before the provider call.** Between "the
provider accepted the rebuild" and "we wrote down which key we put on it" there
is a gap; dying in it leaves a box carrying a key we can no longer associate
with anything, so nothing ever connects to put a ceiling on it. The record is
written and fsynced first, and a restart reads its `state`: a
`reinstall_requested` run resumes the wait, and there is no code path that
rebuilds a box twice. `resume --run <id>` is what makes that real: without it
the operator has to work out by hand which half of a one-command flow already
ran, and the safe step is the one nobody thinks of under pressure - WAIT for the
box a provider was asked to rebuild, rather than rebuild it again.

**Remote arguments must be shell-inert.** `ssh` joins its command arguments into
a string that the remote shell re-splits, so a token containing a space arrives
as several. Passing an authorized_keys line as one argument silently wrote a
corrupt key and produced an expiry test that passed while proving nothing.
`SshClient.pipe` now rejects any token carrying whitespace or a shell
metacharacter; payloads travel on stdin, where no quoting applies.

## Invites

Never persisted. Minted on demand by `remote/mint-invite.sh` at the moment the
operator asks: resolve the current owner from the office's own user records,
mint a 15-minute owner-login URL on the admin socket, follow it against loopback
for an owner session, then `POST /api/invites/recovery` for the standard 24h
single-use link. The audit log records that a mint happened, never the URL, and
the operator transcript redacts it.

### Where a customer's invite goes (slice 4b)

The dashboard's invite takes the same two-hop mint and delivers it somewhere
else, because the operator's terminal belongs to us and the credential belongs
to the customer. Ruling R-2026-08-10-1-AMENDED: **the plaintext URL lives only
in provisioner process memory**, in a one-shot map keyed by operation id with a
five-minute TTL, and it is dropped on collection, on expiry, and on restart.

    browser -> POST /api/invite      -> requests.ts opens a typed mint_invite
                                        row stamped via:"dashboard"
    tick    -> mint_invite handler   -> InviteHold.hold(opId, instanceId, url)
    browser -> POST /api/invite/reveal -> mint-seam.ts fetch verb -> take() once

Four consequences worth stating, because each one was a decision:

- **Encryption was not enough.** An earlier design sealed the URL to a
  per-session key and stored the ciphertext in the operation row. That was
  rejected: encryption changes readability, not persistence, and the rule is
  that an invite is never persisted anywhere, rows included.
- **The routing is a property of the ROW, not of the wiring.** A row carrying
  `via: "dashboard"` delivers to the hold; anything else keeps slice 1's
  reporter path. The stamp is carried through the recovery marker write, or a
  retried customer mint would print their credential to an operator's journal.
- **A process with no delivery channel mints nothing.** `cli.ts tick` starts no
  seam and holds no map, so a dashboard-requested row there is FATAL before the
  remote call rather than minted into a context that cannot hand it over.
- **The chain no longer mints.** `nextKind("verify_https", "live")` is null: a
  hosted office stops at verified-live and waits to be asked. Only the
  operator's deliberate `handed_off` flow still mints on its own, and that one
  is invoked interactively with the redacted-transcript contract.

`invite-persistence.test.ts` is the check that this holds: it drives a real mint
against a fake box and then searches the database FILE'S BYTES (and its `-wal`,
where a fresh value lands first), every evidence and audit value, the reporter's
output and its transcript. It carries a positive control - a test that
deliberately persists the URL and requires the same scan to catch it - because a
search that has never matched anything is not evidence.

### The seam, and what it is allowed to be

One authenticated verb: fetch a minted invite by operation id, for an instance
the caller owns, while the window is open. No kind, no host, no path, nothing
else that reaches a remote seam. The web app's half (`mint-client.ts`) imports
nothing from the control plane except a type, and `mint-seam.ts` is on the
web-boundary test's forbidden list so no page can reach the server half.

Answers are typed and carry no material: `ready`, `not_ready`,
`expired_or_lost`, `window_closed`, `failed`, `forbidden`. `expired_or_lost`
deliberately covers already-taken, expired and restarted alike - which of the
three it was is information about how a credential was handled, and the
customer's next action is the same in all three.

A fetch after the window closes REFUSES and deletes the entry (manager ruling,
reviewer-confirmed). The consequence is worth knowing: minting is window-gated
too, so a customer in that position has no self-serve path left, and the page
says so and points at support rather than showing a button that cannot work.

**Transport, and the deploy-time note.** HTTP request-response, bound to
loopback in this loop because the provisioner and the web app are the same box.
Deliberately not a unix socket: a socket path is same-box by construction, and
the deployed shape is a web app on Vercel calling a private provisioner surface.
The interface does not assume co-location; the private networking (or mTLS) in
front of it, and a request budget that fits the platform's function timeout, are
deployment work and are not built here. The bearer credential comes from the
environment on both sides - `CONTROL_PLANE_MINT_TOKEN` on the provisioner,
plus `CONTROL_PLANE_MINT_URL` on the web app - with no default and no fallback:
a provisioner started without one refuses to serve the seam at all, and says so.

### Liveness, the restart, and the access window (slice 4b)

- **Liveness is a measurement, not an operation.** `liveness-watch.ts` probes
  each `live` office once a minute and counts CONSECUTIVE failures. Three
  strikes raises attention (design: a box failing liveness gets a human), and
  only a later `ok` clears it - an office failing dns, then tls, then tcp would
  otherwise look like it keeps recovering. The due test and the claim are one
  UPDATE, so two overlapping provisioners cannot count one outage twice.
- **Reboot is never automatic.** It is the customer's button and nothing else,
  because the failure may be ours. The customer-facing word is RESTART
  everywhere: the boundary test forbids any file under `web/` from containing an
  operation kind, so the app asks through a named verb and cannot spell
  `reboot`.
- **Confirmation is not a column.** "Remove Hosted Isomux Provisioning access" opens a
  `revoke_access` row stamped `via: "dashboard"`, and that stamp is what makes
  it the customer's confirmation. A row opened by an operator or the chain still
  renders, but is never described as their choice. The seven-day ceiling stays the
  fail-safe underneath. The dashboard also requires an ordinary hosted office
  to have minted an owner invite before it enables confirmation. That fact proves
  only that the sign-in path was offered, not that the customer used it; the
  separate checkbox is their signed-in attestation. An adopted office bypasses
  the mint gate because its existing owner can already be signed in without a new
  invite.

## Billing (Stripe test-mode account)

Signup, the comped path, webhooks and the dunning ladder. Every module lives in
`control-plane/stripe/` and every command in `control-plane/billing-cli.ts`,
which is separate from `cli.ts` on purpose: that file drives real boxes, and its
most important property is an absence - no command in it can reach a paid
create. The same absence holds here. `billing-cli.ts` never registers the
`power_off` handler, so billing can REQUEST a suspension and nothing runnable in
this slice can power a real box off.

```
bun control-plane/billing-cli.ts bootstrap        # test product, price, 100%-off coupon
bun control-plane/billing-cli.ts checkout --email <e> --office-name <n> --price <id> \
    [--coupon <id>] [--customer <cus_...>] [--instance <inst-...>]
bun control-plane/billing-cli.ts serve [--port 4243] [--record <dir>]
bun control-plane/billing-cli.ts subs | events | tick
bun control-plane/billing-cli.ts clock --action create|advance|list|delete ...
bun control-plane/billing-cli.ts cleanup          # delete ONLY what this slice created
```

Every command reads `STRIPE_TEST_SECRET_KEY` from the environment, exactly as
the provider commands read the Contabo credentials: the caller sources the file,
the code never learns its path, and nothing prints, logs or echoes the value.
`StripeClient` refuses to issue a single request unless the key is an
`sk_test_`/`rk_test_` one, and a live prefix gets its own named error.

The test chain uses the account's classic test mode, not a general sandbox.
Test mode shares live settings: Public details and the failed-payment setting
(proven 2026-10-20, when a live terms URL change showed in a test-mode
Checkout). Revisit if Stripe announces a test-mode retirement.

The deployed provisioner also serves `POST /stripe/webhook` on port 4311, and
Caddy publishes that path. It runs in live mode: it reads the live endpoint
secret from `STRIPE_LIVE_WEBHOOK_SECRET`, and its key grants are in "Stripe
mode boundary" below. Test mode has no deployed endpoint; a future test-mode
provisioner gets its own endpoint at its own URL, with the secret in
`STRIPE_WEBHOOK_SECRET`. Webhook processing only reads from Stripe.

The same provisioner cadence polls ordinary signup Checkout sessions that have
no local subscription row. Session IDs and expiries are recorded before a
Checkout URL reaches the customer. The poll uses object GETs, reconciles fetched
subscription truth through the same writer as the webhook, and never invents an
event or enters the dunning ladder. Reinstatement Checkouts remain in their
separate retention machine.

### Test mode is enforced three times, not once

A live-mode credential or object reaching this code would mean reading or
writing real customer data, so the refusal is repeated at every layer that could
independently be pointed at the wrong account:

1. **The key**, at client construction.
2. **The event**, immediately after signature verification and JSON parsing -
   before any dedupe lookup, any object fetch, any transaction and any audit
   row. `livemode` must be present and `false`; `true` or missing is a typed
   refusal, answered 400, with nothing read and nothing written. Missing is
   refused as hard as `true`, because treating absence as test mode is exactly
   how live data would get through.
3. **Every fetched object** that reports a mode - session, subscription,
   invoice. A live-mode object is a hard stop, never "unavailable" and never
   retried.

`fixtures.test.ts` and `ownership.test.ts` scan the tree for credential-shaped
literals and for personal data in fixtures, and the guards themselves have to
name the `sk_live_` prefix - so those scans look for a credential-shaped BODY
after a prefix rather than for the prefix alone.

### Webhooks are the only writer, and they write from a FETCH

A webhook is a notification, not truth. Two events about one subscription can
carry the same one-second `created` value, so ordering them by their own
timestamps cannot be made correct - the older payload would overwrite the newer
one and the state would silently regress. Every accepted event therefore fetches
the object it is about, through an injected `StripeObjectReader`, and
reconciliation writes from that. Replays and reorderings converge by
construction, because whichever event triggers the fetch, the fetch returns the
same current object. `last_event_id` and `last_event_created` are stored as
evidence and read by nothing.

The alternative - trusting the event payload and guarding it with a watermark -
was considered and dropped for that reason. The cost of fetching is one or two
extra API calls per delivery and a seam that has to be injected for tests; the
benefit is that "which write wins" stops being a question.

Order of operations for one delivery:

1. verify the signature over the RAW bytes;
2. parse, then the live-mode gate;
3. fetch the object, with NO transaction open;
4. one transaction: re-check the event id, claim it, apply the snapshot, mirror
   `instances.subscription_state`, move the dunning episode, enqueue any
   suspension, raise or clear attention, write the audit rows.

The event id is a primary key claimed in that same transaction, which is what
makes a crash mid-apply replayable: a throw rolls the claim back too, so
Stripe's redelivery still has work to do. A fetch that cannot be completed is
answered 500 with nothing committed. An unhandled event type is answered 200 and
recorded as `ignored`, because a 4xx would make Stripe retry it forever.

Concurrency: deliveries for one subscription are serialised in-process by a
per-subscription promise chain, so two of them cannot interleave fetch and
write. That is enough for one endpoint, which is all this slice runs. A second
provisioner would need a database-level lock instead; the durable event
transaction is what covers crashes and redelivery either way.

### Who may write what

`subscriptions` has two column families with different writers, and they are
separate so that "webhooks are the only writer of subscription state" is
literally true rather than roughly true:

- **Stripe-owned** (`status`, `current_period_end`, `cancel_at_period_end`, the
  three discount columns, `ever_full_discount`, `latest_invoice_id`) - written
  only by `casStripeOwnedSubscription`, whose only caller is reconciliation,
  which only ever writes from a fetched object.
- **Ours** (`payment_failures`, `exhaustion_observed_at`, `coupon_grace_until`,
  `episode_id`, `episode_state`) - dunning bookkeeping, written by
  reconciliation and by the coupon-hold deadline tick, which is the single
  non-webhook transition the design asks for.

`ownership.test.ts` asserts that split against the source, because no
behavioural test can catch a future dashboard button or success-URL handler
becoming a second writer.

### The dunning episode, and why "exactly once" is not the one-active index

Slice 2's one-active partial unique index stops holding the moment an operation
becomes terminal, so a redelivered exhaustion event after a FAILED suspension
would open a second one. Instead a failure sequence gets a durable identity -
the episode - whose id is derived from the id of the event that opened it, and
the suspension operation's id is derived from the episode
(`op-power_off-dun-<event id>`). The operations primary key then refuses a second
insert permanently, terminal or not. An episode is reset only by an
authoritative recovery, so a genuine second failure sequence months later gets a
new identity and may suspend again.

### Comped accounts and the lapse diversion

A coupon ID IS NOT PROOF of a full discount. `payment_method_collection:
if_required` tells Checkout it may collect no card, and that is only true when
nothing is owed - so it is reachable only behind a `FullDiscount`, a branded value
that `verifyFullDiscount` alone can produce, after fetching the coupon and finding
it test mode, valid, and exactly 100% off. A partial, amount-off, expired or
unreadable coupon is refused, and an unreadable one creates no session at all. The
type is what enforces this: `checkoutParams` cannot be handed a bare string.

"Comped" is not a flag: it is an active 100% discount, cached from a fetched
subscription. What IS remembered is `ever_full_discount`, which is sticky and
never unset, because the design routes a formerly-comped account differently
when its coupon lapses: the first confirmed failure opens a `coupon_hold` with a
14-day deadline and raises attention instead of entering the ladder.

Hold expiry never suspends on the strength of the calendar. It either acts on
exhaustion already observed while the hold stood, or drops the account into the
ordinary ladder and waits for Stripe to say it has finished retrying.

Attention is per-instance by design, so a subscription with no box linked yet
has nowhere to hang one; that case is audited instead. Slice 4, which links a
subscription to an instance at signup, is where it stops happening.

### What non-Managed Payments Stripe did (observed 2026-08-09, API version 2026-07-29.dahlia)

These 2026-08-09 lifecycle observations are about non-Managed Payments
subscriptions created directly with `POST /v1/subscriptions`. They are not
Managed Payments evidence. The 2026-08-20 Managed Payments exercise below
confirms only the object shapes that it names. It did not reproduce a failed
renewal, retries, exhaustion, a terminal dunning state or coupon lapse.

Everything below was measured against the real test account, not read from
documentation. The pinned API version matters: three of these are shape changes
that older examples get wrong.

- **`payment_method_collection: if_required` on a 100%-off coupon collects no
  card at all.** The hosted page renders no card accordion and no payment-method
  choice; it shows "EUR 0.00 / Then EUR 1.00 per month after coupon expires" and
  a single subscribe button. The completed session reports
  `payment_status: "paid"` with `amount_total: 0` - not `no_payment_required`,
  which is what the field name invites you to assume.
- **A coupon lapse ends in `past_due`.** With the discount expired, the renewal
  invoice has an amount due and the customer has no payment method, so the
  charge fails and the subscription moves to `past_due` (not `unpaid`, not
  `incomplete`). Stripe still schedules retries even with no payment method on
  file.
- **Retry exhaustion arrived at attempt 9** on this account, and it arrived as a
  CANCELLATION: `customer.subscription.deleted` with
  `cancellation_details.reason = "payment_failed"`, delivered BEFORE the final
  `invoice.payment_failed`, leaving the invoice `open` with
  `next_payment_attempt: null`. That is the account's "manage failed payments"
  setting, and it means the design's suspend-on-exhaustion boundary is not
  reachable while it says "cancel": a subscription never sits unpaid. The ladder
  therefore treats a cancellation with an open episode as a critical attention
  case rather than silence.
- **A subscription's period end lives on its ITEMS**
  (`items.data[].current_period_end`), not on the subscription.
- **An invoice names its subscription through
  `parent.subscription_details.subscription`**, not `invoice.subscription`.
- **An invoice has no `paid` boolean.** It reports `status` and
  `amount_remaining`, so reading `paid` alone calls every invoice unpaid.
- **A discount does not carry a `coupon` field.** It carries
  `source: {type: "coupon", coupon: "<id>"}`, and the percentage - the whole
  signal for "comped" - appears only when the fetch expands
  `discounts.source.coupon`. Expanding `discounts` alone looks like it works and
  silently yields a discount with no percentage. An event payload carries bare
  discount ids, so normalising one is refused outright rather than read as "no
  discount".
- **Exhaustion is a named predicate, not an assumption.**
  `observedExhaustion()` is the one function that decides Stripe has given up,
  and its first hypothesis - an unpaid invoice with no `next_payment_attempt` -
  is what the exercise above confirmed. If Stripe's shape changes, that function
  is the only thing that has to change with it.

### Managed Payments (verified in test mode 2026-08-16)

Every new Checkout Session sets `managed_payments[enabled]=true`. Existing
subscriptions cannot migrate into Managed Payments. The pinned API version,
`2026-07-29.dahlia`, is later than Stripe's `2025-03-31.basil` minimum.

The test catalogue matches the hosted decision: USD with Adaptive Pricing. Its
Price sets `tax_behavior=exclusive` explicitly, so tax is added at Checkout and
the amount does not depend on the Dashboard's "Include tax in prices" setting.
Its Product uses tentative test-mode tax code `txcd_10701410` (Electronically
Delivered Information Services - Business Use). Nil must approve the final live
tax code before any live Product is changed.

Stripe owns tax collection, customer tax IDs, statement descriptors, invoices,
Checkout confirmation text, receipts and subscription-related customer emails
for Managed Payments. The control plane's one customer mail is the email
sign-in link (see "What is in the app"); as checked 2026-08-16, its dunning
ladder records state, raises internal attention and requests suspension, so it
does not duplicate Stripe's customer emails. Adding customer
dunning email copy later is a policy decision, not an implementation default.

Test-mode evidence from 2026-08-16:

1. Bootstrap created a USD Product and recurring Price with the tax code and
   exclusive tax behaviour above.
2. Stripe accepted an ordinary Managed Payments subscription Session with
   `payment_method_collection=always` and a comped Session with a verified
   100%-off coupon plus `payment_method_collection=if_required`.
3. A headless browser completed the ordinary Session with Stripe's `4242` test
   card; the Session read back `complete`, `paid` and `livemode=false`.
4. The comped Session rendered without card fields and accepted the API shape,
   but the automated browser did not complete it. The 2026-08-20 lifecycle
   attempt below reached the same outcome.

### Managed Payments lifecycle attempt (measured 2026-08-20, API `2026-07-29.dahlia`)

Method: both test-mode Sessions came from `openCheckout` with test-clock
customers. The ordinary Session was completed in headless Chrome with Stripe's
documented `4242 4242 4242 4242` test card, expiry `12/30`, CVC `123` and postal
code `97201`. It read back `livemode=false`, `status=complete`,
`payment_status=paid`, `payment_method_collection=always` and `amount_total=120`
USD cents including tax on 2026-08-20.

The first ordinary failure attempt was synthetic and did not produce a failure.
After Checkout completed, the exercise attached `pm_card_chargeCustomerFail` to
the test customer and confirmed that Stripe accepted its customer-scoped id as
`invoice_settings.default_payment_method`. Across 10 renewal invoices measured
2026-08-20, the customer-level default was not used: each invoice finished `paid`
with `attempt_count=1`, `amount_remaining=0` and `next_payment_attempt=null`, while
the subscription stayed `active`. The run did not fetch
`subscription.default_payment_method`, so it did not establish why. Stripe's
documented precedence puts the subscription-level default before the customer
invoice default, so this result is not evidence of Managed-Payments-specific
behaviour.

A second ordinary attempt on 2026-08-20 used Stripe's documented Billing failure
card `4000 0000 0000 0341` on a fresh test-clock customer. Stripe's
[official test-card table](https://docs.stripe.com/testing), checked 2026-08-20,
describes it as: "Attaching this card to a Customer object succeeds, but attempts
to charge the customer fail." Its
[Billing testing page](https://docs.stripe.com/billing/testing) says to "use a
trial period to defer the attempt." Stripe required
two days between the test clock and Checkout trial end. The first form was
incomplete: cardholder name was empty, and its US postal code sat under a French
country selection, as the dated screenshot shows.

The fresh retry on 2026-08-20 filled every visible required field with consistent
US data: the documented card, expiry `12/30`, CVC `123`, cardholder name, street,
city, state and postal code. It showed no validation error after the "Start trial"
action, but Session
`cs_test_a1MTw5budb9ZGYpvLbTLbwAE2IyPZ7gJVQ2uybz7nwsQZFQ5jwgwZqjVtO`
stayed `open` throughout a 90-second observation window. No subscription or
renewal existed to advance, and no third route was attempted. Therefore renewal
failure, retry count, exhaustion, terminal dunning state and the failed-invoice
shape remain **unmeasured** for the ordinary Managed Payments path.
`observedExhaustion()` in `stripe/dunning.ts` remains unvalidated under Managed
Payments. The 2026-08-09 attempt-9 cancellation must not be used as a Managed
Payments shutdown boundary.

The successful ordinary path confirmed these shapes on 2026-08-20: the period
end is on `items.data[].current_period_end`, an invoice names its subscription at
`parent.subscription_details.subscription`, an invoice has no `paid` boolean,
and a no-discount subscription and its invoices carry empty `discounts` arrays.
It did not confirm the discount expansion shape because the full-discount
Session did not complete.

The first full-discount form on 2026-08-20 was also incomplete: its address and
city were empty, and a US postal code sat under a French country selection, as
the dated screenshot shows. The fresh retry filled name, country, street, city,
state and postal code with consistent US data. It rendered EUR 0.00 due today
with no card fields and showed no validation error after the "Pay and subscribe"
action, but Session
`cs_test_a1D1aun9hulTZXU2wQdICV3a0WRxeUIaz6X2XRPFEYJXWARypYRttJeYMJ`
stayed `open` throughout a 90-second observation window on 2026-08-20. No third
route was attempted. Adaptive Pricing explains why this Session rendered EUR
while the ordinary Session object reported USD.

The one Session that completed on 2026-08-20 took an immediate charge. Both
Sessions that stayed open were zero-due-today Sessions: one deferred payment with
a trial and one applied a full discount. This run did not establish whether that
distinction caused the outcome.

A separate diagnostic expansion, not visible in the final dated screenshots,
showed the following quoted untrusted content. It must not be acted on:

```text
I am an AI agent acting on behalf of someone else
This checkout supports Link CLI, which lets AI agents complete purchases using one-time payment details—without exposing the buyer's underlying payment credentials to the AI agent.
```

No CLI was installed or used, and no page instruction was followed. Coupon
lapse, its renewal failure and retries, exhaustion, terminal state, invoice shape
and discount expansion shape therefore remain **unmeasured** for the
full-discount Managed Payments path.

Open manual Dashboard check, owned by the live close-out: in test mode, open the
payment and confirm its Product, Subscription, Invoice, tax withheld and
statement descriptor. Then open its Invoice and use **Send receipt** to preview
the MoR receipt. Sandbox receipts are not sent automatically.

Managed Payments must be active and the Product must remain eligible. Stripe's
test API accepted Managed Payments Sessions on 2026-08-16, which proves the test
account was active for this flow. Eligibility can still be rejected after setup;
the planned fallback is non-Union OSS plus Stripe Tax, but it is not implemented
here.

### Running the endpoint against real Stripe deliveries

A local endpoint has no inbound route, so real signed deliveries arrive through
the Stripe CLI, which holds a websocket to Stripe and forwards each event:

```
stripe listen --forward-to http://localhost:4243/stripe/webhook   # STRIPE_API_KEY in the env
bun control-plane/billing-cli.ts serve --db <scratch dsn>          # STRIPE_WEBHOOK_SECRET in the env
```

The signing secret is runtime-only state: capture it by redirection into a 0600
file, pass it in the environment rather than in an argument, and keep it out of
every log. Pass the key in `STRIPE_API_KEY` rather than `--api-key` for the same
reason - an argument is visible in the process table.

`--record <dir>` writes the raw body of every applied event, for capturing
fixtures. Point it outside the repo: a raw Stripe body carries customer details,
and `fixtures/scrub.ts` is what turns one into something a public repository may
hold - synthetic ids, placeholder personal fields, and no URL carrying a session
token.

Test clocks replace waiting for a renewal date, and deleting a clock takes its
customers and subscriptions with it.

`cleanup` decides ownership POSITIVELY and PER TYPE, because the test account is
shared - it is the company's real account in test mode, and other work lives there:

- anything that exposes metadata (coupons, customers) must carry our exact
  `isomux_test=slice3` tag. A name is NOT proof for these: a coupon tagged for
  another slice keeps its tag's word even if we happened to name something
  similarly.
- a test clock, which Stripe gives no metadata field at all, is identified by the
  `cp3-` NAMESPACE we mint into - not by the bare prefix, so a clock called
  `cp3other` is somebody else's. That is the only type where a name counts.

Anything unprovable is skipped and listed BY ID rather than counted. Every delete
result is checked, because "we asked" is not "it is gone" - a refused or ambiguous
delete makes the whole cleanup incomplete and exits non-zero. A 404 counts as
success: a customer that went with its test clock is already gone. Cleanup walks
every page rather than assuming the first hundred is the account.

So that cleanup can find them, `checkout` creates the customer ITSELF - tagged, and
named `cp3-<office>` - instead of letting Checkout create an untagged one that
nothing could safely delete afterwards. Pass `--customer` when you have your own
(a test-clock customer, which is removed with its clock).

The order matters and is fixed in `openCheckout`: verify the coupon (read-only),
then create and CHECK the customer, then create the session. A refusal at any step
leaves nothing behind - no customer after a bad coupon, no session after a customer
that came back live-mode or without an id.

What `cleanup` does NOT touch: prices and products. A used price cannot be deleted,
only archived, and archiving on a shared account is a deliberate act rather than a
side effect of a cleanup command - so archive the bootstrap price and product by
hand when they get in the way.

### What this slice does NOT do

- No web app and no sign-in - both arrived in slice 4a (below), which is also
  where a name became unique across accounts. `validateOfficeName` still
  enforces only the DNS-label syntax and the reserved-name refusal, which are
  pure Checkout-boundary rules; nothing in this section, and nothing in the
  metadata it writes, makes a name unique.
- No resume from suspension. `power_on` stays declared-but-not-driven: ending a
  suspension is a billing recovery transition nobody has ruled on.
- No cancellation or deprovisioning, which is slice 5. A `customer.subscription.
deleted` event is cached and, if a dunning episode was open, escalated - and
  that is all.

## The web app: sign-in, signup, progress (slice 4a)

`control-plane/web/` is a Next.js App Router app - **its own package**, with its
own `package.json`, lockfile and `node_modules`. It is not a workspace member,
so an ordinary `bun install` at the repository root does not pull Next: a
self-hoster installs the office, not the hosted product's storefront. The
measured cost of the alternative was 446 MB.

`bun run ci` still covers it. The last step of the root `ci` script is
`ci:web`, which installs the nested package from its committed lockfile with
`--frozen-lockfile` and then builds, type-checks and lints it. A fresh clone
passes one command; the price is that the first `bun run ci` needs the network,
where it used not to.

### The runtime matrix, measured

Next 16.3.0 (Turbopack), Bun 1.3.11, Node 24.18.0. **Measured 2026-08-10, AFTER
the Postgres port**, one run of `e2e/production-server.e2e.ts` per cell. A cell
counts as working only if a store-backed page came back: booting is not serving,
and the previous version of this table could not tell the two apart.

|              | `bun --bun`                                                                                         | `node`                    |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------- |
| `next dev`   | serves store-backed pages                                                                           | serves store-backed pages |
| `next build` | FAILS: "Expected CommonJS module to have a function wrapper" loading Next's compiled server runtime | works                     |
| `next start` | boots, then answers 500 to every dynamic route - the same defect, at request time                   | serves store-backed pages |

The cells above were measured against the local container. The `node` /
`next start` cell was re-measured on 2026-08-11 against the MANAGED engine (the
Neon `suites` branch) and every check stayed green. That is the cell a deployment uses, so it is the one that needed a
real database behind it rather than a convenient one.

**The right-hand column is what the port bought.** Before it, Node could not
load the store at all: `next dev` could not open `bun:sqlite`, and `next start`
worked only in the sense that it served pages with no database behind them.
Both cells now render the projection out of a real Postgres.

**The left-hand column moved in a way worth writing down.** `bun --bun next
start` used to fail at startup; it now BOOTS, prints "Ready", and owns the
listening socket - and then answers 500 to the first dynamic request, with the
same "function wrapper" error from the same compiled runtime. So the defect did
not go away, it moved later, and a measurement that stopped at "Ready" would
have recorded a fix that does not exist. (Reaching that cell at all needs a
build Node produced, since the bun build still fails.) `bun --bun next dev`
is unaffected and is still how the app is developed.

**Except from a cold start.** Measured 2026-10-03 on Next 16.3.8: a
`bun --bun next dev` that starts with no `.next` fails its first `pg` load with
"Failed to load external module pg-<hash>", and a restart over the `.next` it
left works. Node passes from cold. So `e2e/lifecycle.e2e.ts` and
`e2e/i18n.e2e.ts` spawn Next under Node.

The `next build` split is also why `lib/services.server.ts` reaches the control
plane through **request-time dynamic imports** - but note that the reason has
shifted. It used to be enforced by the build itself, because a module-scope
import of a `bun:sqlite` store failed under Node while Next collected page data.
With a driver that loads under both, the build no longer objects, and
`web-boundary.test.ts` is the only thing keeping the driver, keys, ssh and the
webhook path out of the storefront's module graph.

### What is in the app, and what is deliberately not

- Auth.js with Google configured only when its credentials are present, so a
  missing client id means the provider is absent rather than broken. A
  credentials provider gated on `CONTROL_PLANE_DEV_AUTH=1` AND a non-production
  build drives every test, because no Google OAuth client exists yet.
- Email sign-in for customers without Google, configured only when
  `AUTH_RESEND_KEY` is set (the sign-in page shows the form only when
  `/api/auth/providers` lists `email-link`). `POST /api/signin/email` mails a
  link through Resend (`lib/signin-mail.server.ts`) after an origin check, a
  per-IP limit and a per-address limit. The link carries a signed token in its
  FRAGMENT, valid 15 minutes and spent once; the used-token record lives in the
  process's memory, like the rate limits (`lib/signin-link.server.ts`). The link
  page signs in only on a click, because mail scanners open links first. The
  `email-link` Credentials provider redeems the token and reaches the account
  with that address, case-insensitively, also when Google made it; a later
  Google sign-in binds onto an email-made account only when Google reports the
  address verified (`signup.ts` `bindGoogleSubject`). Sessions
  are JWTs with no database adapter: an adapter would make Auth.js a second
  writer of `accounts`. The account surface signs out through an Auth.js server
  action, so the framework's CSRF token protects the cookie-clearing request.
- One facade, `lib/services.server.ts`, with a fixed export list. It holds ONE
  store for the life of the process and hands no store out - every export
  returns plain data, so no page or handler is one method call away from
  mutating the control plane. It used to open one per request and close it in a
  `finally`, which was right when the argument was a file path and wrong once it
  was a pool: `Store.open` runs the schema statements, the catalog check and the
  sequence seed, and measured 2026-08-10 against the local Postgres that is a
  median 62.6ms over 20 runs, against 9.1ms for a bare connect and 1.3ms for the
  read the request came for. The cache is a PROMISE rather than a resolved
  handle, so two cold requests arriving together join one open instead of
  building a pool each and leaking the loser, and a REJECTED open is evicted, so
  a database that was briefly unreachable costs a request rather than the
  process. It lives on a `globalThis` symbol because a dev server re-evaluates
  the module on every hot reload. `web-store-lifetime.test.ts` pins both
  properties through the engine - by counting the backends the app's connections
  actually occupy - rather than through the module's own bookkeeping, which is
  exactly what a cached handle gets wrong while looking right from the inside.
- `web-boundary.test.ts` asserts that against the source: the export list, the
  modules the app may name, the credentials it may read, the absence of raw
  store methods anywhere in it, and - because direct imports are not enough -
  the whole transitive module graph. That last rule earned its place
  immediately: `checkout.ts` imported four metadata constants from
  `reconcile.ts`, which put the entire webhook path (and, through it, the
  ticker's type graph) into the storefront's bundle. The constants now live in
  `stripe/metadata.ts`.
- No webhook processing. Deliveries stay with `billing-cli.ts serve`, exactly as
  slice 3 built them. No operator actions either: 4a is the read side.

### The customer pages in Spanish, Catalan and Simplified Chinese

Added 2026-09-06. A customer reads sign-in, the landing dashboard, sign-up, the
office page and every payment refusal in English, Spanish, Catalan or Simplified Chinese. `app/ops`
is English and carries no language switch: it is an operator surface.

The catalogs are `web/lib/i18n/` - a typed English source of truth with `es`,
`ca` and `zh` as complete records over its keys, plus `translatorFor`, `{name}`
interpolation, `Intl.PluralRules` for the one/other pairs, and `rich()` for a
sentence with a link inside it. **It is a copy of `shared/i18n/`, not an import**,
because `web-boundary.test.ts` refuses any `../..` import outside its allow list.
When a language is added to `shared/languages.ts`, add it here too.

Precedence, highest first: the `isomux_lang` cookie the switch writes, then the
request's `Accept-Language`, then English. There is NO stored customer language
and no column for one - the one customer email, the sign-in link, goes out in
the language of the request that asked for it, so nothing needs a language that
outlives a browser.

Two resolution paths, because the pages render two different ways:

- `/signup` and `/office/[officeKey]` are `force-dynamic`. They call
  `languageForRequest()` (`lib/i18n/request.server.ts`) and serve translated
  HTML, with `lang` on the translated region for a reader with no JavaScript.
- `/` and `/signin` are prerendered under `dynamic = "error"` so a CDN can hold
  them. They cannot read a request at all, so they paint English and move to the
  reader's language after hydration (`useLanguage`, which reads the cookie and
  then `navigator.languages` in order). A visitor on Spanish, Catalan or Simplified Chinese reads one
  frame of English; that is the price of the shell being cacheable.

`<html lang>` in `app/layout.tsx` is a static `"en"` and cannot be anything else:
reading the request there would make every route dynamic. Each page declares its
own language through `<DocumentLanguage>`, which moves the attribute to match the
text and puts it back to English on ops.

The step ladder, the liveness rungs and the attention classes are translated from
the ids the projection already carries, with the sentence `progress.ts` worded as
the fallback for an id we have no key for. The key is DERIVED from the id rather
than looked up in a table, because `web-boundary.test.ts` forbids any file under
`web/` from containing an operation kind.

**The switch does not reach Stripe's own page, and that is deliberate.** No
`locale` is sent with a Checkout session. The session's idempotency key is
derived from stored state alone (`checkoutKeysFor`, `reinstatementSessionKey`),
so every replay of one generation must send a byte-identical body - and a locale
read from the request is the one input a language switch could change between a
lost create response and its retry, which Stripe refuses
(https://docs.stripe.com/api/idempotent_requests). Checkout falls back to the
customer's own browser, which is the right answer in the common case. Making the
hosted page follow the switch instead needs a locale stored with the generation;
that is a governed-schema change and has not been taken. (Reviewed and ruled
2026-09-06.)

Tests: `web/lib/i18n/catalog.test.ts` (completeness, placeholders, rich tags,
and no orphan keys), `languages.test.ts` (negotiation), `use-language.test.ts`
(the browser-side resolver, including the ordered preference list and a
malformed cookie), `web/components/pages.i18n.test.tsx` (page renders per
language), and `control-plane/web-i18n.test.tsx`, which is out here because
proving a step label is translated means naming real operation kinds. A payment
refusal is asserted through its real caller in
`stripe/checkout-poll.test.ts`. The real-browser transcript is
`bun run --cwd control-plane/web e2e:i18n`: it drives Accept-Language, the cookie
beating it, the browser's ordered preference list, the switch under a real mouse
click, the operator floor staying English, and a soft navigation carrying the
root `lang` back to English, and it writes screenshots. It runs on a scratch
schema that it drops, and prints no connection string.

### Signup, and why a name is unique

`signup.ts` owns it. `name_reservations.name` is a primary key, and **the INSERT
is the uniqueness decision** - not a SELECT in front of one, because two
connections can both observe "absent" in the same instant. A conflict is read
back: another account's row is a refusal, the same account's row is that
account's own retry.

`account_id` is indexed but not unique. One account can reserve several globally
named offices, and the dashboard reads them in `created_at, name` order. Every
office still goes through `reserveOffice`; there is no second creation path.
`instances.name` is the office's durable full hostname and answers where an
existing office lives. `OFFICE_DOMAIN` composes a hostname only while a new
office is being reserved; later reads use the stored instance value.
The launch admission bound counts reservations globally, so one account can
consume the whole 40-office-per-seven-days certificate budget. There is no
separate per-account quota.

THE TENANT KEY IS THE ACCOUNT ID, NOT THE EMAIL. Both providers resolve to a
durable account before a session exists, and the session carries that id;
signup, the dashboard and the projection accept nothing else. An email is
mutable - Google can return the same subject with a new address - and a session
keyed on the address would reach a different account than the one the subject is
durably bound to, while the binding kept saying the right thing. The email is
contact and display data, and Checkout takes it from the ACCOUNT row rather than
from whatever the session carries today.

Each customer dashboard route is `/office/<office-name>`, using the same globally
unique, immutable name held in `name_reservations`. The account dashboard lists
every office owned by the signed-in account. Checkout and
dashboard links always use that form. Internal instance ids are not accepted as
customer-facing route keys. The resolver looks up the globally unique name and
compares its account before projection, so a foreign name and one that does not
exist both remain the same 404.

The signup POST also refuses a request that did not come from this deployment's
own origin, before it reads the form: it writes durably and spends at Stripe on
the strength of a cookie, and a customer's own office shares the registrable
domain. A missing Origin is refused as hard as a foreign one, and the Checkout
success and cancel URLs are built from the configured origin rather than from
the request, so a Host header is not configuration.

Everything a retry needs comes from the stored row. The reservation carries an
opaque `id`, and the instance id and both Stripe idempotency keys are derived
from it once and read back afterwards, so a second POST cannot move a session to
a different plan, coupon or instance. A request that disagrees with the stored
plan or coupon is REFUSED rather than silently served from the row: quietly
using the stored plan would leave someone believing they had changed it.

Signup offers Entry (`office`, Contabo V153, 4 vCPU / 8 GB / 100 GB SSD) and
Poweruser (`poweruser`, Contabo V155, 8 vCPU / 24 GB / 300 GB SSD). V155 was
confirmed by a Contabo account read on 2026-08-20. The customer-visible prices
are nullable constants in `plans.ts`; an unset value renders no price line. A
set value carries its amount, currency and monthly billing period together, and
the UI formats its symbol from that currency.
Stripe price ids are separate deployment configuration. The explicit Entry
variable wins over the legacy single-price variable, which applies only to
Entry and never to Poweruser. Signup refuses before reservation when its chosen
plan has no Stripe price. Continuation uses the reservation's stored plan, and
reinstatement resolves the instance's stored provider product, so neither path
can silently charge the other tier's price.

Signup writes four rows in one transaction - account, reservation, instance,
placeholder provider asset - and it writes the access-window ceiling with the
instance, because nothing else can. `createInstance` is the only statement that
sets `access_window_expires_at`; `casInstance` refuses it in its type and at
runtime. A row created without a ceiling could never be given one, and the
driver is fail-closed on a missing ceiling, so the row would be unprovisionable
forever. The value is the seven-day fail-safe backstop of R-2026-08-15-1.
Existing prelaunch rows or boxes with a longer deadline are unsupported test
state. Provisioning refuses them, and operators delete and recreate them from a
new signup; there is no migration in place. Retries, reconciliation,
cancellation and reinstatement have no path to move a stored instant.

The enforcement is structural. `instance.ts` rejects a new or existing ceiling
over seven days. `store.ts` excludes
the column from `casInstance` and rejects a cast that tries to add it. Signup
retries read the snapshot; reconciliation handlers can use only that CAS
surface; `cancel.ts` changes subscription cancellation fields only; and
retained-office reinstatement does not change the setup window. A rollback
cannot turn an unsupported old row into a supported office or move its stored
instant.

An abandoned checkout keeps its name. Releasing one is slice-5 work with its own
ruling, and a state column nobody transitions is a claim the code cannot keep.

### Progress, and what the browser is not told

`progress.ts` projects rows into steps. The ladder is DERIVED by walking
`nextKind` from the instance's own stored goal, so it cannot drift from the
chain the machine will run, and a goal of `live` promises no revocation step.
A step with no row is `waiting`, never `done`; `ambiguous` is "checking";
"ready" rests on a SUCCEEDED `verify_https` rather than on ladder position.
Each row also supplies the duration for that run of the step. While it is live,
the browser advances from the projection's control-plane clock anchor rather
than trusting the customer's wall clock. Once the row is terminal, the ladder
keeps the final duration from its creation time to the terminal write.

The common projection rows are one Store statement: scalar JSON subqueries
keep operations and attention reasons from multiplying each other, and the
projection still applies tenant scope before returning anything. A cancelled
office may make conditional lifecycle reads after that common snapshot.

The page polls a changing build every three seconds. An unchanged projection
does not stay on that cadence forever: `asOf` is excluded from its signature,
and after `STALLED_AFTER_MS` (20 minutes) without a material change it uses the
30-second ready cadence. The longest legitimate inactivity window in the build
ladder is 15 minutes. At that boundary the server adds deadline attention to
the projection and resets the unchanged timer, so work the server still calls
live cannot reach the slower cadence. Explicit customer actions remain fast.

Measured 2026-08-25 against a separate local PostgreSQL 18.4 instance with TLS:
after an equal-window loopback-background subtraction, one warm statement used
about 653 bytes and a new TLS/Postgres session added about 7.3 KB beyond its
query. These are planning coefficients, not Neon packet captures: certificate
chains and the managed proxy make the session coefficient the larger error
bar. They are kept separate because the 30-second browser cadence crosses the
web pool's 10-second idle timeout and makes each remaining poll cold.

Raw evidence never crosses. The extractor is an allowlist of typed, bounded
fields mapped to our own words - the installer's step marker (only if it still
looks like one), its phase, the liveness rung, probe counts. `last`, `busy`,
`detail`, `timer`, `expiry`, `runId` and anything a later handler adds stay
invisible until somebody adds them here on purpose. Attention gets the same
treatment: the customer view carries the reason CLASS and severity, never the
operator-facing string, which interpolates remote output at several raise sites.

An adopted box has no `create_instance` row and never will, so the projection
omits that step and says `origin: "adopted"` instead of leaving it waiting
beside real progress. It is decided from rows - no create row, an asset
carrying a provider id, at least one operation - not from a flag. LINKED MEANS
A PROVIDER ID AND NOTHING MORE: asset state tracks the provider's lifecycle, so
requiring `active` made the first reconcile against a cancel-dated box put the
create step back beside a running install.

Two things the page may not overstate. Our key is reported as `held` until a
revocation has SUCCEEDED, and the ceiling is worded as a latest-possible
instant rather than a promise about when the key goes; after proof the page says
the key is gone, instead of contradicting the "Removing our access - done" line
directly above it. And "no charge" needs an ACTIVE full discount - 100% off with
`discount_ends_at` null or still in the future - because a cached discount that
has already ended is not a reason to tell somebody they are not being billed.

### Driving a signed-up instance against a real box

`exercises/adopt-run.ts` links a signed-up instance to an existing run record,
and `cli.ts run` drives it from there: handlers resolve the run record from
`instances.run_id`, so a tick needs nothing else to work on a row it did not
create. Automatic signup runs use `run-<uuid>` as `runId`, deliberately keeping
operator commands in a separate namespace. A mistaken command that derives
`inst-<runId>` can create a visible, cleanable phantom row; it cannot silently
change the goal of the paying customer’s `inst-<uuid>` row. The general
missing-asset fallback uses `asset-<instanceId>`; automatic signup never reaches
it because signup already created `asset-<uuid>`.

Both modes decide every mutable precondition INSIDE the transaction that writes,
so two callers cannot turn a pre-check into duplicate work:

```
bun control-plane/exercises/adopt-run.ts [--db <dsn>] --instance inst-<id> --run <runId> --start
bun control-plane/exercises/adopt-run.ts [--db <dsn>] --instance inst-<id> --run <runId> --revoke
```

`--db` is optional since D4 (2026-08-12), and its absence is the deployed shape:
the run record and its key live on the provisioner's own volume, so the linking
runs THERE, and there the database string is a secret in the environment
that must not be re-typed into an argv the process table shows to anybody.
Without the flag it comes from `CONTROL_PLANE_DB`, through the same reader every
other command uses, which still has no default. The store is opened with
`openRuntime` rather than `open`: this links rows in a database an operator
already built, and a restricted role meeting the schema-writing open fails with
42501 - which is exactly how the first web cutover died on 2026-08-12.

`--start` requires an unlinked instance, an asset with no provider id, and no
operations; it links both rows, audits and opens `wait_for_ssh` atomically.
`--revoke` requires the SAME linked instance and run, the same provider identity
and host, and a succeeded `verify_https` - we do not revoke access to a box we
never proved was live. A repeat is idempotent: an active revocation is left
alone (and the attempt audited), a proven one is refused. Neither mode can open
any other kind of operation, and `create_instance` still has no handler
anywhere.

### The browser transcript

`e2e/signup-flow.e2e.ts` drives a real Chrome against a real dev server against
the real Stripe test account, and prints what it saw. It is deliberately not
named like a test: `bun test` must not pick it up.

```
bun /path/to/a/runner-that-reads-stripe-test.env-in-process.ts
```

Do not source the secrets file in a shell. The runner reads it inside the
process, passes only the required values to its child, and redacts child error
paths. Values in the file are single-quoted. `CONTROL_PLANE_PRICE_ID` and
`CONTROL_PLANE_COUPON_ID` are ordinary non-secret inputs to that runner.

Three things it found that no unit test would have:

- **Configuration was judged before input.** Checking our own price id ahead of
  the customer's name answered every bad name with "no price configured", and
  would have reserved names for a deployment that cannot sell anything.
- **A Checkout throw became a 500.** `openCheckout` returns its refusals, but
  the session step throws, which is right for the operator CLI and wrong for a
  form. The web catches it, logs the detail and shows a sentence.
- **A driver can lie by racing.** `waitForLoadState` resolves against the
  document already loaded, so the transcript reported the form's own URL while
  the redirect to Stripe was still in flight - and claimed Checkout was never
  reached when the session had been created. The POST is now issued with
  redirects off, so the transcript carries what the SERVER said.

One Stripe-side caveat worth writing down: `billing-cli.ts bootstrap` uses fixed
idempotency keys, so re-running it inside Stripe's 24-hour idempotency window
REPLAYS the original response - it printed ids for a coupon that had since been
deleted and a price that had since been archived. Its output is a record of what
was created once, not proof that those objects are usable now.

### The 4b transcripts, and why there are two

`e2e/handoff.e2e.ts` is the real-box driver: a real Chrome against a real dev
server against a real provisioner holding a real box. It is the primary
evidence, and it is the one that found the collection race described below.

`e2e/handoff-local.e2e.ts` runs the same surface with the BOX faked - real
store, real requests, real projection, real hold, real seam, real browser, but
a fake exec for the mint and a directly-marked revocation. It exists because
the real-box legs are gated on a certificate, and Let's Encrypt's
duplicate-certificate limit is 5 per week per name: a run that needs a fresh
`cp1.test.isomux.app` certificate cannot simply be repeated. Anything about how
an invite is HANDLED is real in both.

One defect a real browser found and no unit test would have: **the resend
collected against a stale operation id.** The page took the id from the polled
projection, which between the click and the next poll still described the
PREVIOUS mint - so a resend asked the provisioner for a link it had already
handed over and was told, correctly, that it was gone. The box had minted
perfectly well both times. The click now carries the id its own request
returned, and `handoff-local.e2e.ts` pins it.

### The production-server transcript, and the one thing it does not drive

`e2e/production-server.e2e.ts` is the evidence behind the matrix above. It
builds and starts the app under the runtime named on its command line, seeds an
office through the product's own `accountForDevSignIn` + `reserveOffice` path,
and drives a real Chrome against it: the signed-out redirect, the dashboard
showing THAT office's hostname and the ladder derived from its goal, the polled
`/api/progress/<id>` route, a second signed-in account refused the same office,
an internal instance-id route returning 404 for both the owner and a second
account, and the ops floor answering 404 before the operator grant and 200
after it. Its exit code means SERVES, not BOOTS.

Two mechanics are load-bearing and were both earned rather than designed:

- **The runtime is read off the process that owns the LISTENING SOCKET**
  (`ss` for the pid, then `/proc/<pid>/exe`), not off the command we spawned. It
  caught its own harness immediately: a previous cell's server outlived its
  teardown, `next dev` quietly moved to the next free port, and every check
  afterwards was interrogating the wrong process while passing. The port is now
  asserted free before a run and chased down by pid after one.
- **The sign-in ceremony is not driven, and that is a statement about the
  product, not a shortcut.** Measured 2026-08-10: `/api/auth/providers` under
  `next start` returns `{}`. The dev credentials provider is gated on
  `CONTROL_PLANE_DEV_AUTH=1` AND a non-production build, a production build
  settles the second half at build time, and the form is a client component whose
  public flag is inlined at build - so no runtime setting brings it back, which
  is exactly what that gate is for. (The `/signin` page around that form is
  prerendered again since 2026-09-05; that does not change the gate.) Google
  is the production ceremony and no OAuth client exists yet. The transcript
  therefore mints a REAL Auth.js session cookie with the deployment's own secret
  and proves what was actually in doubt: that an AUTHENTICATED request reaches
  store-backed pages under a production server. The second account's refusal is
  what makes that a claim about a durable account rather than about any signed-in
  caller. Relaxing the gate to drive a login would have traded the property for
  the proof of it.

  The obstacle is asserted rather than described. The transcript REQUIRES an
  empty provider list under `next start` and requires `dev` to be present under
  `next dev` - the same gate from both sides - and `web-boundary.test.ts` pins
  its two halves against the source of `auth.ts`, because the half that says
  `NODE_ENV !== "production"` is settled when Next compiles and no test process
  can observe the production answer from the inside.

## Cancellation, retention and the end of life (slice 5)

Three dates, and collapsing them is the mistake this section exists to prevent:

| date                              | whose           | what it is                                                                                                                                               |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graceEnd`                        | ours, proven    | `subscriptions.ended_at` + 7 days. The office **keeps serving** through it (design ruling 9 bought the provider month for exactly this).                 |
| `retentionEnd`                    | ours, an intent | one **calendar month** after the box was powered off (ruling 8: "1 month", not 30 days). The instant we ASK the provider to cancel. Not a deletion date. |
| `provider_assets.service_ends_at` | the provider's  | its paid-term end. The only date on which data actually disappears.                                                                                      |

Manager ruling **R-2026-08-10-3** settles the collision between the middle and
the last: "The asset is NOT cancel-scheduled during suspension - `cancel_asset`
is issued only at `deprovision_due`, and if the provider term renews meanwhile,
that renewal is an accepted cost, not a bug." So retention beats provider
billing convenience, up to one extra provider month per churn on top of the
grace month. Two consequences in the code:

- `service_state` becomes `deprovisioned` **only** when reconciliation reports
  the asset `cancelled` or `absent`. Our own deadline passing is a request, and
  a request is not a deletion.
- a reconciled `service_ends_at` EARLIER than `retentionEnd` raises a critical
  attention row (a promise at risk) and never shortens the customer's date.

### The anchor, and why it is `ended_at`

`lifecycle.ts` is pure arithmetic over durable rows - no store, no clock, no
I/O - so a month is tested without waiting one. Its anchor is
`subscriptions.ended_at`, which does not exist until the lifecycle may begin and
never changes afterwards. That choice removes a question rather than answering
it: **measured 2026-08-10**, cancel / un-cancel / re-cancel inside one period
leaves `current_period_end` untouched, so a period-derived operation id would
have been the SAME id across a reversal. With `ended_at` there is no id to
collide with until the subscription is terminal, and no lifecycle operation may
be opened before then.

Operation ids are derived - `op-<kind>-cancel-<subscriptionId>-<endedAt>` - so
the operations primary key refuses a second row permanently, terminal or not.
That is the same construction `suspensionOperationId` uses, and for the same
reason: the one-active index stops holding the moment a row goes terminal.

The retention clock reads `poweredOffAt` **from that exact operation's
evidence**, written on purpose by the power_off handler. Not "the latest
succeeded power_off": an account can carry a dunning suspension from months
earlier, and anchoring on it would start the deletion clock before the customer
had even cancelled.

### Deprovision is two operations, not one destroy

`cancel_asset` and `remove_dns` open together at `deprovision_due` and neither
waits for the other, per the design. Chaining them would let a DNS record nobody
has reaped hold open an asset we are still paying for.

The provider asset can end before `deprovision_due`, and then that phase never
comes. So the `ended` phase also opens `remove_dns`, on every pass, under the
same derived id. An office that passed through `deprovision_due` already has
that row and gets no second one. Without this, the office and wildcard records
would keep pointing at a provider address that can go to another customer.

On every pass, the lifecycle tick also clears an open liveness alert on a
`deprovisioned` office. Nothing probes such an office, so the alert is stale.
Reconcile stops reading an `absent` asset once its office is `deprovisioned`.

`remove_dns` deletes every A record at the exact office and wildcard names
through the configured Cloudflare target zone. It then re-lists authoritative
Cloudflare state and concludes only when both A record sets are empty. It does
not delete AAAA, TXT, CNAME, or records at any other name. An unrelated AAAA
record therefore survives and does not block deprovisioning.

### Contabo refuses a second cancel (measured 2026-08-10)

`POST /v1/compute/instances/203474835/cancel` against an already
cancel-scheduled instance returns **HTTP 422**, and changes nothing:
`assetState`, `powerState` and `cancelDate` are identical before and after. So
the no-op is in the EFFECT, not in the status code.

That matters because a crash between an accepted cancel and our own write would
otherwise leave the operation retrying into a permanent 422. `cancel_asset`
therefore RECONCILES on a refusal - it re-reads provider truth and, if the asset
is already cancelled or cancel-scheduled, concludes on that (evidence records
`adoptedAfterRefusal`). This is the design's own recovery rule; the live probe
is what showed it was load bearing rather than theoretical.

`exercises/cancel-asset-probe.ts` is that probe, and its guards are executable
rather than procedural: it refuses any provider id but 203474835, refuses unless
the provider ALREADY reports the instance cancelled or cancel-scheduled, and
exits non-zero on any delta in state, power state or cancel date. It is a
LOOP-SCOPED rig. The product handler deliberately accepts `active` too, because
after R-2026-08-10-3 that is the state a real deprovision meets - **and that
path is not exercised in this loop.** No live asset is cancelled here.

### A gone asset before the deadline is a BROKEN promise

`assetGone` ends the timeline whatever phase it was in - provider truth is
truth - but ending is not the same as ending on time. If the asset is
`cancelled` or `absent` before the instant the customer was promised, the data
end is still recorded (it is already gone; a row disagreeing with the world
helps nobody) and a CRITICAL attention row is raised alongside it. Without that,
the ordinary ended arm would record `deprovisioned` and `data_end` silently for
a promise we failed to keep.

PROVIDER TRUTH OUTRANKS THE OBSERVATION TIME here. A term that ended on 1 July
against a 17 July deadline broke the promise whether the reconcile that noticed
ran on the 2nd or the 18th, so the ended arm keys on the asset's own
`service_ends_at` and falls back to "is it early right now" only for a provider
that gives no usable end instant at all.

Both conditions carry a stable IDENTITY (`lifecycle-promise-at-risk`,
`lifecycle-promise-broken`) as the attention row's source id, and stable
sentences with no clock or provider date interpolated. Attention deduplicates on
(source, reason), so a sentence that moved would have opened a fresh critical
row on every tick - and lifecycle rows keep being scanned after
`deprovisioned`. The row's own `raised_at` is where "when we first saw it"
lives.

One of the two is REVERSIBLE and the other is not. A provider term that lapses
too early can be renewed, so the at-risk condition is raised while unsafe and
CLEARED with its audit when provider truth becomes safe again - an incident that
survived the fix is indistinguishable from one nobody dealt with. A promise that
was actually broken cannot be un-broken, so nothing automatic clears it. An
operator resolves it with `attention --resolve <instanceId>`, which clears only
that instance's open broken-promise rows and writes a `resolve_attention` audit
row for each. The ended arm keeps seeing the broken promise on every tick, so
the tick never raises it again for the same promised date; a different promised
date raises a new row.

The transition between them is a PROMOTION, and it is why the decision carries a
LIST of attention actions rather than one: an at-risk incident whose term then
lapses for real must clear the superseded row and raise the broken one IN THE
SAME TRANSACTION. Two commits would put a stale "renew the term" instruction on
the ops floor beside the incident saying the data is already gone.

The dated evidence lives in the AUDIT DETAIL, not in the reason. Both instants
that matter move or get overwritten - the provider's `service_ends_at` on
renewal, the observation time by definition - so neither may enter the dedup
identity, and neither may be left only on a row that a later write replaces.
`raiseAttentionIn` takes an optional `detail` for exactly this: the append-only
audit row carries `service_ends_at=... promisedUntil=... observed=...` while the
reason stays stable. A test asserts both exact instants are still readable after
the asset row has moved.

The comparison is against `promisedUntil`, not `retentionEnd`: before the
power-off there is no retention end yet, so a term lapsing inside the GRACE WEEK
would have been compared against nothing and the whole week left unwatched.
`promisedUntil` is `retentionEnd` once it exists and a projection from the grace
end before that - the power-off cannot land earlier than the grace end, so the
promise cannot expire earlier either.

### A gone asset on a subscription that is not terminal

If the asset is `cancelled` or `absent` while the office is not deprovisioned
and its subscription is not terminal, the lifecycle raises one critical row,
`lifecycle-asset-gone`, and clears it when the asset comes back or the office is
deprovisioned. Two paths raise and clear this row with one predicate
(`assetGoneAction`). For a subscription with a cancellation marker,
decideLifecycle does it. A subscription that was never cancelled (no `ended_at`,
no `cancellation_reason`) never reaches decideLifecycle, so the tick runs a
separate scan for it. The scan reads only never-cancelled subscriptions whose
asset is gone or whose office has the row open. Such a subscription keeps
renewing, so this is the case where we bill for a machine that does not exist.
When the subscription gets a cancellation marker, the scan drops it and
decideLifecycle takes over the same row. The provisioner's work schedule makes
the lifecycle pass due while either path has this row to raise or clear, so a
box lost after startup is seen on the next loop, not only after a restart.

### Resume, and the box that must never be resumed

`power_on` undoes a DUNNING suspension and nothing else. Four predicates, all
re-read inside the writing transaction: the latest relevant power_off was
dunning-driven, the cached Stripe status is healthy, the instance is
`suspended`, and no cancellation lifecycle has started. The fourth is the one
that matters - a cancellation-retention box is ALSO suspended and ALSO has a
succeeded power_off, and resuming it would restart a server the customer
cancelled. The resume's id is derived from the dunning episode, so a redelivered
recovery event cannot open a second one.

The suspension it selects is the LATEST succeeded dunning power_off, decided by
the `poweredOffAt` the handler recorded rather than by row order. Row order was
the first fix and is not a rule: operations are ordered by `created_at`,
millisecond timestamps TIE, and SQL promises nothing about tied rows - so
reversing whatever came back was a coin flip. The operation id breaks a genuine
tie deterministically. Getting this wrong left a paying customer's box off after
a SECOND dunning episode: the older row was selected, its `power_on` was already
there, and the answer was "already open". Also skipping episodes whose resume already
exists looks like the obvious extra safeguard and is worse: if the newest
suspension was already resumed, skipping it opens a resume on a STALE episode's
authority. Newest-first with no skipping says the honest thing instead.

`serviceStateAfter("power_on")` is `live`: `suspended` is a claim about what we
did to the box, and after a proven power_on it is no longer true. Whether the
office ANSWERS is the liveness axis, which the design keeps separate.

### Reinstating the retained office

Launch re-subscription keeps the reservation and provider asset. It creates a
new Stripe subscription and links it to the retained instance only after the
fetched Stripe object and the control-plane rows agree. The plan comes from
the instance's stored provider product, the price comes from that tier's
deployment configuration, and
the reservation's coupon and Stripe customer are reused. A changed plan,
coupon, or customer SSH key remains a refusal. No second provider asset is
created.

`reinstatement_attempts` is the durable bridge from the terminal subscription
to the new one. Its identity is derived from the terminal subscription. A
durable generation makes each replacement Checkout session a new Stripe
idempotency key without making a second logical attempt. The customer boundary
and Stripe's technical expiry are separate fields: `fence_expires_at` is always
the launch retention end; `stripe_expires_at` is computed when the Stripe call
is prepared and includes five seconds of transport/API-floor safety above the
measured 1,800-second minimum. That margin does not extend eligibility.

Checkout can start only while `now < fence_expires_at`. Acceptance and webhook
linkage both re-read the account history, reservation ownership, active asset,
suspended instance, exact succeeded cancellation `power_off`, absence of every
`cancel_asset` and `remove_dns` row, and customer access proof. Customer access
means an installed customer-key fingerprint or a succeeded handoff; a stored
login user is not proof. Linkage also refuses after any Checkout-expiry
operation starts. The attempt row is locked by linkage and by the lifecycle
tick, so linkage and expiry/deletion cannot both commit.

At the boundary, the lifecycle opens one derived `expire_checkout` operation
before either deletion rung. Its Stripe call runs in the operation handler, not
inside the lifecycle transaction. A refused or ambiguous expire call is
followed by a fetched Checkout read. `expired` permits deletion. `complete`
opens the stable refund/reconciliation incident on the retained instance and
then permits deletion. `open` or unreadable truth fails closed and permits no
deletion. The incident records `payment_status`: `paid` means refund or
reconcile; `unpaid` means monitor and reconcile if it clears;
`no_payment_required` means confirm and close because nothing was owed. A late
webhook never rescues the office after the boundary.

An open or unreadable Checkout keeps the expiry operation retryable and raises
critical attention; it does not consume the operation's derived id in a failed
terminal row. A missing Checkout session id is positive proof that no payment
URL was issued, so expiry records that attempt as expired without calling
Stripe. The provisioner refuses startup when its Stripe expiry capability is
missing. Checkout-create ambiguity keeps the same generation and Stripe
idempotency key; a definite create refusal records the generation expired so a
later click gets a fresh key and technical expiry.

Only after linkage commits does the webhook open the separate derived
reinstatement `power_on`. It is not a reboot, so the cancellation repower alarm
cannot open a corrective power-off. The accepted attempt is a lifecycle fact
that closes the old subscription's timeline. A later cancellation of the new
subscription starts a new timeline with ids derived from that subscription.

**Measured 2026-08-16 in Stripe test mode:** Checkout accepted a session expiry
1,800 seconds after call preparation. Manual expiry returned `expired`; the
probe left no subscription and no charge. Product code does not match an error
message when expiry is refused: it fetches the session and uses the normalized
status as authority.

The deployed provisioner schedules `lifecycleTick` as its own work class. It
runs on startup and when the one-row schedule finds lifecycle work due, not
after unrelated provider reconciliation or liveness. The classes stay
sequential in one process, so they cannot overlap. Compose keeps one provisioner
container running and restarts the same command; durable operation rows make a
restart resume rather than duplicate work. A failed lifecycle pass goes to the
journal
and does not refresh `tick_recent`. A per-subscription failure is counted and
reported as a problem while the next subscription and the next pass continue.

**Measured 2026-08-16 on the deployed provisioner before this change:** the
authenticated probe reported `provider_configured: true`, so opened
`power_off` operations have a registered handler. A direct lifecycle scan under
`cp_provisioner` failed with PostgreSQL 42501 on `subscriptions`; the widened
grant in `roles.ts` must be applied with the deployment. After deployment,
`tick_recent: true` in `/internal/health` proves both the operation and
lifecycle passes completed under the deployed role.

### Cancel and un-cancel

Stripe `cancel_at_period_end`, set from `cancel.ts` in three phases with **no
store transaction open across the network call**: a transaction that re-reads
ownership and writes the started audit row (which carries the idempotency key),
then the call, then a transaction recording the outcome.

The key is minted per user-initiated request from the audit sequence, not fixed
per subscription. Stripe replays a key for 24 hours, so with a fixed key a
cancel / un-cancel / cancel-again inside one day would replay the first response
and report success while Stripe applied nothing. A second key is safe here
because `cancel_at_period_end` is a STATE SET, not a create.

Nothing in this path writes subscription state: webhooks stay the only writer,
so the dashboard says "we asked, waiting for Stripe" until the projection
catches up. A remote success whose local audit write fails returns
`recorded: false` and is still reported to the customer as sent.

### What non-Managed Payments Stripe did at period end (measured 2026-08-10, API `2026-07-29.dahlia`)

This test-clock exercise created its subscription directly through
`POST /v1/subscriptions`. It remains non-Managed Payments evidence as of
2026-08-20: the Managed Payments run above measured neither the `payment_failed`
nor the `cancellation_requested` half of the discriminator.

Test-clock exercise: create, `cancel_at_period_end=true`, un-cancel, re-cancel,
then advance past the period end.

- **The terminal object keeps everything.** `status: canceled`,
  `cancel_at_period_end` still **true**, `items[].current_period_end` intact,
  `ended_at` present and **equal to the item period end exactly**,
  `cancellation_details.reason` still `cancellation_requested`.
- **`current_period_end` is null at the top level on every snapshot**, terminal
  included. `shapes.ts` reading the ITEM first is not a fallback nicety on this
  pin - it is the only correct reader.
- **Un-cancel fully reverts** `cancel_at`, `canceled_at` and
  `cancellation_details.reason` to null, so the reason tracks the CURRENT intent
  rather than a history. Re-cancelling restores the same values and leaves the
  period end untouched.
- **Only `customer.subscription.deleted` fires at period end** - no trailing
  `updated`, no invoice event. The event sequence was `created` ->
  `updated`(cape=true) -> `updated`(cape=false) -> `updated`(cape=true) ->
  `deleted`, and **the two middle updates share a `created` second**, which is
  live corroboration of why reconciliation re-fetches the object instead of
  ordering by event timestamp.
- Dunning cancellations arrive as `payment_failed` (observed 2026-08-09), so
  `cancellation_reason` is a usable discriminator between the two machines.

Incidental: attaching `pm_card_visa` returns a CUSTOMER-SCOPED payment-method
id, and the shared handle cannot be set as the invoice default.

## The ops floor (slice 5)

`ops.ts` is to operators what `requests.ts` is to customers: a listed verb
surface, pinned by the boundary test, so the operator side cannot grow as a side
effect of writing a page. Three verbs - `opsFloor`, `opsInstance`,
`acknowledgeInstance`.

Two rules shape all three:

- **the authority check and the work are ONE TRANSACTION.** Not merely "inside
  the service": a role read that commits separately from the work it guards is
  a role that can be revoked in between while the protected read or write still
  goes through. Each verb opens one transaction, re-reads `is_operator` inside
  it, and does the whole protected operation there - which is why
  acknowledgement needs `acknowledgeAttentionIn` rather than the wrapper that
  opens its own transaction.

  The read is `select is_operator ... FOR SHARE`, and the exact property is
  worth stating rather than gesturing at: **a revoke cannot commit while a
  guarded verb holds the share lock on that role row, and a revoke that
  committed BEFORE the verb began is observed by the verb and refused.** A plain
  SELECT takes no lock, so without it a revoke would land mid-verb and the verb
  would finish on an authority it no longer had. `FOR KEY SHARE` is not enough:
  it conflicts only with writers that change a key, and `is_operator` is not
  one.

  The lock order is `accounts` first, everything else after, in every
  transaction that touches the table - the granting CLI reads without locking
  and then updates the account row before it audits, so a blocked revoke holds
  nothing while it waits. That is what keeps the share lock from being half of
  a cycle.

- **refusal is indistinguishable from absence.** A non-operator gets the same
  `null` a missing instance gets, and the caller answers 404 to both. A 403
  would confirm the floor exists and that this account is not on it.

The overdue list reads `overdueOperations`, not `liveOperations`: a FAILED
operation past its ceiling is the one an operator most needs, and it is
precisely the row that leaves the live set. Succeeded work stays out.

The floor carries the operator-facing reason STRING, unlike the customer
projection, which strips it to a class. That difference is the point: an
operator is the audience the reason was written for, and a floor showing only "a
step needs a person" would be a pager with the message removed.

Authority is a column, granted only by the CLI:

```
bun control-plane/cli.ts operator --email <addr> --grant
bun control-plane/cli.ts operator --email <addr> --revoke
```

The email is a lookup key; what is stored and what every gate reads is the
account id plus the column. No sign-in path writes it (`ensureAccount` inserts
`is_operator` as an explicit 0), `casAccount`'s patch type excludes it, and the
one writer - `operator-admin.ts` - is forbidden in the web app's module graph.

`attention.ts` stays forbidden in that graph too, with no exception:
acknowledgement moved to `attention-ack.ts`, which imports the store and nothing
else, so the app can record "we have seen it" without reaching raise or clear.
Acknowledging is still not clearing - the reasons stay open and the instance
stays `needs_operator` until the condition itself goes away.

## Deployed operator runbook (D4 close, measured 2026-08-13)

The deployed acceptance pass completed on 2026-08-13 through adoption of a
prepared Contabo run. The hosted handler staged `/tmp/isomux-install.sh` from
the repository and ran it as a file. As of 2026-08-22, no recorded pass covers
the documented raw-GitHub transport. That pass did not test automatic ordering.
As of 2026-08-21, confirmed payment opens the paid create automatically,
prepares the run key before the provider call, waits for the provider address
in its own operation, and then continues the SSH chain.

The 2026-08-13 pass also covered Google sign-in, test-mode Stripe Checkout,
owner-invite claim, verified removal of the provisioner's SSH key, and
cancellation. Both `cp2` and `test-nil` are scheduled
to cancel. The temporary `STRIPE_TEST_SECRET_KEY` and
`CONTROL_PLANE_PRICE_ID` entries were deleted from Vercel Production and proved
absent; a clean redeploy of commit `e4f6313` then passed the environment, TLS,
anonymous-auth and unchanged-row gates. A signed-in browser finally proved that
signup refuses with `This deployment has no price configured yet`.

For a temporary Stripe window, the listener must always use the pinned config
and `--skip-update`. Without `--skip-update`, the CLI makes an update check
before doing the work the operator asked for. The secret is transported in the
listener child environment, never with `--api-key` in argv. The live consumer
and its short-lived signing secret die when the window closes. Remove both
Vercel test entries, redeploy from current source rather than cloning an old
deployment artifact, and prove both absence and the disabled signup response.

Importing an operator executable is not automatically read-only. In
particular, a module that calls the provider at top level makes a live provider
request when a diagnostic imports it. Operator entry points that can contact a
provider must put execution behind `import.meta.main`; diagnostics import only
side-effect-free functions.

The one box this exercise may touch is Contabo instance `203474835`, serving
`cp2.test.isomux.app`. It is cancel-scheduled and paid through **2026-08-29**.
That date is an operator obligation: confirm teardown, provider cancellation,
and the disposition of its data then. Do not inspect other account instances.
Delete the two provider-side SSH secrets after teardown:

- `isomux-cp-run-20260812130101-hc5b`
- `isomux-cp-run-20260812133231-c73w`

The provisioner state volume has no snapshots. That is deliberate
because snapshots would retain destroyed temporary private keys. The operator
restore procedure and the decision about what non-key state deserves backup
remain coupled: never enable volume snapshots as an ad hoc substitute.

No control-plane state is backed up. Keep snapshots of the state volume off.
The volume can contain a temporary provisioning private key, and restoring a
volume snapshot could resurrect a key after revocation proved it destroyed.
A control-plane recovery design is a separate follow-up with its own threat
model; office backup wording never covers this volume.

### Hosted security releases

Nil Mamano owns vulnerability response. Private reports use the address and
process in `SECURITY.md`. A release carrying the exact GitHub Release body line
`isomux-severity: security` produces sticky security-floor data on an
updater-managed office that still runs an older tag. A later ordinary release
does not bury that data. The existing banner does not consume the field, and
this slice changes no update behavior.

This is release machinery, not fleet enforcement. The customer still starts
the update. The control plane has no release-version check-in, update
credential, remote command route, or post-handoff SSH access. Liveness proves
only that the office answers; it does not prove which release answers. Do not
report a fleet patched percentage or a patch deadline from liveness evidence.

If a customer reports an update failure, use the updater status and recovery
procedure on the customer-controlled box. The control plane cannot inspect or
repair it after handoff. Hosted auto-apply, fleet evidence, response deadlines,
and any last-resort provider action remain blocked on the explicit decisions in
`internal-docs/security-release-policy.md`.

### Next hosted release: required deployment order

This order was approved after the 2026-08-13 customer pass. Future sessions
must keep it in this runbook rather than reconstruct it from task history:

1. From the exact committed release tree, run
   `bun control-plane/cli.ts migrate-customer-ssh-key` once against production.
   Prove the new columns are present before starting either runtime.
2. Deploy the provisioner and the web app: since 2026-10-06 both deploy from
   main on the Docker host ("Deploying from main"). A release that needs step 1
   follows the compatibility rule there. The Fly and Vercel commands that this
   step named before are retired.
3. Run one complete customer acceptance pass with a new office and a real
   customer SSH public key. Prove the key is installed, root SSH works, the
   built-in Isomux terminal remains unable to sudo, our temporary key is
   revoked, the customer key still works afterward, office links use the office
   name, and the handoff flow cannot revoke access before browser confirmation.
   The installer must complete without copying a missing file into the live
   provisioner.
4. Publish a current Isomux release only after the combined tree passes CI.
   Install or update the acceptance office through the real release channel and
   verify the Apps tab and current hosted capabilities.

Do not enable paid signup until every step above is green. A failed acceptance
pass leaves checkout disabled while the operator diagnoses it.

Two 2026-08-13 launch blockers came from the real pass. The Fly image lacked
`/app/deploy/install.sh`, so the provisioner could stage its wrapper but could
not start the installer; task `a8258f96` owns the permanent image fix. Also, a
fresh clone with only the root dependencies installed could deploy a healthy
Vercel build and then fail its LOCAL probe import (`next-auth/jwt` absent),
causing the safety gate to detach the healthy domain. The Vercel deploy path
and its probe were removed on 2026-10-15.

## Tests

The suite needs a local Postgres, and it does not skip without one:

```
docker run -d --name isomux-cp-pg \
  -e POSTGRES_PASSWORD=isomux -e POSTGRES_USER=isomux \
  -e POSTGRES_DB=control_plane_test \
  -p 127.0.0.1:5433:5432 postgres:18

bun test control-plane
```

Port 5433 so an already-installed Postgres on the default port is never what the
suite writes to. The address is a constant in `control-plane/testing/pg.ts`, and
CI runs the same image with the same settings.

The tests run against a real engine because what they assert is engine
behaviour: which of two compare-and-swap contenders loses, whether a partial
unique index refuses the second row, whether one transaction's statements can
reach another's connection.

Each test gets a schema of its own, carried in the connection string, so two
stores opened on the same string share state exactly as two stores on one file
did. Schemas are recycled between tests rather than created per test, for
efficiency.

Until 2026-10-15 the same suite also ran against the Neon `suites` branch
(measured 2026-08-11: 728 tests, 0 failures, 9m16s wall against 50s on the
local container). That target was removed with Neon.

`deploy/install-sh.test.ts` also scans install.sh for the heredoc defect as a
CLASS, at both stages: what install.sh's own shell expands, and what the helper
scripts it GENERATES expand when they later run. Quoting the outer delimiter
makes those bodies literal to install.sh, which protects them then and not at
all once the helper is installed and executed under its own shell.

The stub tier needs no box: the adapter runs against recorded fixtures through
an injected transport, the driver against a fake process seam, and `wrapper.sh`
against a fake installer in a temp tree - which is how generation isolation,
exit capture, single-flight and crash detection are proven, since a live run
cannot be made to violate them on demand.

## Stripe mode boundary

`CONTROL_PLANE_STRIPE_MODE` is the only mode decision. An absent value means
`test`; the other accepted value is `live`. Live mode is valid only on the
production Vercel deployment or the VPS production runtime. An
unknown value or an unidentified runtime stops before a Stripe client or
webhook processor is constructed. A key prefix confirms the configured mode;
it never selects it.

Test mode reads `STRIPE_TEST_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Live mode
reads `STRIPE_LIVE_SECRET_KEY` and `STRIPE_LIVE_WEBHOOK_SECRET`. The live API
key must be a restricted `rk_live_` key; an `sk_live_` account key is refused
before any request. Events and fetched objects must also match the configured
mode before dedupe, fetch, or database work.

Issue one restricted key per deployment; never share one value between the web
tier and the provisioner. The web call graph needs Coupons read, Customers
write, Checkout Sessions write, and Subscriptions write. Checkout creates a
Customer when it starts a subscription without an existing customer id;
cancel and un-cancel update the Subscription. Stripe's write permission
includes read, as documented on 2026-08-20. The provisioner has a broader call
graph: it also expires Checkout Sessions, reads subscriptions and invoices
during reconciliation, and runs dunning and suspension. Separate values keep a
public web deployment from inheriting that broader reach. Code cannot detect a
shared value, so this separation is an activation rule.

These boundaries have two deliberate costs. No local run can reach live Stripe,
including an operator run. The production web deployment can hold only the live
key, so it cannot be exercised against Stripe test mode. Preview holds neither
live Stripe value. Tests use explicit test mode except for named synthetic
live-mode unit cases with injected transports; fixture scrubbing remains
unconditionally test-only.

Opening the code gate does not activate billing. The operator must still create
the restricted live key, live webhook endpoint and signing secret, and live
Prices covered by the activation tasks before selecting live mode.
