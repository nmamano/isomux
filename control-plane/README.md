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
bun control-plane/cli.ts provision --run <runId> --access-window 2h [--stop-after first-contact] [--handoff-now] [--owner-name X]
bun control-plane/cli.ts status  --run <runId>
bun control-plane/cli.ts revoke  --run <runId>
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
The intent is stamped into `displayName` as `isomux-cp:<intentId>`.

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
