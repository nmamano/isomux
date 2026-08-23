# Pending Checkout poll fallback

Measured 2026-08-23. Design gate only. No implementation has started.

## Boundary and current states

The open incident gap is narrow: Stripe has created a subscription, but no
webhook arrived, so no local `subscriptions` row exists. If the row exists,
`sweepProvisioningStarts` already repairs a missed create operation, and
`startProvisioningIn` makes that repair idempotent.

An ordinary signup can now sit in these states:

- a durable reservation exists, but Checkout creation failed definitely or
  ambiguously;
- Checkout is `open` and the customer has not completed it;
- Checkout is `complete` and paid, but no local subscription row exists;
- Checkout is `complete` and its subscription was reconciled, but provisioning
  has not started;
- Checkout is `expired`, no subscription exists, and the unique reservation
  still holds the name.

Only the reservation and stable creation keys are durable today. The ordinary
signup does not record the Checkout session ID or expiry. Reinstatement does
record its session ID and has `opening`, `pending`, `accepted`, `expired`, and
`attention` states. Its retention machine already proves expired or complete
truth before deletion. This design does not replace that safety machine.

## Options

1. List Checkout sessions from Stripe, paginate them, and match metadata. This
   avoids a schema change, but it turns every cadence into an account-wide scan,
   needs list permission, and has no local terminal marker for abandoned
   sessions. It also makes the provisioner depend on Stripe history retention.
2. Persist the exact session returned by creation. This adds durable columns,
   but it gives the cadence a bounded candidate query and uses only object GETs,
   which is compatible with the planned read-only provisioner key.

Recommendation: option 2. It mirrors the proven reinstatement pattern already
in this schema: `reinstatement_attempts` carries a session ID, generation,
Stripe expiry, and the states `opening`, `pending`, `accepted`, `expired`, and
`attention`. Add the corresponding generation, session ID, Stripe expiry, and
a small local checkout state to `name_reservations`. The proposed states are
`opening`, `pending`, `reconciled`, and `expired`. A reservation created by an
older build has no session ID and is not polled until a customer retry resolves
the existing idempotent create and records the returned session. Because these
are new persisted fields and a state machine, manager approval is required
before implementation.

## Where it runs and how it converges

Add a pending-Checkout reconciliation step to `runLifecycleCadence` in
`control-plane/cli.ts`, the loop that actually runs in the hosted provisioner.
Do not put the guarantee only in `billingTick`, which has no automatic caller.
The production composition supplies the existing `LiveStripeReader`; tests
supply a stub `StripeObjectReader`. No test calls Stripe.

For each reservation in `pending` with a session ID and no linked local
subscription:

- `open`: leave it pending. Poll it at a bounded persisted next-check time.
  Continue fetches and reuses this exact recorded generation and session. It
  never advances a generation while the current one is open. A fetched
  `expired` result marks the generation expired and advances it in that same
  request, so the customer gets a new Checkout instead of an expired Stripe
  page. Any unavailable read fails closed and asks the customer to retry;
  elapsed local time alone never advances a generation.
- `complete` with a subscription ID: fetch that subscription, then call the
  existing reconciliation writer and provisioning gate in one transaction.
- `expired` or absent: mark this generation terminal. Do not raise attention.
  Stop polling it. Only this terminal state permits the customer's next Continue
  action to advance the generation and use a new generation-derived session
  idempotency key. The reservation and name stay with that account. No other
  Continue path advances the generation, so one reservation cannot have two
  customer-reachable open sessions.
- unavailable, malformed, or mode-mismatched: write no billing truth. Retry
  transient reads with bounded backoff; surface malformed or mode mismatch as
  an operational failure, without treating customer abandonment as one.

Creation must record the returned session ID before giving its URL to the
browser. Inside Stripe's 24-hour idempotency window, a crash after Stripe
accepts creation is recovered by repeating the same generation's create,
receiving the same session, and recording it. After that window, Stripe may
create another session. The first is safe to orphan because recording precedes
URL delivery, so no customer could have received or completed it. The session
expiry returned by Stripe must also be normalized and persisted; the current
`CheckoutSessionCreated` shape does not expose it.

## Webhook and poll ordering

The poll is checkout-completion recovery only. It never synthesizes
`invoice.payment_failed`, never increments payment failures, and never runs the
episode half of `decide()`. This separation is required because a subscription
first observed as `past_due` or `unpaid` would otherwise open a dunning episode
even without an invoice event. A synthetic Stripe event ID is not treated as
dedupe against the real webhook event, and the poll does not invent one.

Instead, extract one shared fetched-checkout reconciliation entry point under
`reconcile.ts`, which remains the only writer of subscription truth. Both the
webhook path and poll path call it. The transaction locks the reservation (and
subscription row), ensures or re-reads the subscription row by Stripe
subscription ID, runs the existing `linkageFrom` unchanged, and
applies its patch and safeguards through the current CAS writer. It must reuse
`linkageFrom`, not re-derive linkage: that is what sets `instance_id`, enforces
the prior-customer-data refusal, and preserves the reinstatement eligibility and
refund fences. The poll applies only the fetched Stripe-owned subscription
snapshot and linkage. Export and reuse `ownedFrom` from `dunning.ts` as the one
snapshot-to-columns mapper, but omit `last_event_id` and `last_event_created`
from the poll patch so `casRow` leaves that webhook evidence untouched. Do not
copy their current values into the patch and do not synthesize replacements.
The poll does not run dunning episode decisions.
It then calls the idempotent provisioning gate and marks the exact checkout
generation reconciled.

Reinstatement Checkouts are out of this poll's candidate set. They live in
`reinstatement_attempts`, not ordinary `name_reservations`, and their existing
retention machine remains responsible for them. Therefore, this poll never
partially runs the reinstatement acceptance, power-on, or refund follow-through.

Provisioning keeps the webhook's two-part Checkout gate: the fetched session
must have `status=complete` and `paymentStatus=paid`. Complete but unpaid does
not provision.

If the webhook wins, the poll sees the linked subscription or reconciled
generation and stops. If the poll wins, the webhook later fetches current
Stripe truth and applies it again through the same CAS path. This can update a
cache snapshot twice, but it cannot create a second subscription row or provider
create operation: the subscription ID is the primary key, reservation linkage
is locked, and `startProvisioningIn` has both a fixed operation ID and an
any-create-row guard. The webhook still claims its real event ID for evidence.
The poll records its observation in audit data, not as a fake Stripe event.

The implementation must preserve the existing per-subscription serialization
or add equivalent retry-on-CAS-loss behavior for poll/webhook overlap. A CAS
loss must cause a re-read and convergence, not a false terminal state.

## Failure modes to pin

- crash after Stripe creates a session but before local recording;
- webhook and poll both observe one completion in either order;
- two poll passes overlap;
- an open session remains open over several passes without attention noise;
- Continue on an open generation returns that generation and cannot open a
  second live session;
- an expired session stops polling and the next customer action opens exactly
  one new generation;
- an absent session becomes terminal instead of polling forever;
- Continue after the persisted expiry confirms remote expiry and opens the next
  generation without waiting for the cadence;
- Continue after the persisted expiry cannot read Stripe and does not advance;
- an old reservation with no session ID remains retryable;
- unavailable reads write no subscription or checkout terminal state;
- mode mismatch and malformed Stripe objects fail closed;
- completion without a subscription ID does not provision;
- complete but unpaid does not provision;
- the poll cannot enter or mutate the dunning ladder.

Each reservation is isolated in its own try/catch. An unavailable read is a
retry for that candidate. A thrown mode mismatch or malformed object reports
that candidate and continues the pass, so one bad row cannot stop recovery for
every other customer.

## USD support estimate

The type and formatter already accept USD, and Stripe catalog helpers pass a
currency through. Missing work is product policy and selection:

- create one USD recurring Stripe Price per plan in test and live catalogs;
- represent both EUR and USD display prices per plan, rather than one
  `customerPrice`;
- choose and persist a customer's billing currency before Checkout; do not infer
  it again on later requests;
- resolve the Stripe Price by plan plus persisted currency;
- show the selected currency consistently in signup and account copy;
- verify coupons, reinstatement, and continuation reuse the original currency;
- add tests that the billing cadence and reconciliation remain currency-neutral.

Recommendation: an explicit currency choice at signup, persisted on the
reservation and then treated as immutable for that subscription. Use separate
Stripe Price objects under the same product. Do not use IP geolocation or
browser locale as billing truth, and do not add a deployment environment knob.

Estimate: 2-3 engineering days after Nil sets USD amounts: about half a day for
Stripe test/live catalog setup and configuration, one day for plan model,
selection, persistence, and Checkout resolution, and half to one day for UI,
tests, and docs. Add one day if existing reservations need a migration or if
currency switching after signup is required.
