# Operator alerting before launch

Status: recommendation for a pre-launch decision. This document describes the
tree at commit `567bb64` on 2026-08-22. It does not authorize implementation.
Outbound customer mail is out of scope by standing decision.

## What exists

### Attention is durable state, not a notification

An attention reason is a row with an instance, source operation, reason class,
operator-facing reason, severity, raised time, optional acknowledgement, and
optional cleared time. The allowed severities are `info`, `warning`, and
`critical`; the reason classes are inactivity deadline, absolute deadline, and
operation condition (`control-plane/store.ts:73-91`,
`control-plane/store.ts:349-366`).

Raising a reason is deduplicated by instance, source operation, and reason. The
raise inserts the reason, refreshes the instance summary, and appends an audit
event in the caller's transaction (`control-plane/attention.ts:40-75`). The
summary selects the highest-severity open reason. It reports
`needs_operator` until no reason remains open (`control-plane/store.ts:2372-2400`).
This means that several incidents can remain open without one overwriting the
others.

Provisioning operations produce attention in three main ways. Fatal and
ambiguous handler results become critical and warning reasons respectively
(`control-plane/tick.ts:526-583`). Provisioning handlers also raise explicit
reasons when required DNS wiring is absent or observed DNS is wrong
(`control-plane/handlers.ts:113-139`, `control-plane/handlers.ts:837-863`).
Finally, deadline evaluation raises critical reasons for absolute ceilings and
warning reasons for inactivity ceilings (`control-plane/tick.ts:655-703`). The
tick runs that evaluation after it dispatches due operations
(`control-plane/tick.ts:216-242`).

The other implemented producers are certificate renewal failures
(`control-plane/certificate-service.ts:50-71`,
`control-plane/certificate-service.ts:77-96`), repeated liveness failures
(`control-plane/liveness-watch.ts:135-169`), billing conditions
(`control-plane/stripe/billing-attention.ts:45-68`), lifecycle conditions
(`control-plane/lifecycle-tick.ts:207-227`), reinstatement uncertainty
(`control-plane/reinstatement-operations.ts:100-129`,
`control-plane/reinstatement-operations.ts:145-174`), and deprovisioning without
the required DNS writer (`control-plane/deprovision.ts:250-270`). All of them use
the same durable attention primitive; none of these cited producer paths sends
an operator notification.

Acknowledgement means only that an operator saw the incident. It leaves the
reason open and refreshes the same summary; resolution must clear the underlying
reason (`control-plane/attention-ack.ts:19-52`). Clearing is one reason at a time,
uses a version compare-and-swap, refreshes the summary, and writes an audit event
(`control-plane/attention.ts:92-121`). A new unacknowledged reason also makes the
instance summary unacknowledged again (`control-plane/store.ts:2381-2399`).

### The ops floor is the only control-plane operator surface

The floor reads every open attention reason and every unsucceeded operation that
has been flagged past its absolute deadline (`control-plane/store.ts:1915-1927`).
It sorts attention by severity and then age, and sorts overdue work by overdue
duration (`control-plane/ops.ts:92-130`). The web page renders both lists only
after an authenticated operator read; it does not poll, send, or subscribe
(`control-plane/web/app/ops/page.tsx:17-65`). The instance page includes all past
and open reasons, operations, and audit events, so it is useful for diagnosis
after discovery (`control-plane/ops.ts:132-167`). The only operator write exposed
by this surface is acknowledgement (`control-plane/ops.ts:170-189`).

Therefore, the current answer to "who notices?" is: an authenticated operator
who visits `/ops`. The current answer to "how fast?" has no bound. The row is
durable, but no implemented path makes a person visit the page.

### Notification machinery elsewhere

The control plane has no operator delivery module. The only implemented Discord
outbound path in this repository belongs to the public site chat endpoint. It
posts user and assistant chat text to a configured Discord webhook
(`api/chat.ts:364-384`, `api/chat.ts:445-454`). Its user-message send is
fire-and-forget and discards failures; its assistant-message send waits but also
discards failures. It is evidence that the project already operates a Discord
channel, not a reusable alerting guarantee.

The Isomux server has two useful scheduling and delivery pieces:

- Cronjobs check enabled schedules once per minute, start a fresh backend run,
  skip an overlapping scheduled run, and persist the next fire time
  (`server/cronjob-manager.ts:233-235`, `server/cronjob-manager.ts:1152-1180`,
  `server/cronjob-manager.ts:2025-2042`). A run has a 30-minute hard timeout and
  records bootstrap failure in its transcript (`server/cronjob-manager.ts:1090-1110`).
- Agent scheduled messages persist before delivery and use at-least-once queue
  handoff semantics (`server/scheduled-messages.ts:1-23`). They check due work
  every 30 seconds (`server/scheduled-messages.ts:29-33`). They can wake a polling
  agent, but they are not a human pager.

An agent-only turn intentionally makes no completion sound. It adds a visual
attention badge, but sound is limited to turns that started from human input
(`ui/store.tsx:550-570`). Thus, posting an alert into an Isomux agent chat is a
durable secondary record, not an honest claim that Nil was paged.

The database layer already supplies the safe probe rules. Runtime opening does
not create or migrate schema (`control-plane/store.ts:999-1041`). Connection and
query failures are converted to fixed text plus allowlisted structured fields;
the driver's free-text message and cause are never forwarded
(`control-plane/store.ts:857-934`). The production preflight is the established
read-only example: it proves the production target, opens with `openRuntime`,
prints only fixed labels and counts, closes the store, and discards every caught
API or driver error (`control-plane/deploy/preflight.ts:157-218`). Its existing
attention observation is already a count of uncleared reasons
(`control-plane/deploy/preflight.ts:127-147`).

## Channels available without a new service

| Channel | Earliest discovery | Main failure modes | If the channel is down |
| --- | --- | --- | --- |
| Manual ops-floor visit | Whenever an operator next visits | No visit, expired session, web or database outage | Nothing else notices; latency is unbounded. |
| Polling agent or cronjob in this Isomux office, with an Isomux chat result | Up to five minutes until due, up to one minute of scheduler tick lateness, then one model run; not a hard bound | Isomux stopped, backend unavailable, run overlap, production database or network unavailable, agent prompt error | The failed/skipped run is retained, but no sound fires for an agent-only result. A person must inspect Isomux. |
| Polling agent followed by the existing Discord destination | Up to five minutes until due, up to one minute of scheduler tick lateness, then one model run and Discord delivery; about seven minutes in normal operation, not a hard bound | All poll failures above, missing or rejected Discord credential, Discord/network outage, webhook rate limit, phone notification settings | The poll transcript can record a fixed failure class, but Discord cannot report its own outage. A separate expected heartbeat must make silence visible. |
| Provisioner or web process logs | As soon as an operator tails or queries logs | Process or host failure, log loss, no active reader | The incident remains in the database; no person is interrupted. |

The office poll and Discord send are complementary. The poll keeps production
database access read-only and leaves evidence here. Discord is the only channel
already present that normally reaches a phone away from the ops page. Its actual
push latency depends on Discord and the operator's device settings, so the
system cannot promise a hard receipt time.

## Recommendation

Ship one narrow operator sentinel in this existing Isomux office before accepting
paid signups:

1. Run it every five minutes, which is the cronjob platform's current minimum
   interval (`server/cronjob-manager.ts:233-235`). Name the interval in a constant
   and do not add an env knob. Do not expose severity thresholds or channel
   selection.
2. Use a dedicated production read-only role and a small probe that follows the
   preflight shape: prove the production branch, open runtime, select only open
   attention identifiers, severity, raised time, and acknowledgement state, and
   discard raw database/API errors. The probe must never print a DSN, database
   row reason, provider output, or raw error. This role is new implementation
   work: the current named runtime roles are `cp_web` and `cp_provisioner`, and
   both have write grants (`control-plane/roles.ts:40-42`,
   `control-plane/roles.ts:166-175`, `control-plane/roles.ts:262-270`).
3. On each newly observed unacknowledged reason, send one minimal Discord alert:
   severity, stable instance and reason identifiers, age, and the ops-floor URL.
   Keep a small local dedup record in the sentinel's office-owned state. Repeat
   an unacknowledged critical alert after a fixed interval so one lost Discord
   request is not permanent.
4. Also record every alert and every classified probe or Discord failure in the
   sentinel transcript. Send a short daily Discord heartbeat with the last
   successful database-read time. Nil treats a missing heartbeat as a channel
   incident.

This is the smallest honest answer because it uses the existing office, the
existing production-read pattern, and the existing Discord destination. In
normal operation, Nil is the named operator and should receive an alert in about
seven minutes: up to five minutes until due, up to one minute until the scheduler
observes it, and then the model run and Discord delivery. The statement is a
target, not an SLA: neither this box nor Discord supplies independent receipt
confirmation.

The first implementation should not add customer email, SMS, a paging vendor,
severity routing, schedules, escalation policies, acknowledgement from Discord,
or automatic remediation. It also does not survive a simultaneous outage of
this Isomux office and the control plane, and it cannot detect its own Discord
failure immediately. The daily heartbeat makes that last failure observable,
but only to a person who knows to expect it. A true hard delivery guarantee needs
an independent monitor or paging service, which is deliberately outside the
pre-launch constraint.

Before implementation, Nil must confirm that the existing Discord destination
is appropriate for customer-incident metadata and identify the one operator
account or channel that should receive it. No credential should be copied into
the repository or a transcript.
