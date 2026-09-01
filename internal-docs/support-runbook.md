# Hosted support runbook

This runbook covers refund and card-change requests sent to
`llc@isomux.com`. It is an operator procedure, not a new customer promise. The
published [refund policy](../site/hosted-refund.html) and
[terms](../site/hosted-terms.html) control eligibility.

## Identify the account

Do not act only on an office name, Stripe receipt, or forwarded message.

1. Confirm that the request came from the same email address as the hosted
   account. Compare addresses case-insensitively. If it did not, ask the
   requester to write again from the account email. Do not disclose whether the
   named office or account exists.
2. In the control-plane production database (the Neon production branch), find
   the `accounts` row by `email`. Join it through `name_reservations.account_id`
   to the office and instance. Confirm that the supplied office name matches
   `name_reservations.name`.
3. Cross-check `accounts.stripe_customer_id` and the current
   `subscriptions.stripe_customer_id` against the customer in the live-mode
   Stripe Dashboard. Confirm that the Stripe customer email is the same account
   email before taking any billing action.

The production database is the local record of account ownership and service
work. Stripe is the authority for payments, invoices, subscription state, and
refund state. Use the operator-owned production database connection or Neon SQL
Editor for database checks. Do not copy credentials into a ticket, support
message, command line, or transcript.

## Decide refund eligibility

Identify the exact payment in the live-mode Stripe Dashboard before deciding.
Use the local subscription's `latest_invoice_id` as a starting point when it is
the requested payment, and then confirm the invoice and successful payment in
Stripe. The control plane stores invoice identifiers, not payment or refund
identifiers.

### First 7 days

This class is a full refund of the first subscription payment only.

1. Check `name_reservations.created_at`. This is when the first office signup
   was written. The account row can predate signup, so do not use
   `accounts.created_at` for the seven-day calculation.
2. Confirm in Stripe that the selected payment is the first successful
   subscription payment for that account and office.
3. Confirm that the customer cancelled within seven days of the signup time.
   Check the current Stripe subscription and the local `subscriptions` row. A
   customer cancellation has `cancellation_reason = 'cancellation_requested'`;
   `canceled_at` records when Stripe observed the request, and
   `cancel_at_period_end` records the current scheduled cancellation. Do not
   treat a payment-failure cancellation as a customer cancellation.
4. If the cancellation time is no later than signup time plus seven days, the
   first payment is eligible for a full refund. If it is later, do not refund
   unused time in the paid period unless the failure-to-deliver class below
   applies or applicable law requires a refund.

### Failure to deliver

This class is an unconditional full refund of the payment taken for an office
that Isomux could not provide. It does not require dashboard access or a
cancellation first.

Check all of these control-plane records for the instance:

- `instances`: `service_state`, `attention_state`, and `attention_reason` show
  the coarse service result and any unresolved operator condition.
- `operations`: the ordered setup record. Review each row's `kind`, `status`,
  `evidence_at`, and deadlines. A succeeded `verify_https` is the boundary at
  which the control plane proved that the office answered at its own address
  and changed `instances.service_state` to `live`.
- `audit_events`: the timestamped result of each operation and service-state
  change.
- `provider_assets`: whether a provider machine was ordered and its current
  asset state. This is supporting evidence, not proof that the office was
  delivered.
- `stripe_events` and `subscriptions`: whether the selected paid subscription
  was received and linked to this instance. Stripe remains authoritative for
  the payment itself.

A `mint_invite` row is not required for delivery: after verified HTTPS, the
dashboard creates that operation only when the customer asks for an invite. A
provider asset alone is also not delivery. If the selected payment succeeded
but the office never reached a succeeded `verify_https` and Isomux cannot
provide the ordered office, refund that payment in full. Record the evidence
used in the internal support record.

### No partial refunds

Do not prorate a monthly payment or refund its unused remainder. Outside the
two classes above, issue no partial refund under this policy. Escalate a legal
requirement separately; do not reinterpret it as a policy refund.

## Issue an eligible refund

There is no control-plane refund command. Use the live-mode Stripe Dashboard:

1. Open **Payments** and select the exact successful payment confirmed above.
   Check the customer, invoice, subscription, amount, currency, and payment date
   again.
2. Select **Refund payment** from the payment's overflow menu or details page.
3. Leave the amount at the full payment amount. Do not enter a partial amount.
4. Select the accurate reason. If Stripe requires a note, state either
   `first 7 days` or `failure to deliver` and include the internal support
   reference. Do not put support-message contents into Stripe.
5. Submit once. Do not repeat the action after an unclear result. Reload the
   payment and confirm that Stripe shows one full refund and its status.
6. Reply to the verified account email with the payment date, refunded amount,
   and Stripe refund status. Keep the support request and the eligibility check
   as the internal record.

Stripe sends a refund only to the original payment method. Do not ask for a new
card, bank details, or another destination. If Stripe later marks the refund as
failed, investigate that Stripe refund; do not create a second refund without
first proving that the first one failed and the payment again has refundable
funds.

## Close the office after the refund

A refund alone changes nothing on the service side: the control plane does not
handle Stripe refund events, so the office keeps serving, and unless the
customer already scheduled a cancellation, Stripe bills again at the next
period. Always complete the steps below after you issue a refund.

The refund replaces the retention promise. A normal cancellation keeps the
office data for 14 days so the customer can restore it; a refunded office is
closed for good. There is no early-deletion command, and do not improvise one:
the control plane powers the box off at once and deletes it on its normal
automatic schedule. What "the retention window does not apply" changes is the
customer's options, not the deletion mechanics: a refunded customer gets no
restore and no temporary access.

1. In the live-mode Stripe Dashboard, cancel the subscription immediately.
   The customer's own dashboard cancellation only schedules the end of the
   paid period, so the subscription is usually still active when the refund
   is issued. Do not leave it scheduled: a refunded office must stop serving
   now, not at period end.
2. Confirm that the cancellation reached the control plane. Within a few
   minutes, the local `subscriptions` row must show `ended_at` set and
   `cancellation_reason = 'cancellation_requested'`. If `cancellation_reason`
   holds another value, the automatic teardown never starts and the box stays
   up: stop and escalate. Do not edit the database to compensate.
3. Confirm the power-off: `instances.service_state` becomes `suspended` when
   the control plane confirms the power-off, usually within minutes. From that
   point the box is off, and the `cancel_asset` and `remove_dns` operations
   open automatically 14 days after `ended_at` with no operator action.
   For a failure-to-deliver refund the office may never have served: still
   cancel the subscription and confirm the database record the same way; if no
   box is live, there is nothing to power off.
4. In the refund reply, also state: the office is closed and cannot be
   restored, and the office name cannot be used again for a new signup (name
   reservations are permanent). This matters because the customer's dashboard
   keeps offering reinstatement and temporary access until the deletion
   operations open on day 14; the reply is what tells the customer those
   offers do not apply after a refund. Do not grant temporary access to a
   refunded office. If the customer re-subscribes through the dashboard on
   their own before day 14, that is a new paid subscription and it stands.
5. Record the refund, the cancellation, and the checks above in the internal
   support record. The control plane has no operator free-text audit path;
   the support record is the record.

Do not force an earlier deletion:

- Do not edit `subscriptions` or `instances` rows. Lifecycle operation ids
  derive from `ended_at`, so editing it orphans the operations already on
  record, and webhooks are the only sanctioned writer of subscription rows.
- Do not use the `recycle` CLI command or a provider reinstall to wipe the
  box. They bypass the control-plane store, leave it believing the office is
  still retained, and arm a fresh live SSH key.
- Do not touch the box in the Contabo panel. Contabo cancels only at the
  paid-term end, and the automatic `cancel_asset` operation handles the
  provider term on its own.

## Change a card before the customer portal is enabled

Isomux never receives card details. Do not ask the customer to email card data,
and do not enter card data for them.

1. Complete the account checks above, and open the matching live-mode Stripe
   subscription.
2. Confirm that it is the subscription for the requested office and that its
   billing method is automatic collection.
3. From the subscription's **Actions** menu, choose **Share payment update
   link**. Use Stripe's option to email the single-use link directly to the
   verified account email. Do not send it to a different address.
4. After the customer confirms completion, reload the subscription in Stripe
   and confirm that it shows the new card as the subscription payment method.
   Do not inspect or repeat card details in the support reply.

The update link changes the payment method for that subscription; it does not
change the customer's default payment method. It is available only for eligible
automatically billed subscriptions, and Stripe can withhold it for an ended or
otherwise unsupported subscription. If the action is unavailable, stop and
report that constraint. Do not collect card data or improvise an API write.

Enabling and configuring the Stripe customer portal is a pending Nil Dashboard
action. Until that action is complete and the product exposes the portal path,
the single-use Stripe payment-update link above is the manual card-change path.


## An office answers on the box but not on the internet

The symptom the customer reports is that their office URL stopped loading.
Isomux itself is fine: the service is active, `/readyz` answers over loopback,
and agents keep working. What is gone is Caddy, the front door that terminates
TLS and proxies to the office.

The known cause is v2026.9.1's access logging. Caddy is configured to write
`/var/log/caddy/isomux-office-access.log` and `isomux-app-access.log`, and on
that release the installer's root-level config check created those files owned
by root before Caddy started under its own account. Caddy then could not open
them and exited. v2026.9.1 was withdrawn from the release channel and the
installer now creates and repairs both files for the Caddy account, so no box
can newly enter this state - but a box that updated inside the window stays
down, because the migration returns early when Caddy is inactive and never
reaches the repair.

Confirm it is this, over SSH as root:

```
systemctl is-active caddy
journalctl -u caddy -n 20 --no-pager
ls -l /var/log/caddy/
```

It is this failure when Caddy is inactive or failed, the journal shows
`open /var/log/caddy/isomux-office-access.log: permission denied`, and the log
files are owned `root:root`.

Repair, proven on a live box:

```
chown caddy:caddy /var/log/caddy/isomux-office-access.log /var/log/caddy/isomux-app-access.log
systemctl restart caddy
```

Then verify from OUTSIDE the box, never over loopback - a loopback check
passes throughout this failure, which is how the broken update reported
success in the first place:

```
curl -sS -o /dev/null -w '%{http_code}\n' https://<office-domain>/readyz
```

A 200 means the front door is back. If Caddy still will not start, read the
journal again rather than repeating the chown: a different Caddy failure has
the same customer-visible symptom, and this box has no restart policy that
would revive it on its own.
