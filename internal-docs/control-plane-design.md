# Hosted isomux: the control plane

> Status: design, not implemented. Drafted 2026-07-30, amended 2026-07-31 with
> Nil's rulings. Author: Isomuxer2, reviewed by Reviewer2. Task: 95b62b35,
> slice B of c91af4a4.
> Companion reading: `hosted-isomux-design.md` (the product this implements),
> `release-design.md` (versions and the update trigger, already shipped),
> `deploy/install.sh` (the contract the provisioner drives),
> `port-proxy-design.md` (what the DNS design must not foreclose).
> Related tasks: 962965dc (operator restore procedure, P1, blocks taking
> money), d2a4a381 (fleet security-update window), 523eec92 (move the
> `isomux.app` zone to Cloudflare).

## The MVP loop

Sign in with Google, pay, and about ten minutes later get a working office at
`https://<name>.isomux.app` with an owner invite link. Cancel from the same
dashboard. Everything else is deferred.

**In:** Google sign-in, Stripe Checkout and webhooks, 100%-off coupons as the
comped path, provisioning with step-level progress, invite handoff, an optional
customer SSH key at signup, access revocation at handoff with a box-local
fail-closed backstop, classified liveness, reboot, cancel and deprovision, an
internal audit log.

**Out:** metrics graphs, a customer-facing event log, restore-from-backup UI,
operator-pushed fleet updates, more than one box per account, region or plan
changes after provisioning, team seats in the control plane (isomux's own
invites already cover that), any free trial.

## Nil's rulings (2026-07-31)

These are settled and the design below implements them rather than reopening
them.

1. **Paid only.** No free tier and **no free trial**. Comped access is a
   100%-off Stripe coupon Nil hands out personally; a couponed signup collects
   no card.
2. **Small margin above cost.** Growth matters more than revenue. The exact
   table is still open.
3. **Zero standing access.** After setup, isomux holds no access to the
   customer's box. Our key is removed at handoff: no management account, no
   retained break-glass.
4. **Model credentials never touch us**, and the first run is deliberately
   subscription-first: the welcome agent's not-logged-in message sends the
   customer to the terminal panel to run `claude` and `/login` (same for
   `codex`). A paste-an-API-key form is **rejected** - isomux is
   subscription-first, not API-key-first.
5. **Copy oneclickclaw** on cancellation, retention, dunning and the backup and
   security promises, with one firm addition: customers get the office for the
   full period they paid for.
6. **Cloudflare** for DNS.

Second round (2026-07-31, after the open-items review; recorded by the
manager - body sections that still describe the superseded versions get
reworked at implementation time):

7. **Setup access ends when the customer is in, not on a clock.** Nil: "when
   the customer is in, we should be locked out. never see any user data." The
   72h ceiling is dropped - there is no point locking ourselves out while the
   customer has not yet arrived. Mechanically: the key stays until the customer
   confirms from the dashboard that they are in (an observable act), then the
   revoke-and-verify sequence runs. Consequence accepted: a customer who never
   confirms leaves the key valid, so the dashboard nags until they confirm.
8. **Suspension to deletion: 1 month**, not 7 days. Nil: start generous;
   tighten only if it becomes a recurring problem - making someone angry is
   worse.
9. **Grace-week bought:** on cancellation we pay the ~EUR 5.50 extra provider
   month so the office keeps serving through the grace period. (Ruling on the
   deviation-from-reference already in the D6 section.)
10. **No implementation this session.** Both designs are approved as designs;
   implementation is sequenced separately.

11. **Provider console: consent-gated per incident (option c), ruled
    2026-07-31.** Rescue-mode access is opened only on the customer's explicit
    written request for a specific incident, logged, and ends with the
    incident. Nil's condition: the public-facing terms/docs must carry a
    footnote WITH LINKS showing that comparable services do the same or worse
    (e.g. the reference competitor publishes standing SSH access to customer
    servers with sessions logged for 90 days), so the comparison is evidenced,
    not asserted. The guarantee copy stays honest that this layer is
    procedural: provider-account control cannot be technically dropped.

## Provider-agnostic, Contabo first

The provisioner talks to providers through one interface. It stays thin because
the installer needs nothing from the provider beyond a fresh Ubuntu 24.04 box
with our public key on it:

```
create(intentId, plan, region, publicKeys)
    -> {outcome: "created" | "rejected" | "ambiguous", providerId?, reason?}
get(providerId)       -> {assetState, powerState, ipv4?, raw}
reboot(providerId)    -> void
powerOff(providerId)  -> void
powerOn(providerId)   -> void
cancel(providerId)    -> {assetState, serviceEndsAt?}
find(intentId)        -> {providerId, confidence: "exact" | "unproven"} | null
```

Four things the signatures carry deliberately. `create` takes our intent id so a
repeated call can be correlated, and returns an outcome *class* rather than
throwing, because "ambiguous" needs different handling from "rejected". The
power actions exist because ruling 3 leaves us no way to touch a service from
inside: after handoff, "restart it" and "stop serving" are both provider-level
operations or they do not happen. `cancel` returns when service actually ends,
because not every provider destroys on request. `find` reports how much it can
prove: an adapter whose search is best-effort must say so, and the machine
treats `unproven` as grounds for operator intervention rather than as a
reconciliation.

Contabo, measured in the pilot (task b223ebc3): OAuth2 password grant against
`auth.contabo.com`, create to SSH-able in 110s, product V153 (4 vCPU / 8GB) at
EUR 5.50/mo, Seattle and EU regions, AMD EPYC with real NVMe. Credentials live
at `~/nil/secrets/contabo.env`. Two consequences of their billing shape:

- **No hourly billing.** A box is a month whether it lives an hour or thirty
  days, and cancellation ends service at the end of the paid term. Nothing in
  the machine may assume cancelling frees the asset now. With no trial (ruling
  1) every box we create has been paid for at least once, which removes the
  worst version of this risk.
- **Reinstall is fast and total** (~5 min, wipes the disk). A cancelled box is
  therefore recyclable inside its paid month. Not in the MVP, but the model must
  not preclude it: provider identity and instance identity stay in separate
  rows so one provider box can back a later instance.

## Ordering a paid box exactly once

Create is the only operation that spends money, and provider list APIs are
eventually consistent, paginated, and not guaranteed to expose our tag. So:

1. Persist a `create_intent` row (with the intent id that goes into the
   provider request) **before** the call, in its own transaction.
2. Call `create` with the provider's idempotency key if it has one.
3. On `ambiguous` - timeout, 5xx, dropped connection - never call `create`
   again for that intent. Enter a bounded quarantine (15 min), polling `find`.
   An `exact` hit adopts the box; `unproven` or nothing at the end of the
   window raises attention with the intent recorded, while the instance stays
   in `provisioning`.

A paid duplicate is worse than a stalled signup, so the machine fails toward a
human. The adapter must document its `find` semantics as part of the interface
contract, and that documentation is what slice 1 verifies.

## Zero standing access

Ruling 3 is the constraint that shapes the rest of this document. Root is used
during provisioning and then given up:

- A keypair is generated per box, used for the install, and **removed from the
  box at handoff**. Removal is an operation like any other, and it is verified
  the only way that means anything: reconnect **authenticating with the private
  key we just removed**, and require that attempt to fail. A successful
  connection using the customer's own key would prove nothing. Then our private
  half is destroyed.
- No management account is left behind, no sudoers entries, no break-glass key.
- If the customer supplied no key of their own, the finished box has no SSH
  access at all - not for them and not for us. The installer's hardening runs
  during the install (our key is present, so it is not skipped), leaving
  password authentication off.

### The ceiling has to hold without us

A revocation that only our provisioner can perform is not a guarantee: if the
provisioner is down, our access silently outlives the deadline we promised. So
the enforcement lives in the key itself, not in a job that has to run on time.

**The key expires on its own.** Our `authorized_keys` entry carries OpenSSH's
per-key `expiry-time="YYYYMMDDHHMMSSZ"` option set to the absolute ceiling, so
sshd refuses it after that instant whether or not anything cleaned up, and
whether the box was running, rebooted or powered off across the deadline. The
provider injects a bare key at create time, so the driver's first act on first
contact is to rewrite that line with the option attached - before anything else
happens on the box, and read back to confirm it took. Until that read-back
succeeds the box holds an unexpiring key, so provisioning may not treat it as a
completed step. The customer's own key, if they supplied one, gets no expiry.

A root-owned systemd timer at the same deadline (`Persistent=true`) then does
the cleanup: remove our line, delete the driver's wrapper and run directory, and
write a world-readable record of what it did and when. That record is evidence
of cleanup, not proof of non-access - the proof is that the key with our
fingerprint is expired or absent and that authentication with our private half
fails. A timer alone could not be the guarantee: `Persistent=true` only promises
an overdue timer runs after boot, and `sshd` may well accept a connection first.

Early revocation is the normal path; the timer is cleanup and the expiry is the
backstop. The timer is removed only after an early revocation has been verified;
a failed or un-run early revocation leaves it armed. Destroying our private half
stays control-plane work, but losing our worker must never extend access to a
box.

### What the guarantee costs

These are the support calls it makes impossible, and they are the reason to
state it carefully rather than enthusiastically:

- **A locked-out customer cannot be let back in.** Invites are single-use with
  a 24h TTL and minting one needs shell. A customer who loses every session
  after the access window has no path back except a reinstall, which destroys
  their data.
- **A crash-looped office cannot be repaired** through the office itself. If
  isomux does not serve, the terminal panel is gone with it, so "the customer
  runs it themselves" has no hands. The remaining lever is a provider reboot.
- **We cannot export a customer's data for them** from a running box.

The mitigation for the first two, and the reason it is in the MVP: **collect an
optional SSH public key at signup** and install it during provisioning. That
converts our access into theirs, which is aligned with the ruling rather than a
dilution of it, and it is cheap precisely because it happens during the install
- no post-hoc key installation, no re-running the hardening, none of what made
the parent design's SSH toggle expensive. Customers who skip it get a box
nobody can enter, which is a legitimate thing to want, stated plainly at signup.

### The provider account is the honest limit, and Nil has to rule on it

We rent the box, so we keep provider-level control whatever we promise: reboot,
power off, reinstall, and - on most providers, Contabo included - a rescue
system or console that can mount the disk. That last one matters, because a
capability to read the disk means "we cannot repair it" and "we cannot export
your data" are not literally true, and a MUST guarantee should not quietly mean
"except by another route". We cannot technically drop the capability while we
hold the account, so this is a policy choice, and it is Nil's:

- **(a) Narrow the promise.** No retained SSH credentials, and disclose
  governed provider-console access. Honest, weaker, keeps a repair and
  export path.
- **(b) Widen it and give up the path.** Promise no post-setup access to the
  data plane at all, and forbid console and rescue use except a destructive
  reinstall. Enforced by our own discipline, not by technology, which the terms
  should admit.
- **(c) Consent-gated, per incident.** Recommended. No standing use, and the
  console is opened only on a customer's explicit written request for a specific
  incident, logged in the audit trail, with the *session* ending when the
  incident does. The account-level capability itself cannot be revoked, as
  above; what (c) governs is whether it is ever exercised. A broken box still
  has a path that is not "reinstall and lose everything".

Whichever he picks, the terms must name retained provider control - reboot,
power, reinstall - as something we keep. It is administrative control, not file
access, and pretending otherwise is the failure mode this section exists to
avoid.

### Where "after setup" ends

Handoff is a moment; sign-in is an event that may not happen for a day. Since
the invite expires in 24h and re-minting needs shell, removing access the
instant we display a link means a customer who opens the dashboard a day later
is locked out of a box they just paid for.

So the access window closes at **customer-confirmed handoff, or 72h, whichever
comes first**. The confirmation is a "Revoke isomux's access" button, which is
also how the customer sees the guarantee is real; the ceiling is what closes
the window for everyone who never clicks it. Until it closes, resend works;
after it closes, the dashboard says plainly that it cannot.

Deliberately *not* "first sign-in": we cannot observe a sign-in without access
to the box, and a rule stated in terms of an event we cannot see is a rule we
cannot keep. A customer may confirm without signing in, or sign in and never
confirm - both are fine, because the ceiling covers them. Making the boundary
genuinely mean first sign-in would need a box-to-control-plane signal, which
reopens the callback surface this design closed.

**This wants Nil's nod:** it interprets ruling 3 as ending at a confirmed
handoff or a ceiling rather than at the moment we show a link, and 72h is a
provisional number (three invite lifetimes).

## The box is driven over SSH, not by the install callback

`install.sh` supports `INSTALL_CALLBACK_URL` and the parent design assumed the
control plane would use it. **It should not, and the MVP does not build that
endpoint.** The callback fires once, at the very end, so it cannot drive a
progress display, and it needs a capability URL baked into the box that lets
whoever reads it post to us. What it uniquely provides - the failure trap's
`{status, step}` - the driver below reproduces locally, and does not depend on
the box reaching the internet to report a problem. The one thing it would still
buy is sub-tick latency on the happy path, which is not worth an authenticated
public endpoint. Wiring it back later is one env var.

Everything else it delivers is already readable over SSH while the access window
is open: the installer logs `--- step: <name>` markers, re-running it is
idempotent, and the admin socket can mint owner logins.

(The installer's own `FAILURE_SENTINEL` is not that signal: it is a random
`/tmp` file whose only job is to stop the failure callback firing twice. It
carries no exit code and no step.)

### The driver protocol

Marker polling alone cannot tell a slow step from a dead process, and a blind
retry can run two installers over each other. So the remote side is a wrapper
script we install, not a bare `curl | bash`. Its invariants, which matter more
than its exact text:

- **Every run has its own generation.** Status lives in
  `/var/lib/isomux-cp/runs/<runId>/{pid,started,exit,log}`, absolute paths
  only, and a `current` pointer is replaced by atomic rename while the lock is
  held. A retry allocates a new `runId`, so a previous run's `exit` can never
  be read as this run's verdict. The tick resolves `current` once and reads
  only that generation, so it never mixes two runs.
- **The exit status is captured when the trap fires, not when it is
  installed.** `trap 'printf %s "$?" >"$RUN_DIR/exit"' EXIT` - single-quoted,
  or the `$?` expands at installation time and records whatever ran before it.
- **The log is appended and never truncated**, so a failed install can be read
  by a human afterwards.

Each tick then reads, in order: the generation's `exit` file (present means
finished, and the value is the verdict), whether the recorded PID is alive, and
the last `--- step:` marker in the log. Absent exit file plus dead PID is a
crash, distinguishable from progress.

Launch and retry are single-flight through one `flock -n`. A failed
acquisition means *someone* holds the lock, which is not by itself proof that
our installer is running: the tick confirms the holder against `current`'s pid
and start time. A held lock that no generation accounts for is an unknown
process on the box, which raises attention rather than counting as progress.

The wrapper and its run directory are removed along with our key, so nothing we
installed for our own convenience outlives the access window.

### Invites are minted on demand, never stored

Do not persist an invite URL. The installer's invite is single-use with a 24h
TTL, and `POST /admin/owner-login` on the admin socket mints a **15-minute**
one that also revokes the previous unconsumed link for that user, so any stored
copy is a stale credential that we are also responsible for protecting.

Instead, minting is a two-hop operation run at the moment the customer asks,
exactly as `install.sh` already does it: mint the 15-minute owner-login URL on
the admin socket, follow it against loopback to obtain an owner session, then
`POST /api/invites/recovery` for the standard 24h single-use link, and return
that. The link goes only to the authenticated session that asked for it; the
audit log records that a mint happened, by whom and when, and never the URL.

The socket takes an owner *name*, and the customer can rename themselves. So
resolve the current owner from the box's live user records (root can read the
service user's state), preferring the `owner-id` the installer persisted, which
is the same fallback ladder `install.sh` uses. A stored name is not enough.

Minting is available only while the access window is open. After it closes,
recovery is the customer's own SSH key and the `owner-login` admin CLI, or
nothing.

## Provisioning: coarse state, explicit operations

Four state axes that must not be collapsed into one, because they diverge:

- **Service state** (what the customer has): `provisioning`, `live`,
  `suspended`, `deprovisioned`.
- **Provider asset state** (what we are paying for): `none`, `order_pending`,
  `order_ambiguous`, `active`, `cancel_scheduled` (with `serviceEndsAt`),
  `cancelled`, `absent`. The provider is the authority; every tick reconciles
  toward what `get` says.
- **Subscription state**: a cache of Stripe's truth, written only by webhooks.
- **Attention**: `clear` or `needs_operator`, with a reason and a severity,
  raised from operation and provider evidence. Orthogonal on purpose - a live
  office can need a human (failed liveness, a reboot that did not help) and an
  ambiguous create is both `provisioning` and attention-required. Folding it
  into service state would throw that away.

Fine-grained progress does **not** live in the service state. It lives in typed
**operation** rows - `create_instance`, `set_dns`, `run_installer`,
`arm_revocation`, `verify_https`, `mint_invite`, `revoke_access`, `reboot`,
`power_off`, `power_on`, `remove_dns`, `cancel_asset` - each with: its own
durable id, status
(`pending`, `running`, `succeeded`, `failed`, `ambiguous`), attempt count,
`next_attempt_at`, `lease_until`, an inactivity deadline, an absolute deadline,
and its last evidence (for `run_installer`, the run generation and last
installer step). That is what the dashboard renders, and it is what makes
recovery deterministic: "installing" is no longer one word covering
not-launched, running, and exited.

`revoke_access` is the one operation that must never be quietly abandoned: an
instance whose access window has closed with a failed revocation is an
attention case, not a shrug - and the box-local timer means the failure costs
us a broken promise about *when*, not a broken guarantee.

There is no `stop_service`. After handoff nothing can reach the service, so
suspension and end-of-life are `power_off` at the provider, and resuming a
suspended box is `power_on`.

### Concurrency

Ticks, Stripe webhooks, and dashboard buttons overlap, so the machine is not a
pure function of state alone:

- Every state transition is a compare-and-swap on a version column. A losing
  writer re-reads rather than retrying blind.
- The tick leases due operations (`lease_until`, CAS) and only the leaseholder
  may act. A crashed holder's lease expires.
- Every requested action carries a durable operation id, which is also its
  idempotency id at any remote seam that supports one.
- One active operation per kind: unique `(instance_id, kind)` **where status is
  `pending`, `running` or `ambiguous`**. Repeatable actions - `reboot`,
  `mint_invite` inside the access window - open a new row only once the
  previous one is terminal, so the index bounds concurrency without forbidding
  a second legitimate reboot.
- `create_instance` additionally has the permanent uniqueness of its
  `create_intent`, and a second intent is never opened automatically.
- Backoff is a persisted `next_attempt_at`. Nothing sleeps inside a tick.

### Deadlines flag; they do not conclude

Each operation carries an **inactivity** deadline that resets whenever its
evidence advances, plus a larger **absolute** ceiling. A 25-minute install that
is still emitting new step markers is healthy; one stuck on the same marker for
ten minutes is not. Blowing a deadline alerts us and tells the customer their
box needs a hand; it does **not** declare terminal failure while the provider
still reports provisioning. Raised attention is an expected condition on a
healthy system, not an error path.

Starting values, to be re-tuned once slice 1 has measurements: provider IP
within 5 min (the pilot's 110s makes this thin but plausible), installer
inactivity 8 min with a 40-minute ceiling, HTTPS reachable within 10 min of
install exit.

**Measured 2026-08-09** (slice 1, Contabo V153 in EU, instance 203474835,
one end-to-end run at `cp1.test.isomux.app`):

- **Reinstall to SSH: 88s.** From the provider accepting the rebuild to our key
  authenticating. Contabo's create-to-SSH of 110s (2026-07-30, task b223ebc3)
  remains the only figure for a fresh create; slice 1 adopted a box rather than
  creating one, so create-to-IP was not re-measured.
- **The box is not ready when SSH answers.** A rebuilt Ubuntu cloud image runs
  its own apt work on boot, and it still held `/var/lib/dpkg/lock-frontend` at
  T+2min on a box that authenticated at T+88s. An installer launched into that
  window dies immediately with `Could not get lock`. Provisioning therefore
  waits for the package manager before it launches anything, and that wait is a
  step with its own deadline rather than a sleep.
- **Installer: 236s to exit 0**, from the marker log:
  install-packages +1s, configure-oom-protection +56s, configure-user-manager
  +69s, check-root-reachability +75s, install-browser +81s, codex-sandbox +148s,
  fetch-isomux +160s, install-bun +166s, build-isomux +179s, wait-for-server
  +223s, assert-hardening +229s.
  Largest gap between consecutive markers: **67s** (install-browser to
  codex-sandbox - the Chrome download). So an 8-minute inactivity deadline has
  about a 7x margin on this box and stands. The 40-minute absolute ceiling is
  untested at the top end and looks generous against a 4-minute install.
- **Install exit to HTTPS 200: 16s**, including one TLS retry while Caddy
  obtained the certificate. A real Let's Encrypt certificate was issued for
  `cp1.test.isomux.app` (notBefore 2026-08-09 14:10:05Z). The 10-minute
  starting value is far wider than needed; the binding constraint on that rung
  is the A record existing before Caddy attempts HTTP-01, not the delay itself.
- **Provider IP within 5 min**: unchanged and still plausible on the pilot's
  110s. Nothing measured here contradicts it.
- **Box clock skew** against ours: **0-2s** across four samples. It matters
  because sshd evaluates `expiry-time` against the box's clock, so every
  deadline is computed from the box's own reading rather than ours.

## Naming, DNS, TLS

The customer picks `<name>` at Checkout, validated as a DNS label, refused if it
shadows a hostname we serve centrally (`www`, `api`, `admin`, `cloud`, `apps`,
`mail`, ...), and unique across accounts. **It is immutable after
provisioning:** renaming means a new certificate, a dead origin for every link
and cookie the customer holds, and a second record to reap.

`isomux.app` is registered, and DNS moves to **Cloudflare** (ruling 6), one
zone with a zone-scoped API token. The zone sits on Namecheap BasicDNS today;
the migration is task 523eec92 and is a prerequisite for automated
provisioning, not a preference. The reason is fleet safety, not ergonomics:
Namecheap's `setHosts` replaces a zone's entire record set in one call, so every
provisioning write would have to read the whole zone, append one record and push
it all back. Two overlapping provisions, or one partial write, can silently drop
*other customers'* records, and the operations model above does not protect
against it - its one-active-operation rule is scoped per instance, and this
collision is across instances. A Namecheap adapter would need a global zone lock
and a read-back verify on every write, machinery that exists to compensate for a
registrar API rather than to serve the product. Cloudflare's per-record writes
delete the whole class of problem. Their IP-allowlisted API access is a second,
independent strike against staying.

App sharing (`port-proxy-design.md`) is deferred, and the only thing it needs
from us now is that the customer's name owns its whole subtree; the wildcard and
delegation layout for `*.apps.<name>` is decided when that work starts. The
Public Suffix List submission is **parked** by Nil.

## Billing

Stripe Checkout for signup, the Stripe customer portal for card changes (no
billing UI of our own), and webhooks as the only writer of subscription state:
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_failed`. Verify signatures,
dedupe by event id, treat the local row as a cache.

**No trial** (ruling 1). Checkout collects a card and charges immediately.
(Amended by Nil 2026-08-03: he may still hand out free boxes for feedback, so
the hosted page's "we may have some free trials available - ask in Discord"
line stands. Self-serve checkout has no trial; comps go through coupons.)

**Coupons are the comped path.** A signup carrying a 100%-off coupon owes
nothing at checkout, so the session sets `payment_method_collection` to
`if_required` and Stripe collects no card - the behaviour Nil asked for falls
out of Checkout rather than needing a bypass. "Comped" is therefore not a flag
we maintain: it is the presence of an active 100% discount on the subscription,
cached from webhooks like every other piece of Stripe truth. When a coupon
lapses, the next invoice has an amount due and no payment method, so Stripe
marks the subscription `past_due`. For a formerly-couponed account that raises
attention and notifies Nil instead of entering the dunning ladder, which is the
manual follow-up he asked for and the one place couponed accounts diverge. That
diversion needs its own deadline - 14 days, then the ordinary ladder resumes -
or an unpaid office serves forever on the strength of an unread notification.

Plan tiers map to provider products in configuration, not code. Pricing is a
small margin over the provider's list price plus the non-EU surcharge for
Seattle (ruling 2); the exact table is still open.

## Cancellation, retention and the promises we publish

Ruling 5 is to mirror oneclickclaw. What they actually publish (fetched
2026-07-31 from their terms, FAQ and privacy policy):

- **Cancellation** "takes effect at the end of your current billing period. You
  continue to have full access to your server and dashboard until then." No
  partial refunds for unused time within a paid period. This matches Nil's firm
  addition, so it is our rule too.
- **After the period ends** the server is stopped and the data "will be
  permanently deleted after a 7-day grace period", with a standing
  recommendation to export first. Their privacy policy adds the outer layer:
  server data deleted within 30 days of server destruction, API keys deleted
  immediately, billing records kept for years under their tax law.
- **Failed payment**: "Stripe will retry according to its dunning schedule" and
  "after repeated failures, your service may be suspended until payment is
  resolved." They publish **no** termination timeline after suspension.
- **Backups**: the only promise is hardware failure - "if a primary drive
  fails, the server is reloaded from the last known backup (at most 24 hours
  old)". No general restore guarantee.
- **Security updates**: nothing beyond noting that emergency maintenance or
  security patches may cause temporary unavailability. No window, no frequency.
- **Support**: a contact channel, no response-time commitment.

Mirroring that gives us: dunning is whatever Stripe's schedule does, then
suspension by provider `power_off` on exhaustion, since after handoff nothing
can stop the service from inside; the backup promise covers box loss only and is
at most 24h stale; we publish no security-update window and no support SLA.

**One deliberate deviation, forced by ruling 3.** They stop the server at period
end and then hold the data for seven days. That half-measure is not available to
us: a powered-off box is unreachable, and we are not the ones who export the
data, so their version of the grace would be seven days in which
nobody at all can reach the data. So **the office keeps serving through the
grace week**, and only then is it powered off and cancelled. The grace is worth
having precisely because the customer can walk in and take their work.

Two things we must fill in ourselves, both **needing Nil's nod**:

1. **Termination after suspension.** They publish none. Proposal: the same
   7 days they use for post-cancellation deletion, so there is one number in
   the product rather than two.
2. **Whether the grace week is real for us**, because it is nearly free for them
   and is not for us. Contabo bills whole months and its term is aligned with
   the Stripe period, so serving seven days past the paid period means letting
   the provider term renew once - a full extra month (~EUR 5.50) per
   cancellation. Proposal: buy it. A week to get your work out is the difference
   between a churned customer and an angry one, and the cost is bounded by
   churn.

Three mechanical consequences. The backup promise is only real once task
962965dc lands a tested restore procedure, and it is P1 for exactly that reason.
Box-loss coverage means buying the provider's backup add-on per box, which the
pilot did not order and which belongs in the cost model behind ruling 2. And
`power_off`, `remove_dns` and `cancel_asset` stay separate retryable
operations rather than one "destroy", because Stripe's clock and the provider's
term are independent; if `cancel_asset` succeeds and our write fails, the next
tick's reconcile against `get` adopts the truth. Nothing assumes a cancellation
can be revoked or a name reused before its term ends: a customer who resubscribes
gets a new box unless the adapter proves otherwise.

One place we cannot copy them: they publish that they hold SSH access and log
sessions for 90 days. Ruling 3 says we do not, which is a real difference worth
saying out loud in our own terms - as far as the provider-console ruling above
lets us say it.

## Data model

`accounts` (Google subject, email) - `subscriptions` (Stripe ids, status,
period end, active discount) - `instances` (name, plan, region, service state,
version, provider row ref, access-window state and the attention fields below) -
`provider_assets` (provider, provider id, intent id, asset state, ipv4, service
ends at, host key fingerprint) - `operations` (as above) - `instance_secrets`
(encrypted provisioning key material, destroyed at revocation) - `audit_events`
(append-only: actor, instance, action, outcome, including every remote command
we run).

Attention is persisted, not derived: `attention_state`, `attention_reason`,
`attention_severity`, `attention_raised_at`, `acknowledged_at`,
`acknowledged_by` on `instances`. Inferring it from live operation rows would
lose the two things that make it useful - an operator-facing reason that
outlives the operation that caused it, and a record that a human has seen it.
Raise and clear both write `audit_events`, which is where the history lives.

The audit log is **in** the MVP; only a customer-facing view of it is deferred.
Secret at rest: the provisioning key (until revocation destroys it) and the
provider and Stripe credentials. Invite URLs and model credentials are
deliberately not in that list, because we keep neither.

## Blast radius while the key exists

Even bounded to the access window, a provisioner holding root on every
in-flight box is the sharpest thing in this design:

- **The public web app cannot decrypt key material and never originates SSH.**
  It enqueues typed operations; a separate provisioner executes them. A
  compromised front end can request a reboot, not run commands.
- Remote commands come from a fixed allowlist with arguments constructed, never
  interpolated from customer input. No dashboard SSH proxy, ever.
- Host key pinned on first contact; a later mismatch is a hard stop that pages
  us, not a warning.
- Every remote action lands in `audit_events`.
- Keys are destroyed at revocation, which bounds the blast radius by how many
  customers are mid-setup rather than by how many exist.

## First run: connecting a model

The office seeds two welcome agents on first install. On a box with no model
credentials the first message to either one fails, and per ruling 4 **that is
the intended flow**: the failure message directs the customer to the terminal
panel to run `claude` and `/login`, or `codex` and its equivalent. Both are
packaged with isomux, so there is nothing to install. Subscription-first, not
API-key-first; the paste-an-API-key form proposed in the previous revision is
rejected and is no longer a launch prerequisite.

The control plane's only job here is expectation-setting at handoff: say that
signing in to a model is the first thing to do inside the office, and that it
happens in the terminal panel.

Two things to verify on a real hosted box before calling this done, both
isomux-side rather than control-plane work: that `claude` is actually on `PATH`
for a terminal-panel session (it arrives as a dependency, not as a system
install), and that both login flows complete headlessly - Codex's browser
callback has historically bound a localhost port, which on a VPS needs a tunnel
the customer does not have. If either is false, the not-logged-in message is
pointing at a dead end, and that message is the whole activation path.

We never resell tokens and never proxy model traffic. BYOK, per the parent
design.

## Dashboard

Provisioning progress with human step labels, the invite link (and resend while
the access window is open), the "Revoke isomux's access" button, liveness, a
reboot button, cancel, and the plan with its next invoice date.

Liveness is a probe ladder, not one boolean: does the name resolve, does 443
accept, does TLS complete, does `GET /readyz` return 200 (unauthenticated,
rate-limited at 30/min per caller, so a 5-minute poll is well inside budget).
Each rung fails differently - our DNS, their cert, a dead service - and the
distinction is what makes the support answer right. Three strikes before we
call it unreachable, and **reboot is never automatic**: a box that fails
liveness gets a human, because the failure may be ours.

Reboot is a VM-level restart through the provider API, because ruling 3 leaves
no way to restart a service from inside: the office's terminal panel runs as the
unprivileged service user, which by design cannot reach root. Say so in the
button's copy - it is heavier than a service restart, it interrupts every agent,
and it is the bluntest tool the customer has. It still earns its place, because
it is the only remote lever left and it fixes a real share of "it stopped
responding".

## Where it runs

Next.js on Vercel with Auth.js and Google as the only identity provider (no
password reset, no email deliverability), managed Postgres, and a **separate
always-on provisioner** holding the provider credentials, the key master and
the tick loop.

The provisioner is the one component we operate, and that is deliberate: it is
what keeps SSH and key material out of the public app, and it removes any
dependence on serverless cron granularity or outbound-SSH support. It fails
gracefully - existing boxes and the dashboard are unaffected, and provisioning
stalls until it is back. Access revocation does not stall, because sshd enforces
the key's expiry on its own; only the cleanup waits, until the persistent timer
can run. It does not share a box with Nil's office.

## Ops floor before we charge anyone

- Terms and a privacy policy stating what ruling 3 gives (no standing access to
  a running office) and what it does not (we rent the box, so reboot, power and
  reinstall remain ours) - with the console wording following whichever of
  (a)/(b)/(c) Nil picks - plus the retention and backup wording above.
- One support channel. No response-time commitment, matching the reference.
- Alerting on any raised attention: an operation past its absolute deadline, a
  live box failing liveness, a host key mismatch, an ambiguous create, a failed
  access revocation.
- A **tested, documented operator restore procedure** - task 962965dc, P1 -
  before the backup wording above can honestly be published.
- The fleet security-update policy, task d2a4a381. Customers click the update
  banner (`release-design.md` picked that policy), so the fleet fragments by
  design, which is fine for features and not for a security fix. We publish no
  window, matching the reference, but we still need an internal answer.

Abuse posture is unchanged from the parent design: dedicated boxes, the
provider's terms govern egress.

## Deferred, with the reason

- **Metrics and a customer event log.** Liveness answers the question customers
  actually have; the internal audit log already exists for us.
- **Restore-from-backup UI.** The procedure has to exist before a button for it
  does.
- **Operator-pushed fleet updates.** Slice 3, and moot under ruling 3 unless a
  box-side updater is triggered some other way.
- **App sharing (port proxy).** Blocked on retiring the loopback-trusted legacy
  routes; the naming note above is all the MVP owes it.
- **Box recycling into a paid-but-cancelled month.** Real money, but only once
  there is a churn rate to recycle.

## Slices

1. Adapter plus the SSH driver: one command turns a provider API call into a
   live HTTPS office with an invite in hand and our key removed, no web app.
   Settles the adapter's `find` semantics, whether Contabo has a create
   idempotency key, and the real timings behind every deadline above.
2. Schema, operations, leases and deadlines behind that command, with the
   ambiguous-create, crashed-install and failed-revocation paths exercised
   against real boxes.
3. Auth, Checkout, coupons, webhooks, the dunning ladder.
4. Dashboard, handoff and the access window.
5. Cancel, deprovision, and the ops floor.

Slices 1-2 are the risk. Everything after is well-trodden Next.js work.

## Still open for Nil

1. **What the guarantee says about the provider console** - (a) narrow the
   promise, (b) forbid the console except a destructive reinstall, or (c)
   consent-gated per incident. Recommendation: (c). This is the one that decides
   whether "we cannot repair or export" is literally true, so it cannot be
   settled by wording.
2. **Plan and price table** (ruling 2 sets the posture, not the numbers). The
   cost model must include the provider's backup add-on and the grace month.
3. **Where "after setup" ends** - customer-confirmed handoff or 72h, which
   interprets ruling 3 rather than following from it.
4. **Termination timeline after suspension**, which the reference does not
   publish. Proposal: 7 days.
5. **Whether to buy the grace week** at one extra provider month per churn.
   Proposal: yes.

Exact deadline values are not on this list; they come from slice 1's
measurements.

## Verify at implementation time

Contabo's `find`/tag semantics and whether it offers a create idempotency key;
its reboot, power-off and power-on actions; programmatic creation of an SSH-key
secret, or `userData` on create (either suffices, we only need keys on the box);
whether a cancellation can be revoked, and whether a box scheduled for
cancellation keeps its disk through a renewed term (the grace week depends on
it); that Ubuntu 24.04's OpenSSH honours the `expiry-time` authorized-keys
option (it ships 9.6, which is well past the 8.2 that introduced it, but the
whole ceiling rests on it so it gets tested rather than assumed - authenticate
either side of the boundary, and boot a box whose deadline passed while it was
powered off); what the
rescue console can actually reach, since decision 1 rests on it;
that `claude` and `codex` log in headlessly from the terminal panel on a real
hosted box; Let's Encrypt's current rate limits before relying on any number;
Stripe's `payment_method_collection: if_required` behaviour on a 100%-off
subscription, including what happens at coupon lapse.
