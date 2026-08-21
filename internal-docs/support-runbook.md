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

