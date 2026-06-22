# isomux-memory: design

> Status: **REVISED DIRECTION (2026-06-21)**. Supersedes the prior
> mem0/vector-based spec (commit `b04c6fa`, in git history). Open product/impl
> decisions are in section 10.

## 0. Direction change (why this replaces the prior spec)

The prior spec wrapped mem0 (OSS mode): on every turn it retrieves the relevant
existing memories, runs an LLM extract-and-reconcile pass (ADD / UPDATE / DELETE /
NONE against what is already stored), and persists to Qdrant; retrieval is vector
similarity over four category scopes. That reconcile step ran on every turn
(`infer: true`), so dedup and updates worked as designed.

We are moving off it for three reasons specific to our use case:

- **Default extraction over-captures for our domain.** mem0's default extraction
  prompt is tuned to capture every memorable fact, which fits a personal-assistant
  domain. For engineering agents with long turns, "memorable" sweeps in transient
  work-state, and the store grew to **8,603 facts, most ephemeral**. mem0 supports
  a custom extraction prompt; we never tuned it.
- **Per-turn cost.** One extract-and-reconcile LLM call per turn does not fit a
  write-every-turn / read-once-per-session pattern. At our turn volume the
  extractor's API key hit its monthly spend cap and added ~10s turn-boundary
  latency.
- **Opacity.** A vector store is not meant to be read or edited by hand. We want
  memory the boss can open, grep, and curate directly. As a starting point, plain
  files plus grep are enough; vector retrieval can come later over the same files
  if we need it (section 7).

**The key insight** (schema-grounded memory, e.g. arXiv 2604.27906): the facts
worth keeping are not about the *task*; they are about *people, projects,
environment, and rules*, which have a small, stable shape regardless of what the
agents are working on. isomux is a **general meta-harness**, so we cannot define
a schema for the task. But we **can** schema the one thing that is always
constant: the **office / room / boss / agent** structure.

**New direction:** filesystem-based, agent-authored, REST-mediated memory. No
per-turn extractor. The "schema" is the office hierarchy; the durable-fact
taxonomy is small and task-agnostic; agents decide when to write.

## 1. Model

Memory is **plain markdown files on disk**. The directory tree *is* the schema.

```
~/.isomux/memory/
  office.md                  # office-wide, visible to everyone
  rooms/<roomId>.md          # a room/project, visible to anyone in that room
  agents/<agentId>.md        # an agent's standing facts, visible with that agent
  bosses/<userId>.md         # a single boss's scoped facts
```

Each fact is **one provenance-stamped, ID-tagged markdown line**:

```
- <!-- mem:ab12cd --> [<author>, <YYYY-MM-DD>] <self-contained fact>
```

The leading `<!-- mem:ID -->` is a stable, immutable id (renders invisibly in
markdown) so update/retract can target an exact line even amid near-duplicates
and concurrent appends. Retraction is a **tombstone or supersede line**
(`supersedes:ab12cd`), never an in-place rewrite, so append provenance survives
edits. One-fact-per-line keeps concurrent writes append-safe, greppable,
`git`-diffable, and human-editable.

### Fact taxonomy (task-agnostic, the only "schema" you pre-define)

A small fixed list of *kinds* of durable fact. This is a gate, not a typed schema
language:

| Type | Example | Natural scope |
|---|---|---|
| preference | "no em dashes in prose" | boss |
| convention | "this room uses Bun" | room |
| rule / prohibition | "never touch the 8788 daemon" | room/office |
| environment / infra fact | "clawdbot runs on port 3456" | office |
| role | "Isomuxer4 pairs with Reviewer4" | agent |
| contact / external | "DNS for chess: A 66.241.124.181" | boss/office |

The durability gate: **write lasting facts about people/projects/environment/
rules; do NOT write work-in-progress** (the session transcript already holds
that). Working-state does not fit any type, so it never enters memory.

## 2. Scope model and trust boundary (same-user reality)

The four scopes carry over from the prior spec, but **"private" is an
application-level scope, not a confidentiality guarantee**:

- `office`, `room`, `agent` are cross-boss visible by scope.
- `bosses/<userId>.md` is *scoped* to one boss.

**What "private" does and does not mean:** all office agents currently run as the
**same OS user**, and agent reads under `~/.isomux` are explicitly allowed by
`safety-hooks.ts` (authenticated members have shell-equivalent access per
`docs/access-and-invites.md`). So a capable or misbehaving agent can
`grep ~/.isomux/memory/bosses/` and read boss memory directly. Therefore:

- **"Private" means: not auto-injected into other contexts, and never returned by
  the REST read path to the wrong caller.** It is NOT confidential from
  same-OS-user code (raw shell, Codex, a misbehaving agent) until per-user /
  bwrap isolation exists. That OS-level boundary is separate, future work.
- **Do not teach agents the boss-memory filesystem path in the system prompt.**
  The "How to" affordance exposes boss-private reads only through the scoped REST
  endpoint, never as a path. Reduces casual leakage; does not make it
  confidential.
- *Optional hardening (future):* place boss memory outside the broad `~/.isomux`
  read-allowed tree so a future app-layer hook can deny casual reads. Still will
  not protect against raw same-user shell without OS isolation.

Net: the scope model is an **honest-path / API + auto-injection boundary**, not a
security boundary. Real confidentiality waits on the per-user isolation work.

## 3. Reads

Two paths, by design.

**1. Auto-load on session start (guaranteed recall), under hard budgets.** The
always-relevant scopes (`office.md` + this room's file + this boss's file + this
agent's file) are injected at session start, so the agent always sees its memory
without a per-turn extractor. But auto-load must NOT become an append-only policy
log that recreates the per-turn cost and context-bloat we moved off:

- Each scope file has two sections, `## Pinned` and `## Facts`. **Only `Pinned`
  plus the most-recent N `Facts` are auto-injected**; the full file stays
  grep-able. A `## Proposed` section (agent contributions awaiting boss
  promotion, section 4) is **never auto-injected as authority** -- enforced in
  code, not just by convention, since the file can be hand-edited.
- **Hard per-scope budget** (bytes/tokens), with `office` and `room` budgets
  *smaller* than `boss`/`agent` (they affect more people). Exact numbers chosen
  before implementation (open Q2).
- Over budget degrades **deterministically and visibly** (newest + pinned win;
  drop oldest non-pinned, and note it).

**2. On-demand (the long tail).** For deeper or cross-scope facts: at small scale
"read the whole scoped file" suffices; `grep` is the scaling step. **Boss-scope
reads go through the scoped REST endpoint** (not raw grep, see section 2). For
office/room/agent, raw grep is allowed as a *convenience, not a policy boundary*,
and is documented as such. (Open Q1: routing *all* reads through REST is the
cleaner single-enforcement option, at an ergonomic cost.)

## 4. Writes (REST, agent-authored) and write authority

Agents write **via REST**, never by editing files directly, so every write is
scoped, validated, audited, provenance-stamped, and ID-tagged (section 1).
Consistent with the full-power-REST commitment.

**Design principle (justifies the authority model):** memory is **prompt
material** -- the auto-loaded office/room facts become injected *authority* in
every future session. So write access to a shared scope is effectively the power
to mutate prompt policy. A noisy or compromised agent that can append to
`office.md` poisons every future session. Write authority must therefore be
tighter than read access.

**Write-authority model (v1):**

| Scope | Who may write |
|---|---|
| `agent` (own file) | the agent itself, directly |
| `boss` | scoped to that boss; only on **current-boss origin or explicit confirmation** (no silent agent writes of boss-private facts) |
| `room` | a boss with access to that room, or owner; **agents submit proposals** |
| `office` | office owners; **agents submit proposals** |

**No open office/room writes in v1.** Agent contributions to shared scopes go
through **agent-proposes / boss-confirms**: either a lightweight `## Proposed`
queue in the scope file that a boss promotes to `## Facts`, or (simplest v1) the
agent surfaces the proposed fact to the boss and the boss writes it. Exact
heaviness is open decision Q3.

Endpoint sketch:

- `POST /memory` `{ scope, scopeId?, factType, text }` -> appends an ID-tagged,
  provenance-stamped line to the correct file (or to `## Proposed` for an agent
  contributing to a shared scope). Server assigns id + author + date and enforces
  the authority table above. **Authority is derived from the authenticated
  caller / session / agent context, never from request-body fields** -- `author`,
  `scopeId`, `userId`, `boss` are server-assigned or rejected, not trusted from
  the body (especially for `boss` writes and room access).
- `GET /memory?scope=...&q=...` -> scoped read/search (the privacy-safe read path
  for the `boss` scope).
- `PATCH /memory/<id>` / `DELETE /memory/<id>` -> update / retract via supersede
  or tombstone (section 1), targeting the stable id.

**Write-time dedup guard:** the `POST` handler does a cheap exact/fuzzy match
against existing lines in the same scope and rejects or merges an obvious
restatement. Necessary but **not sufficient** alone; the stable ids +
supersede/tombstone semantics (section 1) are what make update/retract and later
cleanup safe under near-duplicate lines.

## 5. System-prompt affordance ("How to use memory")

A block in the assembled system prompt, alongside the existing task-board /
file-sharing / agent-messaging affordances. It tells agents: what memory is, the
scopes and what each is for, **when to read** (auto-loaded at start; grep/read
non-private scopes for more, boss scope via the REST endpoint), **when to write**
(the durability gate + the fact taxonomy + the authority model), and the exact
REST calls. It does **not** expose the boss-memory filesystem path (section 2).

## 6. Optional cleanup (recommended-light, deferred)

Without any cleanup, two slow leaks (both low-volume here because writes are
agent-gated, but neither self-heals):

- **Near-duplicate restatements** (mitigated at write time by section 4's guard +
  stable ids).
- **Staleness** (a fact becomes wrong and nobody retracts it).

Mitigation, deferrable: a periodic pass (could be a cron agent) that dedups and
asks "still true?" of old facts, retracting/superseding stale ones via the stable
ids. Manual / proposal-based cleanup first; cron later. The `[author, date]` +
`mem:id` + supersede format is designed so cleanup can run safely whenever it
lands. Staleness is the known, consciously-deferred cost.

## 7. Future: RAG (strictly optional, additive)

If a scope's file grows large enough that "read whole / grep" stops scaling, add
optional vector retrieval **over the same markdown files**. The files remain the
source of truth; RAG is an index on top, never a replacement. Not needed for v1.

## 8. What carries over / what's dropped from the prior spec

- **Carried:** the motivation (durable cross-agent memory), the four-scope
  structure (agent/boss/room/office), the (now reframed) scope model.
- **Dropped:** per-turn LLM extraction, the Qdrant vector store, ADD/UPDATE/NONE
  reconciliation, the extraction-prompt spec, the categorizer eval set, the
  sparsity/semantics machinery. All obsolete under the FS-based model.

## 9. Migration

`isomux-mem0` is being retired (the `enabledPlugins` entry is removed in
`office-config.json`; takes effect on next server restart). **No migration** of
the 8,603-fact corpus, confirmed low-value for our use case. Fresh start with
empty markdown files. The old Qdrant collections stay on disk (harmless,
reversible) until explicitly dropped.

## 10. Open questions / decisions

The direction is settled; the residual product/impl choices:

1. **Read path (Q1):** keep raw `grep` for non-private scopes as a documented
   convenience, or route *all* reads through REST for one enforcement surface?
   Boss-scope reads go through REST either way.
2. **Auto-load budget (Q2):** pick the hard per-scope byte/token caps before
   implementation (office/room < boss/agent). Numbers TBD.
3. **Write-authority heaviness (Q3):** `## Proposed` queue in-file vs. the
   simplest "agent surfaces the fact, boss writes it." Both enforce
   no-open-shared-writes; the question is UX weight.
4. **Cleanup trigger (Q4):** manual/proposal-based first, cron later. Deferred,
   but the line format (stable ids + supersede) is built so cleanup can run
   safely whenever it lands.
