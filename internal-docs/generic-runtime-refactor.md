# Generic Runtime Refactor — Master Plan

Status: design proposal, all design decisions locked; pending go to execute. This is the single source of truth that consolidates three threads that turned out to be one architecture:

1. Client/server split (server becomes a metaphor-agnostic generic runtime; the office becomes a skin).
2. Full, introspectable REST API (every capability reachable via REST; WS reserved for streaming).
3. Testing strategy (the safety net that lets us do 1 and 2). Detailed in `internal-docs/testing-strategy.md`.

## The one architecture (the center)

A **tested core of command-semantic operations**, each declaring `{auth/capability required, side-effects it owns, observable signal(s) it emits | non-observable}` (the "operation manifest"), sitting on **generic primitives** (groups + a scope tree + rule-based ACL + the already-clean backend seam), under **thin transports** (REST for commands and queries, WS for the live event stream only).

How the three threads map onto that center:

- **Client/server split** = the core and primitives are metaphor-agnostic (groups not rooms, rule-based ACL, desk becomes skin layout). The office is a skin/client over the generic API.
- **Full REST API** = the thin REST transport over the core; WS shrinks to streaming.
- **Testing** = characterize the core first (safety net), then TDD the new core and transports.

The first milestone is not "write endpoints"; it is "define the core-operation boundaries plus the auth/projection/event contract."

## Decided

- **Hierarchy:** fixed 3 layers (global → group → agent), not N-layer. The cascade (prompt/env/memory) folds along the containment chain, but there is a second, orthogonal axis: a per-user/manager contribution. `buildSystemPrompt` injects the agent's owning user's `memberPrompt` plus a manager-identity section, keyed by user, not by the containment tree. So the cascade has two axes (containment + ownership); the generic runtime must carry the manager/`memberPrompt` contribution as an explicit input to the fold, not assume a single ancestor chain.
- **Groups uncapped:** the 8-per-group cap and `desk` are office-skin presentation. Runtime has unordered group membership; the skin owns placement via `officeLayout[groupId][agentId] -> slot` (migrate existing `desk` into it). Move desk vocabulary out of the generic runtime prompt builder.
- **Stable ids (B3):** `agent.room` array index → stable `groupId`. This removes agent-record renumbering (`reorderRooms`/`closeRoom` today rewrite every agent's `room` index) and the reorder churn that follows. It does NOT by itself kill presence rebroadcast or projected full_state on create/close: presence is already stored by stable room id, and the index that shifts is the per-recipient **wire** projection (dense because each user's `allowedRooms` filter creates holes), which is independent of `groupId`. Killing that churn additionally requires moving the wire off dense numeric room indices to id-keyed maps — a separate change (see Phase 4) that B3 does not cover.
- **Full-power REST:** all commands + queries become REST. WS reserved for the live event stream (log/thinking/tool/approval/terminal IO/presence) + interactive terminal only. Session lifecycle commands are REST; only the live feed stays WS.
- **WS-command strangler:** expand (REST endpoint calls the same command-semantic core op) → migrate UI → contract (delete the WS command + its bespoke response message such as `settings_save_response`, `cwd_validation`, `agent_save_response`).
- **Event contract is multi-bus:** every externally-visible mutation emits on some bus (the `AgentManager` event bus [OfficeEvent + log + slash_commands + terminal + killed] | the `CronjobManager` bus | a targeted per-request response) OR is explicitly classified non-observable. Caveat: auth/user events (`session_revoked`, `invite_revoked`, etc.) are emitted *inline* inside WS command handlers, not on a subscribable bus, so the contract-test helper must special-case them. Enforced by a contract test helper.
- **Core ops at the command-semantic level**, not OfficeState primitives: `createRoom`/`closeRoom`/`reorderRooms`/`updateUser-allowedRooms` own their compound side effects. Captured in the operation manifest.
- **Double-signal:** HTTP = per-caller outcome; WS broadcast = shared state. HTTP authoritative for queries and caller-private results; for evented mutations the UI applies the broadcast and uses HTTP only for ack/error/ids/nav (echo-authoritative). Idempotency keys on retryable POSTs. UI tolerates event-before-HTTP via op/request ids.
- **Ordering:** client awaits dependent calls (no server sequence numbers). Trichotomy: independent → concurrent; dependent-sequential → await; dependent-atomic → one compound endpoint.
- **Auth (Option 1):** scoped per-agent bearer tokens, separate from user tokens (no owner inheritance → no confused-deputy), capability-scoped, rotate on spawn/revive, revoke on kill, redacted everywhere (+ redaction tests). Narrow loopback path stays legacy-only during the strangler. In-process calls use internal function calls or a privileged internal token, not unauthenticated localhost HTTP. Concrete vulnerability this closes: today `senderAgentId` on `POST /agents/:id/message` is unauthenticated and spoofable by anything on loopback (the server trusts the body's claimed sender) — there is no agent-identity concept yet, only loopback trust.
- **Token delivery & identity:** agent tokens are delivered via env (`ISOMUX_AGENT_TOKEN`), reusing the existing per-agent env-injection path; not prompts, and not a signing helper (its only gain is leak containment, which is moot without per-agent OS isolation, so revisit only if isolation lands). A token represents an identity, an agent (agent-scope) or a user (with their role), and authorization reuses that identity's existing rules; an external client is therefore browser-equivalent for whatever identity its token carries, with no separate narrow automation tier.
- **ACL direction:** rule-based owner visibility (owner sees all groups, computed) + explicit grants for member access. Split "access" (rule/grant, security) from "view preference" (which visible groups am I showing, non-security; server-stored, so it syncs across devices). Removes the create_room owner fan-out. Gated on the projection/ACL characterization net + a focused security review during implementation (a mistake here is a security hole, not a bug).
- **Tasks & cronjobs scoping:** Tasks stay a global shared board, token-authed, with `createdBy`/`assignee` derived from the token (not the client-supplied body). Cronjobs are owned by their creator and run with the creator's env; edit/delete/run-now is restricted to the owner-user + office owners, while visibility is office-wide read (anyone can see a cronjob and its run history; only the owner or an office owner can change or fire it).
- **Testing:** characterization (existing code) + TDD (new code); tiers T0-T3; default `bun test` makes zero LLM calls; live tier opt-in, invariant-only, serial. FakeBackend is the main T1 engine; non-backend harnesses for auth/projection/presence/terminal/cron/files. (Full detail in testing-strategy.md.)

## Review gates (no open design decisions)

All design decisions are locked (above). Two review gates remain; they are gates, not open decisions:

- The final token/auth design gets a Reviewer4 security pass before implementation.
- The rule-based ACL gets a focused security review during implementation (a mistake there is a security hole, not a bug).

## Phased plan

0. **Prereq:** configurable state root. Bigger than it looks: ~20 files / ~79 homedir references today (incl. migrations, skills, plugins, safety-hooks, cwd-utils, backup, terminal, command-handlers, isomux-diff), with no config-root abstraction. Introduce a single config module and migrate callers incrementally, plus a cleanup guard that refuses destructive cleanup outside a temp dir.
1. **Safety net:** projection/ACL + persistence/migration characterization at the core, via FakeBackend + a multi-user/multi-socket in-process harness. Prerequisite inside this phase: build the backend-injection seam first — `getBackend()` is called directly at ~14 sites with no DI hook, so making FakeBackend injectable is real work (a registry override or resolver param), not just wiring. Highest-value net for B3 and the ACL change.
2. **Contract:** the operation manifest (auth + side-effects + bus per op), the multi-bus event invariant, and the token model. Expressed as tests (contract-first).
3. **Generic-runtime core changes, guarded by step 1:** B3 groupId; rule-based owner ACL + split view-preference; desk → skin officeLayout; uncap groups; cascade as a fold over the containment chain plus the per-user manager/`memberPrompt` axis.
4. **Transport:** REST endpoints over the core + token auth + one event stream; move the wire off dense numeric room indices to id-keyed maps (so create/close/reorder stop churning presence + full_state for restricted users — the piece B3 does not cover); strangler-migrate the UI; delete duplicated WS commands and their response messages.
5. **Skin:** office labels + isometric layout as the reference client over the generic API.

## References

- `internal-docs/testing-strategy.md` — the testing thread in full (tiers, seams, traceability matrix, projection/ACL checklist).
