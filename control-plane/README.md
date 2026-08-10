# Control plane: provider adapter and SSH driver

The provisioning half of hosted isomux. One command turns a provider API call
into a live HTTPS office with an owner invite in hand and our key removed, with
the removal proven by a failed reconnect using the removed key.

Design: `internal-docs/control-plane-design.md` (the spec; its rulings are
final) and `internal-docs/hosted-isomux-design.md` (the product).

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
bun control-plane/cli.ts run                     # the tick loop, as its own process
bun control-plane/cli.ts tick                    # one pass
bun control-plane/cli.ts ops     [--run <runId>] # the operation rows
bun control-plane/cli.ts attention [--ack <instanceId>] [--by <name>]
bun control-plane/cli.ts status  --run <runId>
bun control-plane/cli.ts expiry-test --run <runId> --variant boundary|powered-off [--seconds N]
```

Credentials come from the environment (`CONTABO_CLIENT_ID`,
`CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD`); sourcing
the file that holds them is the caller's job. Runtime state - generated keys,
run records, the audit log - lives in `~/.isomux-control-plane/`, never in the
repo.

`--access-window` is required and has no default. The driver refuses to rewrite
an authorized_keys line without an absolute expiry instant, and the CLI refuses
to start without one: a missing ceiling stops the run at every layer. What the
product's ceiling should be is an open question, and this code does not answer
it.

There is no create command. The adapter can create a box and the tests exercise
that path, but no flag reaches it: creating one is latched durably by
`intents.ts` and is a thing a human does on purpose.

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

`~/.isomux-control-plane/control-plane.db`, SQLite in WAL with
`synchronous=FULL`. The deployed provisioner runs managed Postgres, so the SQL is
constrained rather than idiomatic: service state, goal, attention state and
severity, operation status, intent state and PROVIDER ASSET STATE all carry CHECK
constraints, so every finite set is enforced by the database and not only by a
TypeScript union; times are INTEGER ms-epoch, booleans are 0/1,
JSON travels as an already-serialised TEXT parameter (no `json()` calls), the
audit log's event id comes from a `sequences` row bumped in the same transaction
rather than AUTOINCREMENT, and every mutation is one statement with a version
predicate. Private key material still never enters the database: the run record
and the 0600 key files on disk remain the authority, and the schema stores only
the runId, the public blob and paths.

There is no schema migration in this slice, and a database written before it
REFUSES TO OPEN rather than failing somewhere in the middle of a run: `create
table if not exists` is silent about a table that exists with the wrong columns,
so the store checks for the columns it needs and names the file to move aside.

### The store API is Promise-based, and the engine handle is private

Every method that reaches the database returns a promise, readers included, and
`Store.open` replaces `new Store` - even though bun:sqlite answers
synchronously. That is deliberate groundwork rather than present-tense need: the
engine behind this class becomes Postgres, whose driver cannot answer
synchronously and whose opening cannot happen in a constructor. Flipping the API
on its own keeps that change narrow instead of re-touching every caller twice.
`now()` and `inTransaction()` stay synchronous, because neither reaches the
database on either engine.

`db` is private. The handful of callers whose SQL does not fit a typed method -
the create latch's INSERT, the name reservation, the billing tables - go through
`sqlAll` / `sqlGet` / `sqlRun`, which carry the SQL text verbatim. The names are
deliberately ugly so `grep 'sql[A-Z]'` finds every one of them, and the web
app's boundary test forbids them outright. `tx` issues its own `begin
immediate`, `commit` and `rollback` through `sqlRun` like everything else, so a
test that needs to make a COMMIT fail has one seam to patch rather than a
private path it cannot reach.

One rule this imposes on callers, which the Postgres port will replace with
per-transaction connections: **a transaction body may await only store calls,
never remote I/O and never a timer.** There is one connection, so a body that
awaited a network round trip would hold `begin immediate` open across it.

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
- **Confirmation is not a column.** "Revoke isomux's access" opens a
  `revoke_access` row stamped `via: "dashboard"`, and that stamp is what makes
  it the customer's confirmation. A row opened by an operator or the chain still
  renders, but is never described as their choice. The 30-day ceiling stays the
  fail-safe underneath.

## Billing (Stripe, test mode only)

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

### What Stripe actually does (observed 2026-08-09, API version 2026-07-29.dahlia)

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

### Running the endpoint against real Stripe deliveries

A local endpoint has no inbound route, so real signed deliveries arrive through
the Stripe CLI, which holds a websocket to Stripe and forwards each event:

```
stripe listen --forward-to http://localhost:4243/stripe/webhook   # STRIPE_API_KEY in the env
bun control-plane/billing-cli.ts serve --db /tmp/billing.db       # STRIPE_WEBHOOK_SECRET in the env
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

Next 16.3.0 (Turbopack), Bun 1.3.11, Node 24.18.0, measured 2026-08-10:

|              | `bun --bun`                                                                                         | `node`                      |
| ------------ | --------------------------------------------------------------------------------------------------- | --------------------------- |
| `next dev`   | works, and `bun:sqlite` opens inside route handlers and server components                           | cannot load `bun:sqlite`    |
| `next build` | FAILS: "Expected CommonJS module to have a function wrapper" loading Next's compiled server runtime | works                       |
| `next start` | FAILS, same defect                                                                                  | works, without `bun:sqlite` |

So the app RUNS under Bun's dev server, and BUILDS under Node. The Node build is
a compile-and-bundle gate, not a claim that the built artifact can serve
store-backed pages here; in the deployed shape the store is managed Postgres and
`bun:sqlite` is gone.

That split is what forces the one structural rule in the app:
`lib/services.server.ts` reaches the control plane through **request-time
dynamic imports**. Next evaluates every page and route module while collecting
page data, under Node, so a module-scope import of the store fails the build.
The build is the enforcement; `web-boundary.test.ts` is the explanation.

### What is in the app, and what is deliberately not

- Auth.js with Google configured only when its credentials are present, so a
  missing client id means the provider is absent rather than broken. A
  credentials provider gated on `CONTROL_PLANE_DEV_AUTH=1` AND a non-production
  build drives every test, because no Google OAuth client exists yet. Sessions
  are JWTs with no database adapter: an adapter would make Auth.js a second
  writer of `accounts`.
- One facade, `lib/services.server.ts`, with a fixed export list. It opens a
  `Store` per request and closes it in a `finally`, and it hands no store out -
  every export returns plain data, so no page or handler is one method call away
  from mutating the control plane.
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

`account_id` is unique too, so **one office per account** is a constraint rather
than a rule somebody could forget - the design puts more than one box per
account outside the MVP. Two connections racing different names for one account
are separated by the database, and the loser is told which office it already
has.

THE TENANT KEY IS THE ACCOUNT ID, NOT THE EMAIL. Both providers resolve to a
durable account before a session exists, and the session carries that id;
signup, the dashboard and the projection accept nothing else. An email is
mutable - Google can return the same subject with a new address - and a session
keyed on the address would reach a different account than the one the subject is
durably bound to, while the binding kept saying the right thing. The email is
contact and display data, and Checkout takes it from the ACCOUNT row rather than
from whatever the session carries today.

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

Signup writes four rows in one transaction - account, reservation, instance,
placeholder provider asset - and it writes the access-window ceiling with the
instance, because nothing else can. `createInstance` is the only statement that
sets `access_window_expires_at`; `casInstance` refuses it in its type and at
runtime. A row created without a ceiling could never be given one, and the
driver is fail-closed on a missing ceiling, so the row would be unprovisionable
forever. The value is the 30-day fail-safe backstop of R-2026-08-09-3.

An abandoned checkout keeps its name. Releasing one is slice-5 work with its own
ruling, and a state column nobody transitions is a claim the code cannot keep.

### Progress, and what the browser is not told

`progress.ts` projects rows into steps. The ladder is DERIVED by walking
`nextKind` from the instance's own stored goal, so it cannot drift from the
chain the machine will run, and a goal of `live` promises no revocation step.
A step with no row is `waiting`, never `done`; `ambiguous` is "checking";
"ready" rests on a SUCCEEDED `verify_https` rather than on ladder position.

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
create. Every other command in `cli.ts` addresses `inst-<runId>` through
`ensureInstance`, so pointing one of them at a signed-up instance would create a
SECOND instance driving the same box, which the account cannot see.

Both modes decide every mutable precondition INSIDE the transaction that writes,
so two callers cannot turn a pre-check into duplicate work:

```
bun control-plane/exercises/adopt-run.ts --db <file> --instance inst-<id> --run <runId> --start
bun control-plane/exercises/adopt-run.ts --db <file> --instance inst-<id> --run <runId> --revoke
```

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
set -a; . ~/nil/secrets/stripe-test.env; set +a
export CONTROL_PLANE_PRICE_ID=price_... CONTROL_PLANE_COUPON_ID=...
bun run --cwd control-plane/web e2e
```

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

`remove_dns` **removes nothing**: this deployment automates no DNS. It raises an
operator attention row naming the record, and then VERIFIES - it succeeds only
once the hostname no longer resolves to the instance's recorded `ipv4`, read
with `dns.resolve4`/`resolve6` (the record queries; `dns.lookup` consults
/etc/hosts and collapses the answer set). On success it CLEARS the reason it
raised, with its audit row. Two deliberate details:

- the condition is "not OUR address", not "does not resolve". **Measured
  2026-08-10**: `*.test.isomux.app` has a wildcard A record answering
  116.203.73.126, so a removed specific record never becomes NXDOMAIN here.
- an AAAA answer BLOCKS. We record no ipv6 for an instance, so an AAAA record is
  unprovable, and unprovable is not removed. (No AAAA exists under this domain
  today; that instances carry no ipv6 at all is a real gap.)

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

### What Stripe actually does at period end (measured 2026-08-10, API `2026-07-29.dahlia`)

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
  goes through. Each verb opens one `begin immediate`, re-reads `is_operator`
  inside it, and does the whole protected operation there - which is why
  acknowledgement needs `acknowledgeAttentionIn` rather than the wrapper that
  opens its own transaction.
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
bun control-plane/cli.ts operator --db <file> --email <addr> --grant
bun control-plane/cli.ts operator --db <file> --email <addr> --revoke
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

## Tests

```
bun test control-plane
```

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
