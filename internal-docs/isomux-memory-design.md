# isomux-memory: design

> **STATUS: IMPLEMENTED** (slices 3a–3i, plan `plans/isomux-memory-loop.md`).
> Shipped with Nil's simplified permissive authority model (§2/§4): any
> authenticated caller may read/write any scope and any existing target; the
> structural boundaries that remain are (1) server-stamped provenance and
> (2) boss memory auto-loading only into that boss's own agents' prompts (it is
> NOT REST-read-private). Edit/retract is append-only (supersede/tombstone);
> there is a write-time dedup guard; per-scope size caps degrade newest-first with
> a trim notice. Humans curate raw markdown in each scope's settings field
> (office/room/agent/user) via owner/surface-gated raw routes; the verbatim raw
> read is per-surface permission-inheriting, NOT the general permissive
> `/api/memory` surface. Deferred (§8) and the Playwright UI smoke remain future
> work. Sections below are the original design; where they predate the permissive
> simplification, §2/§3/§4/§9 were updated to match the shipped behavior.

Memory is filesystem-based, not a vector store. The obvious alternative is to wrap
a vector memory engine (e.g. mem0 in OSS mode) that runs a per-turn LLM
extract-and-reconcile pass (ADD / UPDATE / DELETE / NONE) into Qdrant and retrieves
by vector similarity. Three reasons rule that out for our use case:

- **Default extraction over-captures for our domain.** A general extraction prompt
  tuned to capture every memorable fact fits a personal-assistant domain. For
  engineering agents with long turns, "memorable" sweeps in transient work-state,
  so the store balloons with ephemeral facts.
- **Per-turn cost.** A per-turn extract-and-reconcile LLM call does not fit a
  write-when-you-learn-something / read-once-per-session pattern. At our turn
  volume it is too slow (~10s of turn-boundary latency) and too expensive.
- **Opacity.** A vector store is not meant to be read or edited by hand. We want
  memory the boss can open, grep, and curate directly. Plain files plus grep are
  enough to start; vector retrieval can come later over the same files (section 8).

**The key insight** (schema-grounded memory): the facts worth keeping are not
about the _task_; they are about _people, projects, environment, and rules_,
which have a small, stable shape regardless of what agents are working on. isomux
is a **general meta-harness**, so we cannot schema the task. But we **can** schema
the one thing that is always constant: the **office / room / boss / agent**
structure.

**Why shared scope is the whole point.** Claude's built-in memory already gives each repo its own durable file. If isomux memory were agent-only, it would be a
worse reimplementation of something that already ships. The novel capability is
**cross-agent**: a fact one agent learns becomes visible to the other agents in
its room or office. Room- and office-wide memory is therefore the reason this
feature exists, not an optional extra.

## 1. Model

Memory is **plain markdown files on disk**. The directory tree _is_ the schema.

```
~/.isomux/memory/
  office.md                  # office-wide, visible to everyone
  rooms/<roomId>.md          # a room/project, visible to anyone in that room
  agents/<agentId>.md        # an agent's standing facts, visible with that agent
  bosses/<userId>.md         # a single boss's scoped facts
```

Each file is a **flat list** of facts: no sections, no headers, just lines.
Deferred refinements (pinning, proposal queues) are in section 8.

Each fact is **one provenance-stamped, ID-tagged markdown line**:

```
- <!-- mem:ab12cd --> [<author>, <YYYY-MM-DD>] <self-contained fact>
```

The leading `<!-- mem:ID -->` is a stable, immutable id (renders invisibly in
markdown) so update/retract can target an exact line even amid near-duplicates and
concurrent appends. Retraction is a **tombstone or supersede line**
(`supersedes:ab12cd`), never an in-place rewrite, so append provenance survives
edits. One-fact-per-line keeps concurrent writes append-safe, greppable,
`git`-diffable, and human-editable.

These ids are cheap and worth keeping: they are what make later dedup and cleanup
(section 7) safe under near-duplicate lines.

### Fact taxonomy (task-agnostic — the only "schema" you pre-define)

A small fixed list of _kinds_ of durable fact. A gate, not a typed schema:

| Type                     | Example                              | Natural scope |
| ------------------------ | ------------------------------------ | ------------- |
| preference               | "no em dashes in prose"              | boss          |
| convention               | "this room uses Bun"                 | room          |
| rule / prohibition       | "never touch the 8788 daemon"        | room/office   |
| environment / infra fact | "context composer runs on port 3456" | office        |
| role                     | "Isomuxer4 pairs with Reviewer4"     | agent         |
| contact / external       | "DNS for chess: A 66.241.124.181"    | boss/office   |

The durability gate: **write lasting facts about people/projects/environment/
rules; do NOT write work-in-progress** (the session transcript already holds
that). Working-state fits no type, so it never enters memory.

## 2. Scope model and trust boundary (same-user reality)

Four scopes, but **boss scope is "context-scoped for auto-load," NOT a
confidentiality guarantee or a REST-private read**:

- `office`, `room`, `agent` are cross-boss visible by scope.
- `bosses/<userId>.md` is structurally scoped only at **auto-load** time (below),
  not over REST.

**Implemented authority model (permissive — the simplification of the original
restrictive table).** All office agents currently run as the **same OS user**, and
agent reads under `~/.isomux` are explicitly allowed by `safety-hooks.ts`, so a
capable agent can `grep` the memory files directly regardless. Rather than pretend
otherwise, the REST surface is openly permissive and restraint lives in the
system-prompt affordance:

- **REST reads and writes are authenticated + target-EXISTENCE gated, open to any
  authenticated caller** (agent token or user cookie) for any existing
  scope/target, including any boss. There is no per-scope / per-room / per-boss
  access gate. `author`, `date`, and `id` are always server-stamped from the
  caller's identity; the body's values are ignored.
- **The one structural boss property is in AUTO-LOAD, not REST:** a boss's notes
  are auto-injected only into that boss's own agents' prompts (keyed on the
  agent's stable manager `userId`), so one boss's notes never bleed into another
  boss's context. This is context-scoping, not a read boundary — any authenticated
  caller can still `GET` any boss file.
- **Do not teach agents the boss-memory filesystem path in the system prompt.**
  Reduces casual leakage; does not make it confidential.

Net: the scope model is an **honest-path / API + auto-injection boundary**, not a
security boundary. Real confidentiality waits on the per-user isolation work.

## 3. Reads

Two paths, by design.

**1. Auto-load at session start (guaranteed recall).** The always-relevant scopes
(`office.md` + this room's file + this boss's file + this agent's file) are
injected at session start, so the agent always sees its memory without a per-turn
extractor.

Injected as a **distinct, provenance-labeled layer, separate from the
authoritative prompts** (section 6 of the system prompt, after the office/room/
agent _prompts_). The framing matters: human-authored prompts are _policy_;
agent-authored memory is _shared context and observations_, attributed to whoever
wrote each line. This separation is what shrinks the blast radius of a bad agent
write from "injects a false rule everyone obeys" to "adds an attributed, weighable
note to a shared pool."

**Each scope has a maximum injected size.** When a scope's memory fits, the whole
file loads. When it exceeds the cap, auto-load includes what fits (newest first)
and appends a line to the system prompt: _"Not all memories fit. Consider
suggesting the boss to trim them."_ Degradation is therefore deterministic and
visible, and it nudges curation. Office/room caps should be smaller than boss/agent
(they affect more people); exact numbers are a residual choice (section 9).

**2. On-demand (the long tail).** For deeper or cross-scope facts: at small scale
"read the whole file" suffices; `grep` is the scaling step. The REST `GET` reads
**any** scope (including boss) for any authenticated caller — boss reads are NOT
caller-scoped over REST (see section 2); the only boss boundary is auto-load. Raw
`grep` over the files is a documented _convenience, not a policy boundary_.

## 4. Writes

Two writers, two paths.

### Agents write via REST

Agents write **via REST**, never by editing files directly (the safety hooks block
agent writes under `~/.isomux`), so every agent write is scoped, validated,
audited, provenance-stamped, and id-tagged.

Agents may append to **all four scopes** via REST, with **no proposal queue or
boss promotion step.** Shared writes are the point of the feature; gating them
behind human approval would kill it. Discretion, not a gate, governs when an agent
writes versus asks the boss first (section 6): the wider the scope, the more it
should consult the boss. Safety otherwise comes from three cheap, non-ceremony
measures:

1. **Memory is injected as notes, not policy** (section 3) — bad lines are
   attributed and weighable, not obeyed.
2. **A system-prompt affordance that encodes restraint** (section 6) — especially
   for `office`, framed by blast radius.
3. **A write-time dedup guard** — the `POST` handler does a cheap exact/fuzzy
   match against existing lines in the same scope and rejects or merges an obvious
   restatement. This catches the realistic failure mode (an over-eager agent
   re-stating slight variants of the same fact and slowly polluting a shared
   scope), which is noise, not malice.

Writes are **permissive**: any authenticated caller (agent token or user cookie)
may write any scope and any existing target — there is no per-scope / per-room /
per-boss access gate (the original restrictive table was simplified away). The
only checks are target-EXISTENCE and a strict-identifier guard on `scopeId`.
Restraint is the system-prompt affordance, not a gate; boss facts are sensitive,
so the affordance tells agents to use discretion (section 6).

**Authority is derived from the authenticated caller**, never from request-body
fields. `authenticate()` already yields an `Identity` (agent token →
`scope:"agent"` + `agentId`/`userId`; cookie → `scope:"user"` + `userId`/`role`).
`author`, `date`, and `id` are always server-assigned from that identity, never
trusted from the body. `scopeId` is a caller-supplied **target selector**
(validated for shape + existence), not an authority claim.

| Write/read target | Accepted from            | Target resolution                                                                                                  |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `agents/<id>.md`  | any authenticated caller | omitted `scopeId` defaults to the caller's own agent (agent token); a user must pass an explicit, existing agent id |
| `rooms/<id>.md`   | any authenticated caller | `scopeId` required; must be an existing room                                                                       |
| `office.md`       | any authenticated caller | no `scopeId`                                                                                                       |
| `bosses/<id>.md`  | any authenticated caller | omitted `scopeId` defaults to the caller's own/manager `userId`; or an explicit, existing user id (any boss)        |

Endpoint sketch (final path style settled at implementation, aligned with the
route table):

- `POST /api/memory` `{ scope, scopeId?, factType, text }` → appends an id-tagged,
  provenance-stamped line to the correct file. Server assigns id + author + date,
  validates target existence + scopeId shape, runs the dedup guard.
- `GET /api/memory?scope=...&scopeId=...&q=...` → read/search, authenticated +
  target-existence gated for EVERY scope including `boss`; it is not
  caller-private (boss scope is context-scoped at auto-load only, not over REST).
- `PATCH /api/memory/<id>` / `DELETE /api/memory/<id>` → update / retract via
  supersede or tombstone, targeting the stable id.

### Humans write/curate via the settings menu

Humans do **not** need a REST write path or a one-click button: they edit memory
the same place they already edit each scope's prompt. **Each scope's settings menu
gets a memory field next to its prompt field:**

| Scope  | Settings surface (existing)              | New field     |
| ------ | ---------------------------------------- | ------------- |
| office | office prompt modal                      | office memory |
| room   | room settings modal                      | room memory   |
| agent  | edit-agent dialog                        | agent memory  |
| boss   | user management (next to `memberPrompt`) | boss memory   |

This makes human curation transparent and located exactly where you look for it.
It also closes the loop on shared-scope safety: junk an agent appended to office
memory is visible and deletable **right next to the office prompt**, which is what
makes lazy, cleaned-as-noticed pruning (section 7) actually work.

**Field behavior (id self-healing).** The field shows the **raw markdown lines**
(maximally transparent, matches the files-are-the-source-of-truth ethos). On
**save**, the server re-parses the textarea:

- every existing `<!-- mem:ID -->` line keeps its id and provenance;
- any new line the human typed without an id is auto-stamped with a fresh id +
  `[<that user>, <date>]`;
- lines the human removed are deletions.

So a human can freely add / remove / edit lines in plain text and the provenance
machinery self-heals on save. No per-line UI, hand-editing stays first-class.

## 5. Why no human REST write path

The four memory scopes mirror the four system-prompt surfaces the human already
owns (office prompt, room prompt, agent custom instructions, `memberPrompt`). A
_human-authored_ fact that should be authoritative belongs in the prompt; a
_human-curated_ memory line belongs in the settings memory field (section 4). In
neither case does the human need the agent REST endpoints. The REST write path
exists **only because agents cannot touch files** under the safety hooks. Keeping
the human path to "edit the field" avoids building a parallel, redundant copy of
the prompt-editing UI.

## 6. System-prompt affordance ("How to use memory")

A block in the assembled system prompt, alongside the existing task-board /
file-sharing / agent-messaging affordances. It is **both** the how-to manual and
the restraint guardrail. It tells agents:

- **What memory is:** durable facts about people, projects, environment, and rules
  — explicitly contrasted with the session transcript, which already holds
  work-state.
- **The durability gate (the "what"):** write lasting facts, never work-in-
  progress. The fact taxonomy (section 1) as positive examples, plus anti-examples
  ("don't write 'currently debugging the auth test'").
- **Scope guidance (the "where", and where office restraint lives):** write your
  own agent scope freely; write room scope for things the whole project needs;
  write office scope **only** for genuinely office-wide facts, and rarely — framed
  by blast radius (an office line is injected into every agent's every future
  session, so the bar is high).
- **Two ways to record a fact:** write it to memory directly, or ask the boss
  whether it should be saved. Use discretion for which: agent-scope facts you can
  write freely; the wider the scope, the more you should consult the boss before
  writing (office facts almost always warrant a check first).
- **When to write:** the moment you learn a durable fact, not at session end
  (there is no extractor sweeping the transcript).
- **When to read:** relevant memory is auto-loaded at start; use `GET /api/memory`
  or `grep` for longer-tail facts. Boss scope is not REST-private; use discretion
  and do not rely on it as a confidentiality boundary.
- **The exact REST calls.**

It does **not** expose the boss-memory filesystem path (section 2).

**Honest caveat:** prompt-based restraint shapes a well-behaved model (the common
case and the main thing to solve), but it is only as strong as instruction-
following — a behavior nudge, not a boundary. This is consistent with the scope
model already being an honest-path boundary (section 2), so it introduces no new
compromise. The non-prompt guardrail we _do_ keep is the write-time dedup guard
(section 4).

## 7. Cleanup (deferred, lazy)

Without cleanup, two slow leaks (both low-volume here because writes are
agent-gated, but neither self-heals):

- **Near-duplicate restatements** (mitigated at write time by the section 4 guard +
  stable ids).
- **Staleness** (a fact becomes wrong and nobody retracts it).

Cleanup is **lazy and human-driven**: you prune in the settings memory field
when you notice junk (section 4). A periodic cron agent that dedups and asks "still
true?" of old facts can come later. The `[author, date]` + `mem:id` + supersede
format is built so cleanup can run safely whenever it lands. Staleness is the
known, consciously-deferred cost.

## 8. Future / deferred machinery

Deferred. Add only if real scale demands:

- **Boss-curated pinning.** If a scope routinely exceeds its size cap, let a
  boss-pinned subset always survive truncation instead of pure newest-first.
  Pinning is boss-curated only (no agent self-pin). Until then, newest-first
  truncation plus the over-cap notice (section 3) suffices.
- **Proposal / promotion queue.** If open shared writes prove too noisy and the
  dedup guard plus lazy pruning are not enough, add an agent-proposes /
  boss-confirms queue for office and room scopes.
- **Vector / RAG over the same markdown files.** If "read whole / grep" stops
  scaling, add a vector index. The files remain the source of truth; the index
  sits on top, never replacing them.

## 9. Decisions and residual choices

- **Flat list, no in-file sections.** (Pinning/queues → section 8.)
- **Any authenticated caller may read/write all four scopes directly via REST**
  (permissive — the original restrictive per-scope table was simplified away), no
  proposal queue; the only checks are target-existence + scopeId shape; restraint
  via the system prompt + dedup guard; memory injected as notes, not policy.
- **Boss writes target any existing boss** (omitted `scopeId` defaults to the
  caller's own/manager `userId`); `author`/`date`/`id` are server-stamped. The
  boss boundary is **auto-load only** (a boss's notes auto-inject solely into that
  boss's own agents' prompts), not a REST-read restriction.
- **Two write paths for agents:** write directly, or ask the boss to save it;
  discretion scales with scope width (section 6).
- **Humans curate via a memory field in each scope's settings menu** (raw textarea,
  server re-stamps ids on save), not via files or a REST path.
- **Each scope has a maximum injected size**; over-cap loads newest-first and shows
  a trim notice (section 3).
- **Cleanup is lazy / human-driven** in the settings field; cron later.

Residual implementation choices (small, not blocking):

1. **Read path (Q1):** keep raw `grep` over the files as a documented convenience
   alongside the REST `GET` (which serves every scope, including boss, to any
   authenticated caller), or route all reads through REST for one enforcement
   surface? (Decided: keep both — greppability is a stated goal, and there is no
   REST-private scope to protect.)
2. **Office curation authority (Q2):** any office agent may append office facts;
   should _heavy_ curation (bulk edit/retract via the settings field) be
   owner-only, or any room-having user? (Leaning: owner-only for the field;
   appends open to agents.)
3. **Dedup-guard strictness (Q3):** identical threshold across scopes, or stricter
   fuzzy-match on `office` given its blast radius? (Leaning: start identical, tune
   if office gets noisy.)
4. **Cap sizes (Q4):** the maximum injected size per scope (office/room smaller
   than boss/agent). Numbers TBD.
