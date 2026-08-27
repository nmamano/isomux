# Control plane: provider adapter and SSH driver

## Hosted certificate configuration

The provisioner refuses hosted certificate work unless its target is complete.
Fly supplies the pinned production CA, Cloudflare API, and renewal endpoint from
`deploy/fly.toml`. The deployment must also supply these secrets:

- `ISOMUX_CF_ZONE_ID`: the one production zone that the token can edit
- `ISOMUX_CF_TOKEN`: a token limited to DNS records in that zone; it writes
  ephemeral ACME TXT records and permanent office A records
- `ISOMUX_ACME_EMAIL`: the ACME account contact

Stage and verify only these values with
`bun control-plane/deploy/certificate-secrets.ts` and
`bun control-plane/deploy/certificate-secrets.ts --verify`. The importer reads
`~/.config/isomux/control-plane-certificate.env` as a strict 0600 file and cannot
touch database, invite-seam, or provider credentials.

The provisioner's Stripe credentials have the same isolated route:
`bun control-plane/deploy/stripe-secrets.ts` stages them and
`bun control-plane/deploy/stripe-secrets.ts --verify` checks their names. The
importer reads `~/.config/isomux/control-plane-stripe.env`, a strict 0600 file
built from the human-facing `~/nil/secrets/stripe-test.env` source on auntie.
Do not edit the control-plane copy as an independent source. It accepts only
`STRIPE_TEST_SECRET_KEY` with a test-mode `sk_test_` or `rk_test_` value and
`STRIPE_WEBHOOK_SECRET` with a `whsec_` value.

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
bun control-plane/cli.ts attention [--ack <instanceId>] [--by <name>]
bun control-plane/cli.ts status  --run <runId>
bun control-plane/cli.ts expiry-test --run <runId> --variant boundary|powered-off [--seconds N]
bun control-plane/cli.ts bootstrap                # an empty database -> schema-ready
```

A rebuild always issues a fresh hosted TLS key and certificate. The TLS-key
carry shipped in commit `dd21dd5` and was later deleted per Nil's ruling. The
adapter compares complete normalized SPKI keys and forces one renewal if lego
returns the wiped box's stale chain. That costs one duplicate-certificate slot.
A second mismatch fails with operator attention instead of returning stale
material or looping.

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
image, not by a person: `--bind` moves the invite seam off loopback (`::` there,
because fly reaches a machine over IPv6 and a Bun server bound to `0.0.0.0`
answers IPv4 only - measured 2026-08-11), and
`--deployment` carries an opaque release id that the state marker uses. Neither
has an environment variable, because both are properties of how this process was
started rather than of the machine it runs on. See "Deployed: the provisioner on
fly.io".

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
condition itself goes away.

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

`exercises/neon-redaction.ts` is the standing check: four deliberate connection
failures against a real endpoint, scanning message, stack, `String`,
`JSON.stringify` and the whole cause chain, with one positive control PER
COMPONENT - the password, the role, the host, the endpoint id alone, the
database name, the whole `options` value and a single token out of it - each of
which must be caught by the same scan, plus a synthetic DSN with a
one-character role, password and port to pin that no length is exempt.

It also carries the check no component scan can make: for each failure it asks a
BARE pool for the same connection, captures what the driver itself said, and
requires that exact sentence to appear on none of the surfaces we emit. A driver
message is free text rather than a DSN component, so nothing else in this file
would have noticed it crossing.

### What a managed Postgres actually gives this build (Neon, measured 2026-08-11)

The project is `isomux-control-plane` (Postgres 18.4, aws-eu-central-1). This
section used to be documentation - "nothing here has run against Neon". It is
now a record of runs, and the first thing those runs found is that one
paragraph of it was wrong in a way that mattered.

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
  `exercises/neon-api.ts` sets `verify-full` on every string it builds.
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
  `exercises/neon-api.ts` takes the direct host from the API's endpoint record
  rather than by editing a hostname, and refuses a pooled one outright;
  `deploy/endpoint-posture.ts` is the standing re-measurement.
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
  branch. That is what makes the branch guards below proofs rather than
  conventions: a connection string can name any host, and the branch serving
  the connection is the only thing that knows which branch it is.

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
- **The provisioner is not granted `instances` INSERT or any write to
  `name_reservations`**, because instance rows and reservations are created at
  signup.
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
`cmdRun` calls must equal `AUDITED_CMDRUN_SURFACES`. A handler or a surface
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

An allowlist in `deploy/vercel-api.ts`, and the absences are as much of the
contract as the entries. Preview carries only `CONTROL_PLANE_DB` and
`AUTH_SECRET`. Production also carries `AUTH_URL`, `CONTROL_PLANE_MINT_URL`,
`CONTROL_PLANE_MINT_TOKEN`, Google's two values, `CONTROL_PLANE_STRIPE_MODE`,
the restricted `STRIPE_LIVE_SECRET_KEY`, and the Entry and Poweruser Price ids.
The target-specific inventory refuses any live Stripe value on Preview.

Refused by name, not merely absent: every Contabo credential, the Neon API key,
the fly token, the branch pin, both dev-auth flags, the test Stripe key, and the
legacy single Price and Coupon names. A read of the Vercel inventory on
2026-08-20 found the original seven Production values and two Preview values,
with no Stripe value on either target. Stripe names had been swept into an
absence check built for infrastructure credentials while the web app had no
live signup path; no commit, comment or design note recorded a Stripe-specific
provisioner boundary. The inventory now matches the tier that creates Checkout
Sessions. `signUpOffice` still judges the customer's input and the selected
plan's Price before it reserves a name.

The boundary is worth stating precisely, because the web app plainly DOES hold
credentials: a Production database DSN, its own `AUTH_SECRET`, Google's client
secret, and the provisioner's bearer. What it holds none of is
INFRASTRUCTURE-PROVIDER credentials or provisioning key material - no Contabo
credential, no Neon API key, no fly token, no Vercel token, no protection-bypass
secret. It can talk to its own database and ask the provisioner for something;
it cannot create, destroy or reach a customer's box, and it holds nothing that
would let it. That is the whole reason the provisioner exists.

### Branches: which database a command is allowed to touch

Loop ruling 4: suites and transcripts run against a CHILD branch, and the
production branch receives SCHEMA ONLY - no test row, ever. Two mechanisms
enforce it, and they are independent on purpose.

`exercises/neon-api.ts` is the library and `exercises/neon.ts` the commands:

```
bun control-plane/exercises/neon.ts branches
bun control-plane/exercises/neon.ts branch --create suites
bun control-plane/exercises/neon.ts branch --delete suites
bun control-plane/exercises/neon.ts measure --branch suites
bun control-plane/exercises/neon.ts run --branch suites -- bun test control-plane --timeout 30000
bun control-plane/exercises/neon.ts bootstrap --branch production
bun control-plane/exercises/neon.ts govern --branch suites
bun control-plane/exercises/neon.ts regovern --branch suites [--reverse]
bun control-plane/exercises/neon.ts ungovern --branch suites
```

- **A connection string is never read whole.** The direct endpoint host comes
  from the API's endpoint record; the role, password and database name come
  from the env DSN, whose host is discarded; the two are combined in the
  running process and the result is never written to disk, echoed, or passed as
  an argument. Manager ruling 2026-08-11, after the env file turned out to hold
  the pooled host. Stripping the `-pooler` label is a fallback only, and it is
  gated on a live connection whose branch id matches the API's.
- **The project is matched by name**, and any other refused: the API key is
  account-wide.
- **`run` refuses the default branch**, and `bootstrap` refuses anything else.
- **Every line these commands print is a boolean or a count.** No host, role,
  endpoint id, database name, branch id or DSN, on any path, error paths
  included.

The second mechanism does not trust the first. `testing/target.ts` is called by
`testing/pg.ts` before the first schema is acquired and by
`e2e/production-server.e2e.ts` before it seeds anything: it reads
`neon.branch_id` from the session, asks the API for the branch the tooling
targets, and requires the two ids to be equal and that branch to be a
non-default branch with a parent. An absent setting, an API that cannot answer,
or any mismatch REFUSES. There is no "assume child" arm and no flag that skips
it - so pointing `CONTROL_PLANE_DB` at production and running `bun test`
directly is refused by the harness itself, which is the bypass the first
mechanism cannot see.

A local DSN is the other allowed target, allowed by identity rather than by
exception: `LOCAL_DATABASE_URL` is the throwaway container on 5433, so CI and a
contributor's `bun test` never reach the network and are unchanged.

### Bootstrapping a branch, and the two booleans

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
`exercises/neon.ts bootstrap`, which establishes it from two directions before
a single statement is written - the API says the branch is the default with no
parent, and then the engine's own `neon.branch_id` says that is the branch
answering.

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

The storefront is a Next.js app inside a repository that already belongs to
something else, and that sentence is the whole difficulty. Every step below is
here because a deployment failed without it, and the failures are recorded
rather than tidied away: a procedure that reads as though it were designed in
one pass would hide the two constraints that will still be true next year.

The project is `isomux-control-plane` in Nil's personal scope, Root Directory
`control-plane/web`, framework `nextjs`, with `sourceFilesOutsideRootDirectory`
enabled. `buildCommand` and `outputDirectory` are deliberately unset, so
framework detection chooses them; `installCommand` is set, and is the one thing
that could not be left to detection.

```
bun control-plane/deploy/vercel-capability.ts     # read-only: token, CLI, live settings, upload size
bun control-plane/deploy/artifact-local.ts        # build the artifact and prove it, locally
bun control-plane/deploy/vercel-archive-deploy.ts # the settings, the artifact, one preview
bun control-plane/deploy/vercel-diagnose.ts       # why did a build fail? closed vocabulary
```

### The artifact is not the repository, and three files say so

A CLI deployment uploads a directory, and **the directory it uploads is what
governs the build** - not the project's Root Directory setting. That single fact
produced two of the four failures. So the artifact is a `git archive` of HEAD
into a throwaway directory, with exactly three transformations
(`deploy/artifact.ts`), each proved by comparing file manifests before and
after rather than by trusting the code that made them:

| transformation         | why                                                              |
| ---------------------- | ---------------------------------------------------------------- |
| remove `vercel.json`   | it is the landing page's build configuration, and it wins        |
| replace `package.json` | dependencies must resolve from `control-plane/`, which is above  |
| replace `bun.lock`     | a lock describing the office manifest cannot be frozen-installed |

The replacements come from `control-plane/deploy/vercel-root/`, a manifest pair
of its own: `pg` and `@types/pg`, private, no scripts. It is deliberately NOT
the provisioner's `deploy/package.json`, which is a runtime manifest for an
image holding provider credentials and has no business carrying a build-only
type declaration. `deploy/artifact.test.ts` pins the two as separate contracts
and requires every spec in either to match both the repository root and
`control-plane/web` exactly, so neither can drift.

The repository itself is never touched. Every original is digested before the
artifact is built and compared afterwards, and the digests stay in memory.

### The install command, and why detection could not choose it

```
cd ../.. && test -f control-plane/web/package.json && bun install --frozen-lockfile && cd control-plane/web && bun install --frozen-lockfile
```

Two frozen installs, root first. Vercel installs in the Root Directory, so
dependencies land in `control-plane/web/node_modules` - and `pg` is imported by
`control-plane/store.ts`, which sits ABOVE that directory, where a bare
specifier resolves by walking UP and finds nothing. The root install is the
ancestor install that fixes it, which is the same move `deploy/Dockerfile`
already makes for the provisioner by installing its manifest at `/app`.

`@types/pg` is there for the same reason one level further out: `next build`
type-checks `../store.ts`, and TypeScript resolves TYPES from the importing
file's directory upward, so the web package's own devDependency is invisible to
it. Measured 2026-08-11: without it the build fails `TS7016` while every module
resolves perfectly well.

The `test -f` is a fail-closed anchor. The command starts in the Root
Directory, so `cd ../..` is the artifact root only while that holds; if it ever
stops holding, the build stops rather than installing something somewhere else.

### What the four preview deployments measured

Every one of these was a real deployment, and each answered exactly one
question (2026-08-11, source `d294c96`).

1. **CLI run inside `control-plane/web`** - `rootDirectoryMissing`. Vercel
   applied the Root Directory to the uploaded directory and looked for
   `control-plane/web/control-plane/web`. The upload's root is what counts.
2. **CLI run at the archive root, `vercel.json` kept** - the build ran the
   LANDING PAGE's demo-and-docs command and never mentioned `control-plane/web`
   at all. A `vercel.json` at the upload root outranks the project's settings,
   so the artifact has to drop it.
3. **`vercel.json` removed** - a real Next.js build inside `control-plane/web`,
   with no trace of the landing page, and `../../` imports RESOLVED. That is the
   answer to the question the whole approach rested on:
   `sourceFilesOutsideRootDirectory` works. It failed on one package, `pg`.
4. **Ancestor manifest and install command** - `READY`.

The fourth was run only after the entire shape reached a green `next build` on
a developer box through `deploy/artifact-local.ts`, which makes the same
artifact, runs the same install command from the same starting directory, and
runs the same build. Three deployments had failed for three different reasons by
then, and moving the loop off the network is what stopped it being four.

### Who can reach it, and when that changes

The project was created with Vercel Authentication already on, at
`ssoProtection.deploymentType: all_except_custom_domains`. Two consequences, and
they are opposite in sign:

- **Before a custom domain exists, the `*.vercel.app` URLs are not publicly
  reachable at all** (measured 2026-08-11): every request, including
  `/api/auth/providers`, answers `302` to Vercel's own SSO. That is a real
  safety property while the deployment is being built out, and it is also why
  the first round of application probes proved nothing - they were talking to
  Vercel, not to us, and are recorded as inconclusive rather than as passes.
- **`cloud.isomux.com` is attached, so the exemption applies to it**, and the
  intended public exposure has begun (2026-08-11). Any Google account can sign
  in, and a sign-in BINDS AN ACCOUNT ROW in Neon production. That write surface
  is the deliberate one; there is no other, and it is the reason the production
  probes mint a cookie for an account that does not exist rather than seeding
  one.

Automated probing of a protected deployment needs Vercel's Protection Bypass for
Automation. Worth knowing before reaching for it: Vercel places that secret into
the deployment's own environment as `VERCEL_AUTOMATION_BYPASS_SECRET`, so it is
not invisible to the application, and its documentation offers the value as a
query parameter as well as a header.

### The certificate, and the ordering it forced

`cloud.isomux.com` is live: a production deployment serving it against Neon
production, with a verified certificate and Google as the only configured
sign-in provider (2026-08-11). Getting there settled an ordering question that
is worth recording, because the obvious sequence did not produce a
certificate while it was watched.

What the deployment holds, measured 2026-08-11 after the first real sign-in: ONE
`accounts` row, bound to a Google subject, and zero rows in every other user
table. That row is the deliberate write surface and the only one - a sign-in
binds an account, and nothing else in this deployment writes user data. It was
created by the first real sign-in and confirmed from a browser at ~18:3xZ the
same day: the home page showed the signed-in identity and the no-office card,
which is the whole store-backed path working against Neon production. A second
sign-in from a fresh private window later the same evening bound to the SAME
account rather than making another - `bindGoogleSubject` finds the existing
Google subject - so the count is one because the binding is idempotent, not
because nobody tried twice.

**The first interactive sign-in also found a bug, and it is recorded here
because the transcript reads as a failure and was not one.** The OAuth round
trip completed, the account bound on the first attempt, no error was logged, and
the browser still returned to a sign-in page offering to sign in. The cause was
in this repository rather than in any deployment setting: `app/signin/page.tsx`
called `signIn("google")` with no `callbackUrl`, and Auth.js therefore returned
the user to the page the flow started on - `/signin`, a client component that
never asks whether anyone is signed in, served from the prerender cache. Every
click succeeded and every click looked identical to failure. The dev provider
next to it passes `callbackUrl: "/"`, which is why no earlier transcript caught
it: dev-auth is what every previous run exercised, and Google only becomes
reachable on a real deployment.

Both halves of the fix shipped the same evening (commit `439ef15`, redeployed
2026-08-11): the Google call now names `callbackUrl: "/"` like the dev call
beside it, and `/signin` became a server component that asks `auth()` and sends
an already-authenticated visitor to `/`. Either alone ends the loop; together
they also cover a visitor who reaches `/signin` by some other route while
holding a session. The build output is the proof that the second half is real -
`/signin` moved from `○` (static, prerendered) to `ƒ` (dynamic), because a
prerendered page cannot know whether anyone is signed in.

**The redeploy proved less than the first deployment did, on purpose.** It read
no credential and wrote no environment variable, so it could not mint a session
cookie: the synthetic authenticated store checks and the deployed-web bearer
round trip were NOT repeated. `AUTH_SECRET` is write-only by design and the
coordinator that generated it is gone, which is exactly the cost the environment
section above describes rather than a new concession. What it did prove: the
artifact came from the committed fix, no credential was read, no environment
entry changed, the inventory was exactly 2+7 before and after, the row counts
were unchanged at one account throughout, and the anonymous suite was green.

The authenticated half of the acceptance is therefore a browser, not a probe,
and it is recorded as measured on 2026-08-11: a private-window sign-in from
`/signin` landed on `/` showing "Signed in as ... / You have no office yet",
with no bounce and no loop. Taken with the root-page check from the same
evening - which proved the ORIGINAL session had survived the whole time - the
defect and its fix are both confirmed from a real browser against the deployed
production, which is the only place either could be seen at all.

The obvious sequence is: attach the domain, wait for DNS, wait for TLS, then
deploy something once the hostname is known good. What was measured instead is
below, all times UTC on 2026-08-11.

The continuous readings are not this tooling's: they come from a 15-second HTTPS
watcher run by the operator in a separate session - one uninterrupted background
`curl` loop, started around 15:45Z, exiting on its first non-000 answer. Its
first-success timestamp is the mtime of that loop's output file, and the file
recorded HTTP 200 with a verified Let's Encrypt certificate. The manual 000
readings at 16:03:18Z, ~16:25Z, 16:45:27Z and 17:06:17Z are from the same
operator's transcript. The `READY` timestamp is from the Vercel deployment
record.

| time      | observation                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12:51Z    | domain attached; the authoritative per-project CNAME derived and handed over                                                                                    |
| ~15:40Z   | the CNAME installed at the registrar                                                                                                                            |
| ~15:45Z   | a watcher begins polling `https://cloud.isomux.com` every 15 seconds                                                                                            |
| 16:04Z    | Vercel reports the configuration accepted: `misconfigured` false, ownership verified, zero outstanding challenges, observed CNAME exactly the handed-off target |
| 16:05Z    | a read-only certificate-list query finds no account certificate covering the hostname; the TLS handshake closes without a response                              |
| 17:21:51Z | the first production deployment reaches `READY`                                                                                                                 |
| 17:22:02Z | the watcher still records no HTTPS answer - `READY` + 10.5s                                                                                                     |
| 17:22:17Z | the watcher's first success: HTTP 200 with a verified certificate - `READY` + 25.5s                                                                             |

So the certificate appeared inside a 15-second window beginning ten seconds
after the deployment went READY, ending **97 minutes of continuous
15-second-resolution absence** - 77 of those minutes with Vercel reporting the
configuration entirely correct. The certificate's own validity window is
consistent with issuance in the minutes before 17:22Z.

**This is an inference, not an established platform rule.** It is one
chronology. It does not prove that Vercel never issues a certificate for an
attached domain before a production deployment exists, and the closing sentence
of a run is a bad place to legislate somebody else's platform. What it does
establish is the procedure that works, and the one that does not:

```
attach the domain -> land DNS -> DEPLOY TO PRODUCTION -> bounded TLS wait -> probe
```

The reverse - waiting for TLS before deploying - produced nothing across 97
minutes of observation. Whether it would EVENTUALLY have produced one is not
something a single run can answer, and this does not claim it. `deploy/`'s
production phase therefore deploys first and waits for the certificate
afterwards, at absolute offsets from `READY` (+60s, +180s, +360s, +600s, +900s)
with a hard fifteen-minute deadline. In the live run the first check was enough:
`tls_reads: 1`.

### Running the production phase after a freeze

In a fresh clone, install both dependency sets. The second install supplies the
local production probe runtime. If that runtime cannot start, the phase refuses
before it reads the Vercel token and before it contacts a remote service.

```
bun install
(cd control-plane/web && bun install)
```

Then use one of three commands. The difference matters more than the flag
suggests: the default one WRITES the environment.

```
bun control-plane/deploy/production-phase.ts             # FIRST deploy: creates the eleven Production entries
bun control-plane/deploy/production-phase.ts --redeploy  # ships new code, writes nothing
bun control-plane/deploy/production-phase.ts --stage-live-env # creates only the four live Stripe entries, then stops
```

Anything else - a typo, an extra argument, `--redeploy=true` - refuses before
the token file is opened rather than falling through to the writing mode.

**Live-environment staging is a separate operator action.** It starts only
when Preview carries its exact two entries and Production carries its exact
seven-entry legacy shape, for nine entries total. It creates only the four
Production Stripe entries, reads back the inventory, and requires eleven
Production entries plus the unchanged two Preview entries, for thirteen total.
It cannot update, delete, deploy, probe, wait for TLS or detach the domain. A
partial write is reported and left for manual recovery. A re-run after success
refuses with a distinct already-staged message. The next action is a separate
`--redeploy` during task `9f69ed8e`.

The real staging run comes only after that activation task has registered the
live webhook endpoint and staged its signing secret, created the restricted
live web key, and created the live-mode Prices. Staging sets the fixed Stripe
mode to `live`; the following deploy makes that mode active on the storefront.

**First-deploy mode** expects Preview-only environment and an empty database: it
refuses unless Production carries no entries of its own and every user table
reads zero. That is why it cannot be re-run against a live deployment, and why
running it "just to see" is the wrong instinct - it is the mode that creates
credentials.

**Redeploy mode** was proved live on 2026-08-11 against the then-current two
Preview plus seven Production entries and remains the one to reach for when
only the application changed.
It requires the environment to be ALREADY exact at 2+11, reads no credential
file, generates nothing, and performs no
environment create, update or delete - the list of writes it iterates is empty,
so no mutating call is reachable. It deploys the committed `HEAD` artifact once,
waits for the certificate on the same bounded schedule, and runs the ANONYMOUS
suite only. It cannot repeat the synthetic authenticated store checks or the
deployed-web bearer round trip, for the reason the environment section gives:
`AUTH_SECRET` is write-only and the process that generated it is gone. Real
authenticated acceptance is a human signing in from a private window.
Detach-before-diagnosis and the TLS-timeout exception apply to both modes. A
local probe-runtime startup failure is a pre-deploy harness failure, not a
public predicate failure: it refuses before deployment and detaches nothing.
Once deployment starts, a real public probe predicate failure still detaches
before its transcript is printed.

**Redeploy mode asserts that the deploy changed no user data, and it says that
as a COMPARISON** (fixed 2026-08-12, task f5ed4b60). It was written with the row
state this deployment happened to have - exactly one account and nothing else -
frozen into it as a constant, which was true only while Nil's sign-in was the
whole of production and would have refused a perfectly healthy deployment the
moment the first customer office existed. The reading taken before the phase
runs is now the expectation every later reading is judged against, so what is
checked is that nothing MOVED. What a redeploy still demands of production is
what a wrong target would fail: EACH of the four user tables readable as a whole
non-negative number, and at least the one account production has carried since
2026-08-11 - an empty database under a redeploy is not production. Each, named
one by one, because a check over whatever keys the reading happened to carry
accepted a PARTIAL reading and would have let a live redeploy proceed having
established nothing about three of the four tables (reviewer finding,
2026-08-12). A first deploy still demands an empty database, and
that number is fixed forever.

The comparison says nothing about WHO changed a row: a customer signing up
while the deploy runs would trip it too. That is accepted rather than worked
around, because this phase is an operator action run deliberately, not a
background job.

The rest of this section describes first-deploy mode. One process, because a
`sensitive` value cannot be read back and only the process that generated
`AUTH_SECRET` can mint a session cookie for the deployment. It writes the eleven
Production variables, deploys once from the
transformed artifact, waits for the certificate, probes over HTTPS, and detaches
the domain before reporting anything if a predicate fails after the deploy was
invoked - including a failure that arrives as a thrown error rather than as a
verdict. There is ONE ruled exception: if the certificate never arrives inside
the fifteen-minute deadline, it parks with the domain still attached and
detaches nothing, because production never began serving and there is nothing
public to roll back.

**It runs against a frozen tree, and that took a fix.** The phase refuses to run
when a runtime path under `control-plane/` has an uncommitted non-doc change -
the artifact is `git archive HEAD`, so anything uncommitted would silently not
be in it. The guard used to test for that by dropping `??` lines from
`git status --porcelain` and treating the rest as modified tracked files, which
collides with the convention this repo freezes a tree with: `git add
--intent-to-add .` turns every untracked file into an ` A` index entry.
Measured 2026-08-11, 27 paths counted as dirty runtime paths and not one of them
was tracked, and the operator's workaround was to unstage, run, and re-add.
`deploy/tree-state.ts` now classifies against WHAT HEAD CARRIES instead: a path
HEAD does not carry cannot make the archive stale however the index is staged,
which is a fact about the commit rather than about a two-character prefix. The
phase also reports `paths_not_in_head`, so a freeze is visible rather than
merely tolerated.

### The environment, and what a `sensitive` value costs

Preview carries exactly `CONTROL_PLANE_DB` (the Neon **suites** branch) and its
own `AUTH_SECRET`. Production carries the production DSN, its own `AUTH_SECRET`,
`AUTH_URL`, the two Google credentials, the mint URL and bearer, the live Stripe
secret, the Stripe mode, and the two live Price ids. The two names that appear
in both scopes hold different values under disjoint targets, which is the point
of scoping rather than duplication.

That shape is also why the inventory is judged PER TARGET rather than by name.
Vercel's environment list is a flat set of entries, and a check that maps them
by key lets the Production `CONTROL_PLANE_DB` stand in for the Preview one - so
a missing Preview entry reads as a complete inventory. `deploy/`'s production
phase partitions by target first, requires every entry to name exactly one known
target, refuses a repeated key on the same target, and requires thirteen entries
in total: two on Preview and eleven on Production. The original nine-entry
shape was verified exact on the live run, 2026-08-11.

Every credential is stored `sensitive`, which on Vercel means **non-readable
once created** - not by the dashboard, and not by the token that wrote it. Six
values are deliberately `encrypted` instead: the site's own address, the
provisioner's hostname, Google's client id, the Stripe mode, and the two Price
ids. They are non-secret configuration whose exact values must remain readable
for verification. Making them write-only would cost that ability and buy
nothing.

The price of write-only is worth stating plainly, because it shapes the
procedure. A deployment never needs to know its own secrets - Vercel injects
them - so **redeploying is unaffected and nothing has to be rotated**. But
minting a session cookie to prove an authenticated page DOES need the secret, so
that proof can only happen in the same process that generated it, or through a
real sign-in. After that process exits, the secret still exists inside Vercel
and still serves the deployment; what is gone is our readable copy.

### What the instruments may say

Every program here prints booleans, counts, and values matched against fixed
shapes. The boundary is not "nothing identifying" - the production coordinator
prints the source commit, and the deploy tooling prints fixed public values such
as the DNS record it derived and the public origin it probed, because a DNS
record is meant to be read. What never leaves is a secret value, a raw response
body or header, a build log, a provider ACCOUNT or PROJECT identifier, a
fragment of a credential, or any child byte that did not match a fixed shape.
A public provider NAME is a different thing and is printed deliberately - the
probe reports that `google` is the only configured sign-in provider, which is
the point of the check. A build log
is fetched, judged into booleans, and dropped. `deploy/vercel-diagnose.ts`
carries a CLOSED vocabulary of failure classes and answers `unclassified` rather
than guessing, because a cause nobody listed is not a cause to invent.

Two of those instruments were wrong in ways only a working deployment could
expose, and both are now pinned by tests: an evidence boolean demanded the
literal string `bun.lock` and so reported failure on an artifact that
deliberately uses two lockfiles, and a failure classifier matched the bare
`--frozen-lockfile` flag that this build's own successful install command
carries.

**The repository root is linked to the landing page** (`.vercel/project.json`,
gitignored), so the CLI's default target in this tree is somebody else's
production site. The tooling never runs the CLI in the repository root, never
reads that link, keeps `isomux` on a refusal list checked by name AND by id, and
deploys from a copy that has no link file for a fallback to find.

## Deployed: the provisioner on fly.io

The design calls the provisioner the one component we operate, and the reason is
what it holds: the provider credentials, the key master and the tick loop, none
of which belong in a public web app. Deployed, that is one always-on machine in
Frankfurt, beside the database, in Nil's `personal` organisation.

```
bun control-plane/deploy/name-check.ts               # is the app name free?
bun control-plane/deploy/secrets.ts --canary         # does flyctl echo what it is given?
bun control-plane/deploy/secrets.ts --unset-canary   # remove that one fixed name
bun control-plane/deploy/secrets.ts                  # the FIRST-DEPLOY three, over stdin
bun control-plane/deploy/secrets.ts --verify         # are all boot-required names set?
bun control-plane/deploy/provider-secrets.ts         # the provider four, over stdin
bun control-plane/deploy/provider-secrets.ts --verify
bun control-plane/deploy/stripe-secrets.ts           # the Stripe key and webhook secret, over stdin
bun control-plane/deploy/stripe-secrets.ts --verify
bun control-plane/deploy/certificate-secrets.ts      # the certificate three, over stdin
bun control-plane/deploy/certificate-secrets.ts --verify
bun control-plane/deploy/preflight.ts                # may production be armed at all?
bun control-plane/deploy/activate.ts --plan          # what the arming deploy would run
bun control-plane/deploy/activate.ts --execute       # the one deploy that arms it
bun control-plane/deploy/provider-account.ts         # the provider account, read from the machine
bun control-plane/deploy/probe.ts                    # does the surface refuse everyone else?
```

### Activating the deployed Stripe listener

This is the real deployed endpoint, in Stripe TEST mode, with an `rk_test_`
restricted key. The provisioner rejects a live key, live event, or live fetched
object. Opening live mode is separate pre-launch work; see the task titled
"Open the hosted billing path from Stripe test mode to live mode."

Apply these steps in order. Keep steps 4-6 in one sitting. In test mode Stripe
retries a failed delivery three times over a few hours; after that, retry the
event by hand from Workbench or re-query the Events list and reconcile the
window. This retry budget was confirmed in Stripe's documentation on
2026-08-20. The product cannot take money before the separate live-mode work, so
a missed event in this activation window carries no real payment; re-run the
test-mode operation.

1. Create the restricted `rk_test_` key with Subscriptions read, Invoices read,
   and Checkout Sessions read and write. Set `STRIPE_TEST_SECRET_KEY` to it.
   Success means the Fly secret name is present and the old provisioner image
   remains healthy: these permissions cover its reads and its one
   `expire_checkout` write. Roll back by restoring the prior test key.
2. Merge the listener into `~/nil/isomux`. Success means the merged source
   contains `POST /stripe/webhook` and its tests. The matrix command reads its
   destination from the current source; running it before this step applies the
   old matrix and can report success while the webhook grants stay absent. Roll
   back by reverting the source change before any deploy.
3. From that merged tree, run
   `bun control-plane/exercises/neon.ts regovern --branch production`.
   A catalog read on 2026-08-21 found `PRIOR_WEB_GRANTS` and
   `PRIOR_PROVISIONER_GRANTS` exactly. The success report must say both
   runtime-role matrices and effective privileges are exact and user tables are
   unchanged. This command prepares the web role with three
   `reinstatement_attempts` verbs and lands seven pending provisioner verbs for
   subscriptions, Stripe events, accounts, and schema metadata. The deployed
   web build was created 2026-08-13T07:06:12Z. Commit `c8e543c` added the web
   reinstatement grants on 2026-08-16, so production was never re-governed for
   them and the running build predates the code that needs them. They are
   preparation for a later deploy, not a live failure. If the catalog, role budget, bounds,
   login state, or membership differs from the expected prior posture, the
   command refuses before its transaction opens and writes nothing. Roll back
   before deployment with the same command plus `--reverse`; reverse revokes
   the web role's three prepared reinstatement verbs and restores both rosters
   measured on 2026-08-21.
4. Register `https://isomux-provisioner.fly.dev/stripe/webhook` for
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, and
   `invoice.payment_failed`, and then read its signing secret. Success means the
   URL and exact five-event allowlist read back correctly. Do not disable the
   endpoint while waiting: Stripe drops events generated while a destination is
   disabled instead of retrying them. Roll back by disabling the endpoint.
5. Set `STRIPE_WEBHOOK_SECRET` to that signing secret. Success means both Stripe
   Fly secret names read back as present and the old provisioner image remains
   healthy; it ignores the new name. Deploying first makes `cmdRun` refuse to
   start and the machine crash-loop. Roll back by disabling the endpoint and
   restoring the prior secret inventory.
6. Deploy the merged provisioner. Success means the process and its authenticated
   health route are healthy. Deploying before step 3 makes valid deliveries hit
   database error 42501 and return HTTP 500; the cache stays stale until the
   matrix moves and Stripe retries. Registering the endpoint long before this
   step spends the test-mode retry budget on 404 responses. Roll back by
   disabling the endpoint and restoring the previous provisioner image.
7. Generate a real test-mode event for a known test subscription, and verify its
   delivery. Success requires HTTP 2xx, a `stripe_events` row for that exact
   event id with `outcome='applied'`, and the matching `subscriptions` row
   updated to the state fetched from Stripe. A 2xx alone is insufficient: an
   unknown subscription is legitimately recorded as ignored. Roll back the
   listener by disabling the endpoint; the system then returns to operator-held
   delivery, and any test fixture created for this check is cleaned up through
   the existing test-account procedure.

Every one of those prints fixed names and booleans: no connection string, no
token, no digest, no branch id, no app name other than this one, and nothing a
child process wrote. Every operation that HANDLES A SECRET or reads a listing -
the import, the canary and its cleanup, the name check, the external probe -
goes through one of them, which is why the canary's cleanup is a wrapper rather
than a bare `flyctl secrets unset` in the steps below.

The three account and deploy commands - `apps create`, `volumes create` and
`deploy` - are plain flyctl. The app-create command names `isomux-provisioner`
positionally; volume creation and deploy name it with `-a`. All three receive
`FLY_API_TOKEN` only in the child environment. Their argv and stdin carry no
secret value, and no argument is derived from one.

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

### The secrets, which program sets which

`CONTROL_PLANE_DB` (the direct-endpoint DSN), `CONTROL_PLANE_DB_BRANCH` (the
branch id that DSN must turn out to be) and `CONTROL_PLANE_MINT_TOKEN` (the seam
bearer) are the FIRST-DEPLOY three, set by `deploy/secrets.ts`. The four
provider credentials - `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`,
`CONTABO_API_USER`, `CONTABO_API_PASSWORD` - are set by `deploy/provider-secrets.ts`
and by nothing else. All seven are fly secrets; nothing secret is in `fly.toml`,
because this repository is public.

The lifecycle loop also requires `STRIPE_TEST_SECRET_KEY`, and the public Stripe
listener requires `STRIPE_WEBHOOK_SECRET`; their dedicated importer accepts only
a test-mode key and a webhook-signing-secret shape. Certificate work requires
`ISOMUX_CF_ZONE_ID`, `ISOMUX_CF_TOKEN` and `ISOMUX_ACME_EMAIL`; its importer is
separate too. `deploy/secrets.ts --verify` checks all twelve boot-required names
in one discarded listing, but the import path in that file remains limited to
the first-deploy three. Each narrow importer also has its own name check.

**The split is structural, and it is there because the tidy version was a
live-reachable defect** (2026-08-12). D4 first added the provider names to
`deploy/secrets.ts`'s allowlist - one importer, one procedure, obviously right.
But that program builds `CONTROL_PLANE_DB` from the operator's own env file, and
since D3.5's cutover that file holds the BREAK-GLASS OWNER string, deployed
nowhere. So an import run for provider credentials would ALSO have staged the
owner DSN, and the deploy that followed would have moved the provisioner off its
capped `cp_provisioner` role and back onto the owner - undoing
R-2026-08-11-1's closure as a side effect of a step about something else.

The lesson generalises past this bug: `deploy/secrets.ts` was CORRECT when it
was written, because at D2 the owner string WAS the deployed one. What moved
underneath it was D3.5's credential cutover, and nothing in the program said so.
A procedure that is merely no-longer-mentioned is one somebody follows from an
old transcript, so the two allowlists are now disjoint, `validatePairs` refuses
the other program's names before any child exists, and
`provider-secrets.test.ts` pins the disjointness - widening either list fails
the suite.

```
bun control-plane/deploy/provider-secrets.ts            stage the four
bun control-plane/deploy/provider-secrets.ts --verify   are the four set?
```

`deploy/secrets.ts` is one fail-closed process, and the shape is the point:

- It reads every source file INSIDE the process. No env file is ever sourced by
  a shell, and no value is ever expanded into a command line.
- **It re-establishes the credential file's shape itself**, because a check
  somebody ran earlier is a statement about a file that has since had time to
  change. `inspectMintFile` opens the file ONCE with `O_NOFOLLOW` and does
  everything through that descriptor: a symlink cannot be opened at all, and a
  path swapped between the check and the read cannot be reached, because after
  the open there is no path left to swap. From that descriptor it requires a
  regular file, the EXACT mode `0600` (compared, not sampled - a "no group or
  world bits" test passes `0400`), and CONTENTS that are exactly
  `CONTROL_PLANE_MINT_TOKEN='<40 lowercase hex>'` with at most the usual final
  newline. Not "one line after trimming": a leading space, a trailing space or a
  blank line are bytes nobody ruled, and this is the seam where a promised shape
  is enforced. The token is returned only when all four hold and is empty
  otherwise, so a caller that ignores the booleans still cannot use a file that
  failed them. What it prints is four booleans.
- **The provider file gets the same treatment through the same reader.**
  `inspectContaboFile` shares the descriptor-level checks exactly - one file
  inspector cannot be given a weaker version of the same guarantee by being
  written later - and differs only in the SHAPE it requires: the whole file is
  exactly the four ruled assignments, each name once, in any order, single
  quoted, with no export prefix, no comment, no blank line and no fifth line. A
  value carrying a single quote is refused rather than parsed, because this is
  not a shell. Four more booleans, and the values go to the child's stdin with
  the rest. Three of four is a REFUSAL, not a partial import: a machine holding
  some of the credentials authenticates to nothing and reports no reason.
- It proves the branch before it emits anything: the project must show exactly
  one default branch with no parent, that branch must be `production`, and
  `targetFor` must have taken the endpoint host from the API rather than from
  the fallback. A deployment pointed at a scratch branch is the failure this
  refuses, and it is the mirror image of what `testing/target.ts` refuses for
  the suites.
- It validates every line before any child exists - allowlisted name, no line
  break, no NUL - because a value carrying a newline could set a name nobody
  asked for.
- It spawns `flyctl secrets import --stage` with the API token in the CHILD
  ENVIRONMENT and the values on STDIN. Neither reaches argv, which the process
  table shows to everyone on the box.
- **It never hands the child's bytes back.** flyctl's stdout and stderr are
  captured, scanned, and dropped. That is stronger than "scan and forward if
  clean", deliberately: an exact-value scan cannot see a fragment, a
  re-encoding, or a truncation. `deploy/secrets.test.ts` plants leaks of all
  those shapes, including one the scanner is not expected to catch, and requires
  that nothing a caller could print contains them.

Diagnosing flyctl therefore means re-running it with a PUBLIC value, which is
what `--canary` is: `PROBE_CANARY=isomux-d2-public-canary`, published here so a
leak of it is an observation instead of an incident. It runs BEFORE the real
import, and if flyctl echoes it, nothing real goes near it.

The canary is an operation with NO ARGUMENTS, and `--unset-canary` removes that
one constant name through the same captured-output spawn. A mode that took a
name and a value would be a mode that could set any name, running at the moment
when nothing real has been imported yet; and a procedure with a hand-typed
secret name in it is one typo away from removing something the machine needs.
The cleanup has to SUCCEED before the real import runs - a probe left staged on
the app is a secret nobody meant to keep.

`--verify` answers `required_secret_names_present` for the full boot-required
set from a listing it parses and discards, because `flyctl secrets list` prints
a digest beside each name and a digest is derived from the value.

### What the machine proves about itself

At boot, before it serves or ticks:

- **The bounds.** `Store.open` returning IS the evidence - it built the
  `options` string and read both timeouts back from the engine, and refuses to
  return a store otherwise.
- **The branch.** `boot.ts` asks the session which branch answered
  (`neon.branch_id`, through the store's own scrubbed seam) and requires it to
  equal `CONTROL_PLANE_DB_BRANCH`. A mismatch, or a session that reports no
  branch at all, REFUSES to start. The pin is optional in code and mandatory in
  the procedure: unset means no claim was made, so `branch_pinned` is false
  rather than true, and a deployment that lost its pin is visibly not ok.

Neither branch id is ever printed. The boot line is booleans.

`GET /internal/health` answers the same booleans and the running release's
identity, behind the SAME bearer as the invite verb, and is the reason
`deploy/probe.ts` exists:

```
ok  bounds_governed  branch_pinned  database_reachable  tick_recent  state_persisted  provider_configured
```

The release identity has three independent arms. `release_source` names the
40-hex commit and the deploy-start time when the guarded activation program
built the image. `release_payload` names a SHA-256 that every image computes
inside the Dockerfile from the files actually installed in `/app`.
`release_deployment` names the Fly machine version carried by the existing
`--deployment` path. Measured 2026-08-20 at 11:09 UTC against the deployed
provisioner, then running a build older than `1a3613e`: `state_persisted` was
true, which `state-marker.ts` can report only when it received a non-empty
deployment id. The Dockerfile CMD has passed `--deployment` since `dcef44f`,
unchanged, so that reading carries to this build. Each arm is
either `{ known: true, ... }` with a strictly validated value or
`{ known: false }` with no placeholder value. A missing or damaged identity
file therefore makes no claim rather than returning an empty or default-looking
string.

None of the three identity arms enters `ok` or the probe's gating booleans. An
unknown identity does not stop the process from provisioning an office; it
stops an operator from claiming which build is running. The probe reports that
distinction separately and validates the exact nested shape before it prints
any value.

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
blinked is a boolean, not a dead machine: fly's check is TCP precisely so that
health is behind a credential and cannot be turned into a restart loop by an
outage upstream.

`deploy/probe.ts` sends the real bearer, so the origin it sends it to is a
CONSTANT in the file and there is no flag that can move it. An origin taken from
a command line is a way to hand a credential to whatever host somebody typed,
and every check in the output would still pass; there is one deployed
provisioner, so there is nothing an override could be for.

**And a 200 is not acceptance.** The probe requires the EXACT key set above - a missing key, an extra one, or a value that is not a boolean
all fail - and then requires `ok`, `bounds_governed`, `branch_pinned`,
`database_reachable` and `tick_recent` to be true. `state_persisted` is
deliberately outside that set, because on a first deploy there is nothing for it
to have survived, and `provider_configured` is outside it for the reason above. The keys are printed in a fixed order from that fixed list,
and a field nobody designed is COUNTED rather than named: the answer comes from
a machine, and a probe that echoes whatever it is sent is a way for that machine
to write into our transcript.

### Moving the provisioner onto its own role (G3), and getting back

The posture exists in the catalog from the migration above, but nothing
authenticates as `cp_provisioner` until this step: it is created NOLOGIN
precisely so a credential is only ever minted by a run that has somewhere to put
it. `deploy/provisioner-role.ts` holds the decisions and
`deploy/provisioner-move.ts` is the coordinator that follows them, with every
provider effect behind a seam so the orchestration is tested before it is
authorized.

**It is NOT `deploy/secrets.ts`, and the difference matters.** That program
stages the OWNER DSN - it resolves `targetFor(production)` and pushes all three
secrets - which is the opposite operation from this one. What G3 reuses is its
stdin boundary (`pushSecrets` and `fly-cli.ts`), not its command: the
coordinator builds the `cp_provisioner` DIRECT DSN in memory and stages that one
existing secret name. `secrets.ts --verify` is also not acceptance here - it
proves every boot-required NAME is present, not which value is staged or live.
The move coordinator uses that full name set as a guard against replacing a
machine with one that cannot boot. What says the deployment works is the probe
and the engine's own backend count.

FOUR PHASES, and the order is the whole procedure:

```
P0  preflight: the phase-defining catalog read FIRST (a read that fails
    there escalates - it is the only thing that can tell a fresh G2 state
    from an interrupted G3 one), then branch proved, owner DSN opens, owner
    bounds exact, role governed exactly, ONE STARTED MACHINE, source
    committed, tree clean
P1  alter role cp_provisioner with login password '<generated here>'
P2  the coordinator stages the new DSN over stdin (one secret name)
P3  flyctl deploy ... --ha=false --now, with the backend counter running
    THROUGH it (the staged secret goes live here)
P4  secret names present, the probe's whole transcript typed and its verdict
    recomputed green (waiting only for a machine that is up and not yet
    ticking), machine replaced per fly's own state, every sampled count <= 12
    and the settled count 1..5
```

No password exists until P0 passed: a refused run generates nothing. The
machine topology is read again immediately before the deploy - as its own step,
not inside it - because a machine added, stopped or destroyed between P0 and P3
breaks the arithmetic that makes the deploy safe, and a listing that cannot be
parsed refuses rather than deploying into evidence nobody can produce
afterwards. That read is separate so the sampled window contains the deploy
CHILD and nothing else: with the listing inside the deploy, a reading taken
beside it counted as overlap while proving nothing.

**Every child this program starts is bounded, and the unit of lifetime is the
PROCESS GROUP.** There is no unbounded spawn left on any path a run can reach
after the credential exists: a hung `secrets import`, machine listing, probe or
deploy would each hold a live credential open forever, and forever has no
recovery path. Two deadlines, both measured:

| child                          | deadline | basis (all 2026-08-11)                                                                   |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `flyctl deploy`                | 20 min   | this app's own deploys ran 64.8s and 72.6s, so ~16x the slower                           |
| listings, staged import, probe | 2 min    | read-only flyctl commands answered in 2.6s and 4.3s; the probe is five HTTPS round trips |

A probe run inside the readiness wait gets the SMALLER of that two-minute
deadline and what is left of the wait's own three-minute budget, so the last
attempt cannot run past it.

At a deadline the whole GROUP gets SIGTERM, twenty seconds, then SIGKILL; the
leader's exit is awaited (bounded - a leader a failed SIGKILL left running must
not restore an unbounded wait) and then `kill(-pgid, 0)` must report the group
EMPTY before the answer comes back. Children are spawned detached, which
measured 2026-08-12 puts each in a new group of its own - a plain spawn shares
the office's group, and signalling that would kill the session doing the deploy.

**What the emptiness proof actually claims, stated narrowly.** It is _the
original process group is empty_, not _nothing the child started remains_: a
process that calls `setsid` leaves the group and is outside both the kill and
the probe. The recovery's safety therefore rests on an executable assumption
that is written down rather than implied - the two children this program runs,
`flyctl` and the probe, do not daemonise or start new sessions (true of both as
of 2026-08-12). A future flyctl that daemonised would break it, and the fix
would be a non-escapable boundary - a cgroup or a transient systemd scope per
child - rather than a process group. The probe itself fails closed: only ESRCH
counts as empty, and EPERM (a process that exists and cannot be signalled),
EINVAL or any unexpected error all read as ALIVE, so `group_empty: false` is
reported rather than assumed.

Two things this replaced, both measured rather than reasoned:

- **Reaping the leader is not enough.** Killing a shell does not kill what it
  started, and a surviving descendant can still hold credentials and talk to the
  provider after the coordinator has begun recovering on the strength of "the
  child is gone". The test drives a descendant that would write a file a second
  after the leader dies and proves it never writes it.
- **A leader that exits 0 while its group lives is not a success.** Its exit
  code says what it thought, not what its children are doing - and the inherited
  pipe means waiting for end-of-stream waits for a process nobody is tracking.
  That case returns the same fixed ambiguous answer, and end-of-stream is never
  waited on unboundedly.

**A failed backend reading does not end the deploy either.** The sampler owns
the deploy's lifetime: a database hiccup mid-flight marks the measurement failed
and then waits for the child, because returning early would let the recovery
stage the owner DSN and start a second deploy over the first one.

P4 is the coordinator's own evidence, not a pair of commands. `secrets.ts
--verify` proves NAMES and would pass an app carrying the wrong value, and a
probe run by hand proves the surface at a moment nobody recorded.

**What runs it.** `deploy/provisioner-move-run.ts` is the executable: it binds
the coordinator's seams to git, the Neon API, the driver, flyctl and the probe,
and it is the only file in this pair that can touch a provider.

```
bun control-plane/deploy/provisioner-move-run.ts --plan           # prints the steps and the deploy argv
bun control-plane/deploy/provisioner-move-run.ts --source-state   # git only; no provider
bun control-plane/deploy/provisioner-move-run.ts --machine-state  # one read-only flyctl listing
bun control-plane/deploy/provisioner-move-run.ts --execute        # the move
```

Exit codes are the report a runbook step reads: `0` only for a completed move,
`2` refused before anything was written, `3` rolled back (a successful recovery
and still a failed move), `4` escalate - something is left for a person -, `5`
an unexpected failure whose text is deliberately not printed. Run
`--machine-state` before `--execute`: replacement is proved as a DIFFERENCE
between two listings, so the run refuses to deploy at all if fly's listing
cannot be parsed, and finding that out beforehand costs nothing.

`--machine-state` is operator reconnaissance, not the guard: the same topology
is enforced inside `--execute`, before the credential and again at the deploy,
because a command somebody ran earlier is a statement about a world that has had
time to change.

`--source-state` answers the question the guard asks, which is not the archive
question. `deploy/tree-state.ts` classifies for `git archive HEAD`, where an
untracked file cannot ship and a changed document cannot change behaviour; a fly
deploy sends the working DIRECTORY, so both of those ship. The guard therefore
counts every path `/.dockerignore` lets into the image - through the same
matcher `deploy/image.test.ts` asserts the rules with (`deploy/build-context.ts`)

- and ignores everything the rules drop, `control-plane/web` and the test files
  included. `/.dockerignore` itself must be tracked and untouched before its rules
  are trusted at all: it sits outside the copied path, so the count can never see
  it, while its working-tree bytes decide what that count is allowed to ignore.
  Expect the guard to refuse while a slice's own work is uncommitted; that is the
  check working.

`--stage` is load bearing. An unstaged import restarts the machine on the spot,
which would mean two restarts and a window where the machine runs a new
credential against old code; staged, the secret arrives with the one deploy.

The owner's bounds are required before the forward run as well as before a
rollback: the rollback deploys the owner DSN and the committed runtime opens it
through `openRuntime`, which refuses a managed session whose role configuration
is not exactly the governed pair. Starting a move you cannot reverse is the
thing this gate exists to prevent. A run also refuses unless the source is a
readable commit and the runtime tree is clean - a fly deploy ships the working
DIRECTORY, so an uncommitted tree is a machine nobody can reconstruct from git.

**Nothing is remembered between phases, so a resumed run reads the world.**
Process memory does not survive an interrupt and a lock file would be a second
thing that can be wrong, so the phase is derived from two facts that outlive any
process - whether the role can log in, and whether anything is connected as it:

| role can log in | backends | phase             | what it means                                                |
| --------------- | -------- | ----------------- | ------------------------------------------------------------ |
| no              | 0        | `clean`           | nothing done, or a completed rollback                        |
| yes             | 0        | `credential_set`  | P1 ran; P2 and P3 unknown - NOT evidence they did not happen |
| yes             | >0       | `credential_live` | the deploy took effect, whatever was reported                |
| no              | >0       | `contradictory`   | a session outlived its NOLOGIN - stop                        |

The recoveries follow from the reading, and they share one rule: **the
credential is disabled LAST**. Closing it while a machine is still pointed at it
turns a rollback into an outage.

- `credential_set` and `credential_live` - THE SAME PATH. Zero backends is not
  evidence that the staged value never went live: a deploy can apply it and
  leave the machine stopped, crash-looping or between boots, which reads
  identically to a stage that never landed. So every credential that exists is
  recovered as though it may be in a machine's configuration - stage the owner
  DSN, DEPLOY it, prove fly REPLACED the machine, probe the owner path green,
  watch a bounded series in which EVERY reading is zero, and only then `alter
role ... nologin password null`. Skipping the deploy would leave the next
  machine start pointed at a role it cannot authenticate as. The replacement
  check is there because a zero exit says flyctl finished, not that the machine
  running now is the one it deployed; the series is there because ONE zero is
  the same one-way evidence this design refuses everywhere else - a machine
  still configured for the role reads zero between two opens, through a restart
  and while it crash-loops. If any of that cannot be proved, LEAVE THE
  CREDENTIAL ENABLED and escalate: a disabled credential under a live machine is
  worse than a live credential nobody wanted.
- `contradictory` - stop and escalate. Postgres checks LOGIN at connect, so this
  is a session that predates the change, and it is not a state to reason out of.

**A deploy's exit code is not evidence about what changed.** A non-zero deploy
may have replaced the machine, may have applied the staged secret, or may have
done neither. So every outcome after the deploy is INVOKED - success, failure,
thrown error, timeout - goes down the same path: measure, classify, recover from
what is there. There is one forward attempt and no retry.

**The overlap arithmetic, and what actually bounds it.** The engine cap of 12 is
the hard bound; the machine's pool is capped at 5, so two overlapping process
pools is 10. `deploy/provisioner-role.test.ts` pins the two configuration facts
that keep that true: fly.toml names no strategy that stands a second machine up
beside the first, and the deploy argv carries `--ha=false`. The third fact is
checked at runtime rather than pinned - the app must be ONE STARTED MACHINE
before a password is generated and again at the deploy, because two machines
already running would make a replacement three pools, fifteen requested against
a cap of twelve.

Sampled backend counts are supporting evidence, not the bound - and they are
taken THROUGH the deploy rather than after it. The overlap the arithmetic is
about exists only while the deploy is in flight, so a series that starts when
the deploy returns can only ever prove a steady state; the run requires at least
one reading taken while the deploy was pending, every reading inside the cap of
12, and a settled count of 1..5.

**What G3 does NOT claim.** Both deployments authenticate as the owner today, so
a before-and-after count of owner backends moves with web traffic and cannot be
split into a provisioner share. G3's acceptance is about the new role: the
machine healthy under `cp_provisioner`, its backend count inside the budget, and
the old machine replaced per fly's own evidence. Legacy owner sessions stay
explicitly unresolved until the web tier moves too.

### What the 2026-08-12 G3 run measured, and what it did not

**G3 IS NOT COMPLETE.** The live run ended `rolled_back`, exit 3: the forward
probe refused, and the reviewed recovery then ran green on production - the
replacement proved from fly's own state, the owner-path probe green, six
consecutive zero backend readings, and the credential closed last, in that
order. The deployment is back on the owner string and R-2026-08-11-1 remains
OPEN.

Three claims, and they are deliberately not the same kind of claim:

- **MEASURED, 2026-08-12.** The probe refused; the run rolled back with exit 3;
  the recovery completed with every one of its own predicates true.
- **STATICALLY ESTABLISHED, not measured live.** The mechanism is the missing
  grant: the probe's authenticated POST (`deploy/probe.ts`) reaches
  `mint-seam.ts` `fetchInvite` -> `signup.ts` `instanceOwnedBy` ->
  `reservationForInstance`, which selects from `name_reservations` - a table
  `PROVISIONER_GRANTS` withheld. Nobody ran the failing statement again on the
  live machine to watch it; the path is read from committed code, and
  `mint-seam-privilege.test.ts` now executes that decision under a role holding
  exactly the matrix, which is as close as a test gets to the live identity.
  THE SAME READ IS ON THE REAL INVITE PATH, so D4's first genuine invite would
  have failed identically. That is the reason the fix is a matrix change rather
  than a probe change.
- **INDEPENDENT HARDENING, not the live cause.** The tick-readiness window
  below was added in the same remediation because a machine fly has just
  replaced is healthy and NOT YET TICKING for a few seconds. Nothing shows it
  contributed to the 2026-08-12 refusal, and it is not offered as an
  explanation of it.

**The probe is now read as a whole transcript.** The coordinator used to scan
the child's output for `accepted: true` and require exit 0, which is a substring
search over text it does not control: a probe printing that line and nothing
else passed, and so did one whose own statuses contradicted its verdict.
`deploy/probe-transcript.ts` parses every field the probe prints - each exactly
once, each correctly typed - and RECOMPUTES bearer enforcement, the surface
answer, the health shape and acceptance from the readings. A reported verdict
that does not equal the derived one is a hard failure. Nothing the child printed
leaves the parser: what comes back is typed fields and labels from a closed
vocabulary.

**And there are three answers, not two.** `tick_recent` is false until the
provisioner's first pass completes, so a freshly replaced machine correctly
earns a refusal for a few seconds. That one state - everything else exactly
right, `tick_recent` and the machine's own `ok` false - is `readiness_pending`
and is waited on; every other refusal fails on the first reading, because
retrying a machine that cannot reach its database only delays the rollback.

The wait is bounded twice, and the two bounds fail differently:

| bound           | value | what it is                                             |
| --------------- | ----- | ------------------------------------------------------ |
| absolute budget | 3 min | a ROLLOUT-READINESS POLICY, not a measured upper bound |
| attempt cap     | 18    | independent of any clock                               |

Three minutes is a CHOICE about what to do when a machine is slow: after it,
this run prefers rolling back to waiting longer. It is NOT a proved bound on
`Ticker.once` - that would be a claim about the provider too - and it must not
be read as one later. Each child gets the smaller of the ordinary two-minute
deadline and what is left of the budget, each sleep is capped the same way, no
child starts at or after expiry, and one child is awaited to its group-empty
proof before the next begins.

The budget is measured on a MONOTONIC clock, and clamped on top of one.
`Date.now` can step backwards - an NTP correction, an operator setting the
clock - and a backward step INCREASES what a subtraction reports as remaining,
which would let a three-minute wait run as long as the attempt cap allowed. The
real primitive is `performance.now`, and the wait discards any reading below the
highest it has seen, so neither a wrong clock nor a wrong primitive can extend
the aggregate. A clock that runs backwards then ends the wait on the COUNT.

### What the 2026-08-12 moves completed

Both deployed tiers left the owner string on 2026-08-12, by two different
routes, and the difference is worth recording.

**The provisioner (G3 retry) moved by the reviewed executable.** After the
matrix remediation above reached production, the same credential-move run that
had rolled back the day before completed forward: the fly machine authenticates
as `cp_provisioner` on the direct endpoint, the probe was accepted on its first
attempt, every backend sample through the deploy stayed inside the cap of 12,
and the count settled at 1.

**The web (G4) moved by a supervised manual run**, Nil at the keyboard, after
the reviewed plan's own finding made the case: the G4 tooling would have run
once, for one account, with a one-paste revert - so the tooling was cancelled
and the same sequence ran by hand under review-agreed evidence rules. Three
facts from that run outlive it:

- **No anonymous request ever opens the database** - every store caller sits
  behind `auth()` - so no anonymous probe can prove which role serves. The only
  causal proof is an authenticated page load observed from the engine, and that
  is how it was proved: a signed-in GET produced a `cp_web` backend while the
  owner held zero.
- **The first cutover attempt failed on the pooled endpoint (08P01)** because
  the artifact then deployed predated the role posture and still sent `options`
  on startup. The second failed on the direct endpoint (42501) because that same
  old artifact ran the schema-writing `Store.open`, which a least-privileged
  role must refuse; `openRuntime` existed in the repository and had never been
  shipped. A cutover to a restricted role REQUIRES an artifact whose code
  expects restriction: the deploy is part of the migration, not an afterthought.
- **The fresh production deploy came from the committed tree** via
  `production-phase.ts --redeploy` (build evidence held, full anonymous probe
  suite green, rows 1/0/0/0 before and after), and only then did the signed-in
  load succeed and the engine reading close the finding.

The owner DSN now lives only in the operator's secrets file, used for
migrations, bootstrap and operator tooling - the break-glass posture the
aggregate section states.

### Re-applying the matrix on a database that is already governed

The matrix change above has to reach production, and `govern` is not the program
that can take it there. `govern` requires the owner to carry NOTHING before it
writes - the baseline that makes `ungovern` an exact reverse - and production
has carried the governed pair since G2, so `owner_config_empty_before` cannot
truthfully pass. And `ungovern` is not this change's rollback: it drops both
roles, which is an outage lever rather than the reverse of one incremental
grant.

```
bun control-plane/exercises/neon.ts regovern --branch <name>            # forward
bun control-plane/exercises/neon.ts regovern --branch <name> --reverse  # back
```

**One exemption, measured on the provider rather than reasoned about.** Both
runtime roles have the OWNER as a member, with admin option, and that is not a
third party: Postgres 16+ grants a NON-SUPERUSER creator ADMIN OPTION in the
role it creates, and Neon's owner is not a superuser. The local container's
owner IS one and records no such row, so no rehearsal here could have seen it -
it was found by the pre-live probe (Neon suites branch AND production, both
2026-08-12: one member each, the owner, with admin option, `belongs_to` and
every ownership count zero). Left unexempted, `residueIsInert` was false for
both roles and every governance re-application - `regovern` and a re-run of
`govern` alike - refused before it started.

So `roleIdentitySql` counts `members_other_than_owner` and the predicate uses
that; `members_of_it` is still read and still reported. The exemption grants
nothing - the owner already owns every table the matrix names, and the
membership is what lets a non-superuser owner ALTER or DROP the role it
created - and it is ONE-DIRECTIONAL: `belongs_to`, our role being a member of
something else, stays zero-tolerance. A member that is not the owner still
refuses. `governance-reapply.test.ts` stages the condition on a real engine by
having a non-superuser CREATEROLE role create a role, and asserts the same row
reads as inert from the creator's session and as a third party from anyone
else's.

It refuses BEFORE writing unless: the owner already carries exactly the governed
bounds, both runtime roles are NOLOGIN with nothing connected as them and own
nothing, their budgets, bounds and memberships are exactly the approved posture,
PUBLIC holds nothing on this build's tables, the catalog carries EXACTLY the
matrix the change moves away from - DIRECTLY and EFFECTIVELY, because a
before-state proved on direct grants alone would miss a role that can already do
more - and neither role holds anything outside the table matrix: schema USAGE
without CREATE, and no privilege on any sequence. That last pair is the class a
matrix read cannot see, and it is what G2's own evidence checked: a role that
can CREATE on the schema can make a table this matrix has never heard of.

It then applies the new matrix in ONE transaction, proves every user table's row
count unchanged and `accounts` still exactly 1 on production, and reads back the
WHOLE posture rather than the half it moved - direct and effective matrices,
schema privileges, sequence privileges and memberships. Acceptance that only
re-read what it wrote could not see a transaction that did more than it meant
to. Any false claim is a non-zero exit. `--reverse` is the same program with the two
rosters swapped: one transaction restoring the old exact matrix, with the roles
left exactly as they are.

**Both pre-live predicates closed 2026-08-12**, each a provider question
answered by measurement rather than argument:

- Catalog visibility: Neon reports the same shape the local Postgres 18
  measured - 0 rows for the invisible class, all rows for the visible one,
  42501 where refusal was expected - so the schema-check change holds on the
  provider it was written for.
- `regovern` was rehearsed against the Neon suites branch, forward and reverse,
  with digest-proved exact restoration, and then applied to production (the G3
  record below). The rehearsal-then-production ordering was a gate, and it was
  kept.

### Landing the provider credentials, and the order that is enforced rather than written down

Eight steps, run one at a time by an operator, and dangerous only OUT OF ORDER:
a deploy before the preflight arms a loop that may act on a box nobody checked
for, and a provider listing before the health reading sends a credential to a
machine whose state is unknown.

```
preflight -> canary -> unset canary -> stage the four -> verify the four
          -> activate -> probe -> read the provider account
```

`deploy/landing.ts` holds that order as a decision, and the three steps that can
change something or send a credential ask it for permission. **Every precondition
is an OBSERVATION, never a memory.** There is no ledger file and no flag saying
step 1 went fine: `activate.ts` re-runs the production preflight and re-lists the
app's secret names in its own process, moments before it deploys. So "not
observed" is its own answer and it REFUSES - a check nobody ran is not a check
that passed, which is the shape of every incident where a step was skipped
rather than failed.

**What the preflight asks, and what it deliberately does not.** The moment
provider credentials reach the machine, the tick loop can reboot, power off,
power on and cancel a real asset - and every one of those handlers is driven by
a ROW. So the question is not whether we intend to touch a box; it is whether
anything in production would make the loop touch one the moment it can. Two
predicates: no asset already carries a provider id, and no operation of any
provider-dependent kind is unfinished. The kinds come from
`PROVIDER_DEPENDENT_KINDS`, the same constant the deployed process asks its
ticker about, so a handler added later widens the preflight automatically. The
account count and open attention reasons are printed as OBSERVATIONS and decide
nothing - a gate that refused for reasons unrelated to whether a box can be
touched is a gate operators learn to route around.

**The arming deploy is a program, not a flyctl line.** A shell `flyctl deploy`
either uses whatever ambient identity `~/.fly` holds - which on this box belongs
to another project - or needs `FLY_API_TOKEN` expanded by a shell, which the
secrets ruling forbids. `activate.ts` reads the token in-process, spawns the
COMMITTED `DEPLOY_ARGV`, and takes no app, config, dockerfile or flag from
outside this repository. It is not `provisioner-move --execute`, which rotates
`CONTROL_PLANE_DB` - the one thing this step must not do.

It has FOUR preconditions, not two, and the last two were missing from the first
version of this protocol (reviewer finding, 2026-08-12). Production and the
staged names are the order's business; the other two are this deploy's own:

- **the source it would ship.** `fly deploy .` sends the WORKING DIRECTORY, so a
  dirty tree produces a live artifact nobody can rebuild from a commit. The
  decision is `judgeSource` in `tree-state.ts`, SHARED with the credential move
  rather than restated - two guards deciding what "clean" means separately is
  two chances to disagree. The rules file is judged first in meaning, for the
  reason the move already documents.
- **the topology.** `--ha=false` reasons about replacing ONE machine; a second
  makes that assumption false. The reading is `readMachineListing`, again the
  move's own, and anything but one started machine refuses.

**A throw is an outcome, not an escape.** Every seam is called inside a catch:
a throw before the spawn is a refusal, a throw AT the spawn is ambiguous -
because the child may well have run - and the error object is discarded rather
than printed, since a driver or CLI error can carry a host, a path or a fragment
of a credential.

**Every post-spawn outcome is AMBIGUOUS, and the type says so.** A deploy that
returns non-zero may still have replaced the machine; a zero exit whose process
group survived says what the leader thought, not what its children are still
doing. The classification is two-valued on purpose - a three-valued one with a
"failed" arm invites a retry, and a failed deploy is exactly the case where
nobody knows what the machine holds. So the program never retries and never
deploys a rollback: it reports and stops, and the next action is a human reading
the machine's own state through `deploy/probe.ts`. Even a completed deploy is
reported as a completed deploy COMMAND rather than a proved deployment.

**The provider account is read from the provider, not from us.** Ruling 7 as
restated by R-2026-08-12-D4-2 (Nil, 2026-08-12) is one box THIS LOOP MAY TOUCH,
id 203474835 - and our database only says what we think we have. `cli.ts list` prints a page for a human and cannot say whether the page
was the whole account; a listing that silently truncated would look identical to
a clean one while hiding the second box the ruling exists to prevent. So
`deploy/provider-account.ts` pages until the rows it holds equal the total the
provider reports, and refuses on an unreadable response, a shape we did not
expect, or a total that disagrees with the rows. A missing total is NOT "one
page is everything" - it is a completeness nobody established.

**The predicate changed the night it first ran, and why is worth keeping.** It
began as "exactly one instance on the account", and the first live reading found
TWO on a listing proved complete: ours, plus a cancelled `latency-test` box of
Nil's expiring the same day. The count was never the property that mattered -
the account is Nil's and may hold anything - so the ruling was restated and the
predicate with it: the expected id must be present EXACTLY ONCE in a complete
listing, its own fields must validate, and every other row is counted and
reported as A NUMBER ONLY. One stranger passes as an observation; more than one
fails closed to a manager and Nil decision, printing the count and nothing else.

That boundary is the point. Row identifiers are used on the box for three
things - is our box there, is it there once, how many rows are not it - and no
id, name, state or date of any stranger crosses back, nor is any per-instance
request made for one. A loop that may not touch them has no business learning
about them, and a transcript that carried their details would be a place for
that knowledge to leak into a later decision.

It runs ON the fly machine, because that is where the provider credentials are
and this box has none - and the local half re-validates everything that comes
back. The machine ran the same checks; that is not a reason to skip them, because
a boundary whose receiving side depends on the sending side having behaved is not
a boundary. So counts must be digits, the booleans exactly `true` or `false`, the
states inside a closed list of ones this loop has actually observed, and the
cancel date the provider's full shape - validated WHOLE and only then reduced to
its day, since checking a ten-character slice accepts
`2026-08-29T99:99:99-garbage` on the strength of its prefix. Anything
`unexpected` fails acceptance rather than being printed as a curiosity.

The remote run itself must be clean before a single line of it is read: exit 0,
no deadline, no surviving process group, the group proved empty. A leader that
exits 0 while something it started is still running produced a fragment, and a
fragment that happens to parse is the worst kind of answer to "is there exactly
one box".

And the listing has three outcomes rather than two - complete, malformed,
exhausted - because they mean different things to an operator: a provider or
transport that is not what we think, an account bigger than this reader expects,
and a clean account with two boxes in it are three different problems.

### The volume, and one thing it deliberately does not have

`/data` is a 1 GB volume in `fra`, and `HOME=/data` in the image is what puts
the state root (`~/.isomux-control-plane`) on it: the per-run private keys, the
run records, the intent journal and the audit log. A deploy replaces a machine's
filesystem, and the key it would have destroyed is the only thing that can
revoke our own access to a customer's box.

**Scheduled snapshots are off, explicitly.** `flyctl volumes create` turns them
on by default with five-day retention, and `keys.ts` destroys a private key as
soon as revocation is proven - a snapshot would keep copies of that material for
five days after we destroyed it, which is the guarantee working in reverse.
Nothing here is therefore backed up, and this document does not claim otherwise:
what a provisioner's durable state deserves in the way of backup is an ops-floor
question, alongside the restore procedure the design already owes.

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

### Deploying it

First deploy, in this order, with the token read per command and never echoed:

```
bun control-plane/deploy/name-check.ts
FLY_API_TOKEN="$(cat ~/nil/secrets/fly.token)" ~/.fly/bin/flyctl apps create isomux-provisioner --org personal
FLY_API_TOKEN="$(cat ~/nil/secrets/fly.token)" ~/.fly/bin/flyctl volumes create provisioner_state \
    -a isomux-provisioner -r fra -s 1 --scheduled-snapshots=false -y
bun control-plane/deploy/secrets.ts --canary
bun control-plane/deploy/secrets.ts --unset-canary
bun control-plane/deploy/secrets.ts
FLY_API_TOKEN="$(cat ~/nil/secrets/fly.token)" ~/.fly/bin/flyctl deploy . \
    --config control-plane/deploy/fly.toml --dockerfile control-plane/deploy/Dockerfile \
    -a isomux-provisioner --depot=true --depot-scope app --ha=false --now
bun control-plane/deploy/secrets.ts --verify
bun control-plane/deploy/probe.ts
```

That raw first deploy correctly reports `release_source: { known: false }`:
there is no guarded activation observation from which to claim a commit. It
still reports the Dockerfile-computed payload digest and Fly deployment id.
Later guarded activations add the comparable commit without weakening what the
first image can prove.

Deploy the new image before running `provider-account.ts` or the recycle
ladder against it. Those gates require the new exact health shape and therefore
refuse, by design, while the old image still serves the seven-field response.

A lifecycle-cadence redeploy adds one required step before those lines:

```
bun control-plane/exercises/neon.ts regovern --branch production
```

Run the grant re-application first and prove its exact read-back. Then deploy
the image, verify its secrets, and run the authenticated probe. Deploying the
image first leaves `tick_recent` false because the lifecycle scan cannot read
`subscriptions`.

A routine redeploy is the last three lines, and nothing else. Measured
2026-08-11: the image and the machine's configuration are updated IN PLACE -
the same machine id came back started, with its event counts unchanged - and
the volume stays attached throughout.

**The first deploy, measured 2026-08-11.** Build on Depot ("Building image with
Depot"; no `fly-builder-*` app was created or reused). Context 940.20 kB, which
is 96 files and matches the 911.8 kB those files hold plus archive overhead - so
the ignore rules did what `deploy/image.test.ts` says they do. Image 61 MB. One
machine, `shared-cpu-1x` 256 MB in `fra`, started in 4.7s, with a dedicated IPv6
and a SHARED IPv4 (a dedicated v4 is the one that costs, and nothing here asks
for it). The volume was initialised, encrypted and mounted at `/data` on first
boot. First boot line:

```
boot: bounds-governed true, branch-pinned true, state-persisted false,
      marker-crossed-release false, marker-supported true
```

`branch-pinned true` is the machine proving from its own session that it is
talking to the Neon production branch; `state-persisted false` is the correct
answer on a first deploy, and `marker-supported true` says fly supplied the
release id the marker needs. Beside it, `no provider credentials in the
environment: reconcile is off for this run` - the loop idles rather than
crashing without provider credentials, which is what this slice deliberately
does not give it.

**The idle window and the redeploy, measured 2026-08-11.** From 05:39:37Z to
06:16:49Z the machine stayed `started` with its event counts unchanged
(`start: 1, launch: 2`, no restart of any kind), the log carried no exit, crash
or out-of-memory line, and the external probe answered `accepted: true` at both
ends. Neon production, re-checked after the provisioner had been attached to it
for that whole window, still reported `schema-ready: true`, `zero-user-data:
true`, `operations: 0 rows` and `instances: 0 rows`.

The redeploy at 06:18Z then updated the same machine in place and printed:

```
boot: bounds-governed true, branch-pinned true, state-persisted true,
      marker-crossed-release true, marker-supported true
```

Both booleans flipped, and the second one is the one that means something: the
marker named a DIFFERENT release, so the state root survived a deploy rather
than a restart. fly's own log agrees from the other side - the first boot said
`Uninitialized volume 'provisioner_state', initializing... Formatting volume`
and the second only said `Setting up volume 'provisioner_state'`.

One line in the log is expected and is not a fault: the TCP check fires when the
machine starts and fails once, about four seconds before Bun binds the port. The
declared grace period does not suppress that first probe. It passes on the next
one, and no restart follows.

Two honest limits on the redeploy evidence. It proves the PROCEDURE is
repeatable and that the volume outlives a release; it is not a byte-identical
rebuild, because `control-plane/README.md` is inside the build context and this
paragraph changed it (context 120.09 kB on the second build, against 940.20 kB
cold, the rest being cache). And a 37-minute window says the loop is stable over
37 minutes, not over a month.

Three flags are load bearing rather than stylistic:

- `--depot=true`. At the default (`auto`) flyctl may choose its classic remote
  builder, which creates or REUSES a builder app in the organisation -
  `--recreate-builder` exists precisely because reuse is the normal case - and
  this token's organisation holds unrelated apps. Depot builds on fly's managed
  service and creates no app here. If it is ever refused, the answer is to stop,
  not to fall back.
- `--depot-scope app`, so this build's cache is not the organisation-wide one
  other projects share.
- `--ha=false`. The default creates a spare machine, which is a second machine
  nobody asked for and a second thing to pay for.

No `flyctl auth` command is run: the token travels as `FLY_API_TOKEN` in one
child's environment, and every call names `-a isomux-provisioner`.

**That does not mean flyctl leaves its own configuration alone**, and the
difference is worth stating because the obvious check reads as an incident.
Measured 2026-08-11: the first deploy sequence rewrote `~/.fly/config.yml` at
05:36:50Z, adding one `app_secrets_minvers` line for the new app to a list that
already held eleven others (1917 -> 1948 bytes). The org token from
`~/nil/secrets/fly.token` was NOT written into that file - checked as a boolean,
with neither value printed. So a changed md5 on that file is ordinary flyctl
bookkeeping, and by itself it says nothing about the login credential either
way. An earlier draft of this file claimed `~/.fly` is never written to, which
the first deploy disproved.

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

The deployed provisioner also serves `POST /stripe/webhook` on Fly's published
internal port 4311. It reads the durable Dashboard endpoint secret from
`STRIPE_WEBHOOK_SECRET`; this replaces the temporary secret printed by a
hand-run `stripe listen` session. Its restricted Stripe key has Subscriptions
read, Invoices read, and Checkout Sessions read and write. The write permission
is used only by the existing `expire_checkout` lifecycle operation. Webhook
processing uses only the three read resources.

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
for Managed Payments. As checked 2026-08-16, the control plane has no customer
mailer: its dunning ladder records state, raises internal attention and requests
suspension, so it does not duplicate Stripe's customer emails. Adding customer
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
Neon `suites` branch) and every check stayed green - see the Tests section for
the command. That is the cell a deployment uses, so it is the one that needed a
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
  build drives every test, because no Google OAuth client exists yet. Sessions
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
runs THERE, and there the database string is a fly secret in the environment
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
  settles the second half at build time, and `/signin` is prerendered - so no
  runtime setting brings it back, which is exactly what that gate is for. Google
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
was actually broken cannot be un-broken, so nothing clears it.

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
sequential in one process, so they cannot overlap. Fly keeps one machine running
and restarts the same command; durable operation rows make a restart resume
rather than duplicate work. A failed lifecycle pass goes to the machine journal
and does not refresh `tick_recent`. A per-subscription failure is counted and
reported as a problem while the next subscription and the next pass continue.

**Measured 2026-08-16 on the deployed provisioner before this change:** the
authenticated probe reported `provider_configured: true`, so opened
`power_off` operations have a registered handler. A direct lifecycle scan under
`cp_provisioner` failed with PostgreSQL 42501 on `subscriptions`; the widened
grant in `roles.ts` must be applied with the deployment. After deployment, run
`deploy/probe.ts`: `tick_recent: true` then proves both the operation and
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

The Fly provisioner volume has scheduled snapshots off. That is deliberate
because snapshots would retain destroyed temporary private keys. The operator
restore procedure and the decision about what non-key state deserves backup
remain coupled: never enable volume snapshots as an ad hoc substitute.

No control-plane state is backed up. Keep Fly scheduled snapshots disabled.
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
2. Deploy the provisioner image with
   `bun control-plane/deploy/activate.ts --redeploy --plan` and then
   `--execute`. Plain `--execute` is the first-arming gate and refuses on a
   production that already carries a provider-linked asset, which is
   production's normal state since 2026-08-13; `--redeploy` requires the four
   provider names already on the app instead (added 2026-08-21). Its build
   must prove every runtime payload is
   present, including `/app/deploy/install.sh` and the customer-key installer.
3. Deploy the control-plane web app with
   `bun control-plane/deploy/production-phase.ts --redeploy`. The local probe
   preflight must pass before the deployment may contact Vercel.
4. Run one complete customer acceptance pass with a new office and a real
   customer SSH public key. Prove the key is installed, root SSH works, the
   built-in Isomux terminal remains unable to sudo, our temporary key is
   revoked, the customer key still works afterward, office links use the office
   name, and the handoff flow cannot revoke access before browser confirmation.
   The installer must complete without copying a missing file into the live
   provisioner.
5. Publish a current Isomux release only after the combined tree passes CI.
   Install or update the acceptance office through the real release channel and
   verify the Apps tab and current hosted capabilities.

Do not enable paid signup until every step above is green. A failed acceptance
pass leaves checkout disabled while the operator diagnoses it.

Two 2026-08-13 launch blockers came from the real pass. The Fly image lacked
`/app/deploy/install.sh`, so the provisioner could stage its wrapper but could
not start the installer; task `a8258f96` owns the permanent image fix. Also, a
fresh clone with only the root dependencies installed could deploy a healthy
Vercel build and then fail its LOCAL probe import (`next-auth/jwt` absent),
causing the safety gate to detach the healthy domain. The production phase now
starts that real probe entry point in a network-free readiness mode before it
reads the Vercel token or contacts a remote service. A startup failure refuses
before deployment. Install dependencies in both the repo root and
`control-plane/web` before `production-phase.ts --redeploy`.

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

The same suite runs against the managed engine, on the `suites` child branch and
never on production:

```
bun control-plane/exercises/neon.ts run --branch suites -- \
    bun test control-plane --timeout 30000
```

Measured 2026-08-11: 728 tests across 46 files, 0 failures, **9m16s** wall
against 50s on the local container. The suite issues about 11,200 round trips
and each one costs 26ms to Frankfurt, which is the whole difference; the box's
own CPU time was 1m12s of those nine minutes.

`--timeout 30000` is on the command line rather than in any test file, and it
is load bearing rather than precautionary: the same suite run at bun's default
5s bound fails exactly two tests, both of them timeouts at 5001ms and 5002ms,
both in `adopt-run.test.ts`'s `--revoke` block, which drives a whole adoption
through one test. Wall clock was the same either way (9m14s), so the flag buys
headroom and costs nothing. NO SOURCE TIMEOUT MOVED - a bound written into a
test file would follow it to CI, where the same test finishes in milliseconds.

The run is pointed at the branch through `CONTROL_PLANE_DB` - the product's own
variable, not a second name for the same thing - and both branch guards above
apply, so a mistyped target refuses instead of writing.

The production web server is driven against the same branch, and that is the
transcript that matters most here because it writes rows the product's own
signup path wrote:

```
bun control-plane/exercises/neon.ts run --branch suites -- \
    bun control-plane/web/e2e/production-server.e2e.ts --runtime node --mode start
```

Measured 2026-08-11: every check green in 17s, including the seeded office's
hostname, the polled progress route, a second account refused the same office,
and the ops floor before and after the operator grant. So the `node` / `next
start` cell of the runtime matrix now has a managed engine behind it, not only
a local container.

One caveat that belongs to the harness rather than to the engine:
`sweepAbandoned` decides "did the process that made this schema die" with
`process.kill` on THIS machine, which is sound only because one machine uses the
branch. Two machines sharing it would drop each other's live schemas.

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

`deploy/secrets.test.ts` is the same move for the deployment: it drives the
secrets wrapper against a FLYCTL THAT MISBEHAVES - echoing its own stdin on
stdout, on stderr, and as a fragment no exact-value scan can see - because a
real flyctl cannot be asked to leak on demand, and the property being proved is
that nothing it writes can reach a caller either way.

## Working on control-plane/web: the next-env.d.ts trap

`next dev` and `next build` each rewrite the GENERATED
`control-plane/web/next-env.d.ts` (pointing it at `.next/dev/types` or
`.next/types` respectively), so any dev-server or transcript run moves
a frozen diff fingerprint by that one file. Restore it before
fingerprinting. The isomux safety hooks block `git checkout -- <path>`
and `git restore <path>` as destructive, so the standard moves are:
edit the two import lines back by hand, or run `bun run ci:web`, whose
`next build` restores the build-flavored content as a side effect.
(Recorded 2026-08-10 after every web slice hit it.)

## Stripe mode boundary

`CONTROL_PLANE_STRIPE_MODE` is the only mode decision. An absent value means
`test`; the other accepted value is `live`. Live mode is valid only on the
production Vercel deployment or the pinned `isomux-provisioner` Fly app. An
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
