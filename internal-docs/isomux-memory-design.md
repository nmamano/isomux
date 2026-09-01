# isomux-memory: design

> **STATUS: IMPLEMENTED** (three-verb raw model). An earlier id-based design
> (append-only `supersede`/`tombstone` lines + fuzzy dedup + per-surface curation
> routes) was built and then replaced, before shipping, with a simpler raw model
> at Nil's call. What shipped:
>
> - Per-scope plain-markdown files of `- {Creator}, {date}: {text}` lines - **no
>   ids, no supersede/tombstone grammar**. One exception, added later by task
>   f9d2bbac: an agent APPENDing to its OWN agent scope writes
>   `- {date}: {text}`, because there the Creator names the reader and burns
>   cap + prompt space for nothing. Both shapes parse; nothing rewrites
>   existing lines.
> - **Three REST verbs on `/api/memory`:** READ (whole file + a sha256 `version`),
>   APPEND (one server-stamped line, text capped at 400 characters, with an
>   exact-duplicate guard and post-write size/cap), REPLACE
>   (whole-file overwrite guarded by the `version` from READ - 409 on mismatch).
> - Every mutation is recorded to an append-only **op-log** (`memory/.oplog.jsonl`,
>   full post-op snapshot) for manual recovery.
> - **Per-scope size caps** refuse growth over budget and keep auto-load complete.
> - **Authority is permissive on every verb** (any authenticated caller may
>   read/append/replace any existing target); `date` is server-stamped on APPEND,
>   as is `author` except on the self-note case above. The only structural boundary is that a boss's memory auto-loads
>   solely into that boss's own agents' prompts.
> - **Humans curate through the same READ/REPLACE verbs** from each scope's
>   settings field (a shared `useMemoryEditor` hook).
>
> The sections below give the model and the reasoning. The motivation (why files,
> why shared scope, the trust boundary, the affordance) is unchanged; the
> mechanics were simplified as summarized above.

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
  .oplog.jsonl               # append-only audit/recovery log of every mutation
```

Each scope file is a **flat list** of facts, one per line, raw and unstructured:

```
- {Creator}, {YYYY-MM-DD}: {self-contained fact}
- {YYYY-MM-DD}: {self-contained fact}            # an agent's note to ITSELF
```

That shape is the **APPEND convention, not an enforced grammar**: APPEND writes it,
but a REPLACE may write arbitrary raw text, and any non-empty line is treated as a
memory. There are **no ids and no supersede/tombstone grammar**. One fact per line
keeps the files greppable, `git`-diffable, and human-editable, and keeps an APPEND
append-safe. Editing or retracting a fact is a **whole-file REPLACE** (read the
file, change the text, write it back), guarded by an optimistic `version` so two
concurrent edits cannot silently clobber each other (section 4).

**Provenance.** An APPEND stamps the date from the authenticated caller (never
the request body), and the `Creator` too - unless the caller IS the agent whose
scope it is, which writes the second shape above (task f9d2bbac). The op-log
`actor` names the caller on every op, self-notes included, so dropping the
in-file Creator loses no attribution. A REPLACE writes the file bytes **verbatim**, so
after a human or agent hand-edit the in-file `Creator`/date are display text only - 
the **op-log** is the authoritative record of who changed what and when.

### What to record (task-agnostic guidance)

A small fixed list of _kinds_ of durable fact - guidance for the affordance, not an
enforced schema (no `factType` is persisted):

| Kind                     | Example                              | Natural scope |
| ------------------------ | ------------------------------------ | ------------- |
| preference               | "no em dashes in prose"              | boss          |
| convention               | "this room uses Bun"                 | room          |
| rule / prohibition       | "never touch the 8788 daemon"        | room/office   |
| environment / infra fact | "context composer runs on port 3456" | office        |
| role                     | "Isomuxer4 pairs with Reviewer4"     | agent         |
| contact / external       | "DNS for chess: A 66.241.124.181"    | boss/office   |

The durability gate is **behavioral, not typed**: write lasting facts about
people/projects/environment/rules; do NOT write work-in-progress (the session
transcript already holds that).

## 2. Scope model and trust boundary (same-user reality)

Four scopes, but **boss scope is "context-scoped for auto-load," NOT a
confidentiality guarantee or a REST-private read**:

- `office`, `room`, `agent` are cross-boss visible by scope.
- `bosses/<userId>.md` is structurally scoped only at **auto-load** time (below),
  not over REST.

**Permissive authority model.** All office agents currently run as the **same OS
user**, and agent reads under `~/.isomux` are explicitly allowed by
`safety-hooks.ts`, so a capable agent can `grep` the memory files directly
regardless. Rather than pretend otherwise, the REST surface is openly permissive
and restraint lives in the system-prompt affordance:

- **Every verb (READ / APPEND / REPLACE) is authenticated + target-EXISTENCE
  gated, open to any authenticated caller** (agent token or user cookie) for any
  existing scope/target, including any boss and including the destructive REPLACE.
  There is no per-scope / per-room / per-boss access gate. `author` + `date` are
  server-stamped on APPEND from the caller's identity; body values are ignored.
  (`author` is omitted from the line - not taken from the body - when an agent
  appends to its own agent scope; see Provenance above.)
- **The one structural boss property is in AUTO-LOAD, not REST:** a boss's notes
  are auto-injected only into that boss's own agents' prompts (keyed on the
  agent's stable manager `userId`), so one boss's notes never bleed into another
  boss's context. This is context-scoping, not a read boundary.
- **Do not teach agents the boss-memory filesystem path in the system prompt.**
  Reduces casual leakage; does not make it confidential.

**On permissive REPLACE specifically (a deliberate product/security decision).**
REPLACE is a whole-file destructive primitive, so making it permissive means any
authenticated agent can rewrite office memory (which auto-injects into every
agent), any nameable room, or another boss's file. Nil chose this knowingly: the
risk class is handled in the affordance ("Do not make big changes to it"), and
the **op-log is the recovery net - not an authorization boundary**.
This is pinned by a test asserting a plain agent token _can_ REPLACE office memory,
so it is not silently re-gated later.

Net: the scope model is an **honest-path / API + auto-injection boundary**, not a
security boundary. Real confidentiality waits on the per-user isolation work.

## 3. Reads

Two paths, by design.

**1. Auto-load at session start (guaranteed recall).** The always-relevant scopes
(`office.md` + this room's file + this boss's file + this agent's file) are
injected at session start, so the agent always sees its memory without a per-turn
extractor. Cron jobs (which have no room/agent/boss identity of their own)
auto-load **office memory only**; the boss-memory boundary stays "that boss's own
agents," not their cron jobs.

Injected as a **distinct, provenance-labeled layer, separate from the
authoritative prompts** (after the office/room/agent _prompts_). Human-authored
prompts are _policy_; agent-authored memory is _shared context and observations_,
attributed. This separation shrinks the blast radius of a bad agent write from
"injects a false rule everyone obeys" to "adds an attributed, weighable note to a
shared pool."

**Each scope has a hard maximum injected size** (`MEMORY_CAPS`: office 2500 / room
10000 / agent 5000 / boss 5000 chars). APPEND refuses a write that would exceed
the scope cap. REPLACE refuses growth over the cap, but remains raw-in-raw-out and
allows an over-cap legacy file to shrink. Legacy over-cap scopes still load in
full and refuse further APPENDs. The REST READ is uncapped and reports the current
injected size and cap.

**2. On-demand (the long tail).** The REST **READ** (`GET /api/memory`) returns the
**whole raw file plus its `version`**, for any scope (including boss) for any
authenticated caller - boss reads are NOT caller-scoped over REST (section 2). READ
is also the first half of the read-modify-REPLACE edit flow. Raw `grep` over the
files remains a documented _convenience, not a policy boundary_.

## 4. Writes

Three verbs, two writers.

### The three verbs

- **`GET /api/memory?scope=&scopeId=`** (READ) → `{ text, version, size, cap }`: the
  verbatim file, an optimistic-concurrency `version` (short sha256 of the file
  bytes; a missing file hashes `""` to a fixed sentinel), and the current injected
  size and cap.
- **`POST /api/memory` `{ scope, scopeId?, text }`** (APPEND) →
  `{ item, version, size, cap }`:
  the safe default. Appends one `- {Creator}, {date}: {text}` line - or
  `- {date}: {text}` when an agent writes to its own agent scope; server stamps
  `date`, and `Creator` in every other case; validates the text is a single non-blank line; runs the
  exact-duplicate guard. Text over 400 characters is rejected 422 with guidance
  to keep detail in a doc or task record and save a pointer. **A normalized-exact
  restatement already in the scope is rejected 409** (naming the matched text); a
  genuine reword is allowed through. A write that would exceed the scope cap is
  rejected 422 with guidance to trim that scope, never widen it. A successful
  response exposes the post-write injected size and cap. If raw REPLACE content
  does not end with a newline, APPEND first writes the missing separator; the
  injected size counts that separator between the two non-empty lines.
- **`PUT /api/memory` `{ scope, scopeId?, text, version }`** (REPLACE) →
  `{ version }`: overwrites the whole file with `text` **verbatim** (raw means raw - 
  no grammar, no stamping). If `version` no longer matches the current file
  (someone else wrote in between), it is a **409 conflict** carrying the current
  version, and nothing is written - the caller re-READs and retries.

`PATCH`/`DELETE`-by-id are gone; editing and retracting are read-modify-REPLACE.

### Agents write via REST

Agents write **via REST**, never by editing files directly (the safety hooks block
agent writes under `~/.isomux`). Agents may touch **all four scopes** with **no
proposal queue or boss promotion step** - shared writes are the point. Discretion,
not a gate, governs when an agent writes versus asks the boss first (section 6):
the wider the scope, the more it should consult the boss. The non-ceremony safety
measures are:

1. **Memory is injected as notes, not policy** (section 3) - bad lines are
   attributed and weighable, not obeyed.
2. **A system-prompt affordance that encodes restraint** (section 6) - it defines
   memory as a trigger, defaults to not writing, requires the narrowest scope,
   and tells agents not to make big changes to office memory.
3. **An exact-duplicate guard on APPEND** - a cheap normalized-exact match rejects
   an obvious restatement (an over-eager agent re-stating the same fact and slowly
   polluting a shared scope). No fuzzy matching: a genuine reword is allowed.
4. **A version guard on REPLACE** - optimistic concurrency turns a concurrent
   overwrite into a clean 409 retry instead of a lost update.
5. **The op-log** - every mutation is snapshotted, so a bad write is recoverable.

**Authority is derived from the authenticated caller**, never from request-body
fields. `author`/`date` are server-assigned on APPEND. `scopeId` is a
caller-supplied **target selector** (validated for shape + existence), not an
authority claim.

| Write/read target | Accepted from            | Target resolution                                                                                                  |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `agents/<id>.md`  | any authenticated caller | omitted `scopeId` defaults to the caller's own agent (agent token); a user must pass an explicit, existing agent id |
| `rooms/<id>.md`   | any authenticated caller | `scopeId` required; must be an existing room                                                                       |
| `office.md`       | any authenticated caller | no `scopeId`                                                                                                       |
| `bosses/<id>.md`  | any authenticated caller | omitted `scopeId` defaults to the caller's own/manager `userId`; or an explicit, existing user id (any boss)        |

### Humans write/curate via the settings menu

Humans edit memory the same place they edit each scope's prompt: **each scope's
settings menu has a memory field** next to its prompt field.

| Scope  | Settings surface (existing)              | Field         |
| ------ | ---------------------------------------- | ------------- |
| office | office prompt modal                      | office memory |
| room   | room settings modal                      | room memory   |
| agent  | edit-agent dialog                        | agent memory  |
| boss   | user management (next to `memberPrompt`) | boss memory   |

The field uses the **same READ/REPLACE verbs** as agents (a shared
`useMemoryEditor` hook): on open it READs `{ text, version }`; on save it PUTs the
edited text with that `version`, and a 409 conflict surfaces as a "reopen to edit
the latest" message without closing the dialog. The textarea shows the **raw file**
and writes it back verbatim - there is no id self-healing or special handling of
removed lines; what you see is what is saved. Memory saves run **separately** from
the surrounding settings save (prompt/name/etc.), so they don't entangle.

This keeps human curation transparent and located exactly where you look for it,
and closes the loop on shared-scope safety: junk an agent appended to office memory
is visible and deletable right next to the office prompt (section 7).

## 5. Why the human path is the settings field

The four memory scopes mirror the four system-prompt surfaces the human already
owns (office prompt, room prompt, agent custom instructions, `memberPrompt`). A
_human-authored_ fact that should be authoritative belongs in the prompt; a
_human-curated_ memory line belongs in the settings memory field. The field is a
thin client of the same permissive `/api/memory` READ/REPLACE verbs agents use - 
no separate human write API, no parallel copy of the prompt-editing UI.

## 6. System-prompt affordance ("How to use memory")

A block in the assembled system prompt, alongside the task-board / file-sharing /
agent-messaging affordances. It is **both** the how-to manual and the restraint
guardrail. It tells agents:

- **What memory is:** a one-line trigger that changes what an agent does before it
  reads anything. Detail stays in a doc or task record and memory stores a pointer.
- **The write bar:** default to not writing. Write only when the next agent would
  get it wrong without the line and could not find it by looking. Write the rule,
  not the incident story.
- **Scope and cap guidance:** choose the narrowest scope that reaches every agent
  that must act on the fact. When a scope is full, trim the agent's own lines,
  propose the rest to a boss, or drop the note; never widen it. Office memory is
  only for facts that change how agents act there, and agents do not make big
  changes to it.
- **The three operations:** APPEND by default (safe; server-stamped; 409 on a
  normalized-exact duplicate; 422 over the 400-character text limit or scope
  cap); EDIT or REMOVE is routine in the agent's own scope. In a shared scope,
  agents fix their own line and propose other changes to a boss. Unrelated lines
  stay byte-identical; a stale REPLACE returns 409, so re-READ and retry.
- **The boss caveat:** boss memory is auto-loaded only for that boss's agents; it
  is not a confidentiality boundary.

It does **not** expose the boss-memory filesystem path (section 2).

**Honest caveat:** prompt-based restraint shapes a well-behaved model - a behavior
nudge, not a boundary. The non-prompt guardrails are the exact-duplicate guard, the
version guard, and the op-log (section 4).

## 7. Cleanup and recovery

Cleanup is **routine curation**: agents trim their own scope and propose shared
scope trims to a boss; humans prune in the settings memory field (a REPLACE).
The slow leaks are duplicate restatements
(mitigated at write time by the exact-normalized guard; rewords are allowed) and staleness (a fact goes
wrong and nobody retracts it) - staleness is the known, consciously-deferred cost;
a periodic cron agent that dedups and asks "still true?" can come later.

**Recovery is the op-log.** `memory/.oplog.jsonl` records every successful APPEND
and REPLACE as `{ ts, actor, scope, scopeId, op, text, content, version,
previousVersion? }`, where `content` is the **full file after the op**. Restoring a
botched write is therefore just re-REPLACEing an earlier `content` snapshot. v1
recovery is manual (read the log, re-PUT a snapshot); a restore endpoint/UI can
come later.

## 7b. Backend-native memory is switched off per launch

isomux memory is the only memory an office agent has, so memories carry over
when an agent's backend changes (Nil, 2026-09-01). Each backend's own memory is
therefore switched off on every launch, in the backend adapter, never in a
file the operator has to remember:

- **Claude** (`server/backends/claude.ts`, `CLAUDE_MEMORY_OFF_SETTINGS`): the
  SDK's typed `settings: { autoMemoryEnabled: false }` on every session,
  resume and one-shot query. It lands in the flag-settings layer, which
  outranks `~/.claude/settings.json`. The env var
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is not used: the SDK's `env` option
  replaces the child environment rather than merging it, and the variable is
  truthiness-parsed. Escape hatch: an operator envFile that sets
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` to an explicitly falsy value (`0`,
  `false`) is checked by the CLI before settings and turns auto-memory back
  on. Do not set it.
- **Codex** (`server/backends/codex/adapter.ts`, `CODEX_THREAD_CONFIG_OVERRIDES`):
  `memories.use_memories = false` and `memories.generate_memories = false` in
  the per-thread `config` map on every `thread/start` and `thread/resume`.
  Per-thread beats editing `config.toml` under `CODEX_HOME`: no shared-file
  mutation, and it holds for a per-user `CODEX_HOME` too. Codex rejects a
  non-boolean but ignores an unknown key silently, so the adapter test pins
  the spelling.
- **OpenCode**: no native memory feature in the vendored binary (1.18.23);
  nothing to switch.

## 8. Future / deferred machinery

Deferred. Add only if real scale demands:

- **Boss-curated pinning.** If a scope routinely exceeds its cap, let a boss-pinned
  subset always survive truncation instead of pure newest-first.
- **Proposal / promotion queue.** If open shared writes prove too noisy and the
  exact-duplicate guard plus lazy pruning are not enough, add an agent-proposes /
  boss-confirms queue for office and room scopes.
- **Vector / RAG over the same markdown files.** If "read whole / grep" stops
  scaling, add a vector index on top; the files stay the source of truth.
- **A restore endpoint/UI over the op-log.** v1 restore is manual.

## 9. Decisions (as shipped)

- **Raw, unstructured `- {Creator}, {date}: {text}` lines**, and
  `- {date}: {text}` for an agent's note to its own scope. No ids, no
  supersede/tombstone, no persisted `factType`. Editing/retracting is whole-file
  REPLACE.
- **Three verbs on `/api/memory`:** READ (text + version + size/cap), APPEND
  (server-stamped, 400-character text limit, exact-dup 409, hard-cap 422,
  post-write size/cap), REPLACE (verbatim, version-guarded 409).
- **Permissive on every verb** (any authenticated caller, target-existence gated),
  including the destructive REPLACE of office memory - restraint via the affordance,
  recovery via the op-log; pinned by a test.
- **Boss boundary is auto-load only** (a boss's notes auto-inject solely into that
  boss's own agents' prompts), not a REST-read restriction.
- **APPEND dedup is exact-normalized only** (no fuzzy/Jaccard); a reword is allowed.
- **Optimistic concurrency via a short sha256 `version`**; the synchronous
  read-modify-write within one store call is serialized by the single-threaded
  event loop, and the cross-request edit flow is guarded by the version.
- **Per-scope hard injected-size caps** (office 2500 / room 10000 / agent 5000 /
  boss 5000); APPEND cannot exceed them, REPLACE can shrink a legacy over-cap
  scope, auto-load remains complete, and READ remains uncapped.
- **Humans curate via each scope's settings field**, a thin client of the same
  READ/REPLACE verbs (`useMemoryEditor`); raw in, raw out.
- **Every mutation is op-logged** with a full post-op snapshot for manual recovery.
