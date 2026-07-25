# Slide Mode (native)

> Status: implemented (2026-07-24, task 87b575d9). Design v2 after a full design
> interview with Nil (2026-07-19). Author: Isomux Brainstormer.
> Prerequisite task efdabed3 (free the header space) is done.
>
> Implementation notes (as built): sidecar store `server/slide-store.ts`
> (`~/.isomux/state/slides/<agentId>/<rootSessionId>.json`); generation +
> formatter prompt + per-agent queue in `server/slide-mode.ts`; turn splitting
> shared by client and server in `shared/slide-turns.ts`; routes
> `GET /api/agents/:id/slides` and `POST /api/agents/:id/slides/:entryId`
> (opIds agents.getSlides / agents.ensureSlide, office:read) with the
> `slide_ready` room-ACL WS event; deck UI in `ui/log-view/DeckView.tsx` behind a
> header toggle (per-device-per-agent in `ui/device-settings.ts`). The staleness
> guard keys on the conversation's root session id — see the terminal-gate note
> below; it originally reused `topicGenToken`, which was wrong because a benign
> `setTopic` also bumps that.

> Polish v2 (2026-07-24): (1) the deck↔chat toggle now persists the last-viewed
> slide index per-device-per-agent (`getSlidePos`/`setSlidePos` in
> `device-settings.ts`) and restores it on re-entry — following the newest only
> when the viewer was already on the last slide; returning to chat restores the
> prior chat scroll position (or re-pins to the bottom when the viewer was
> following it) instead of jumping to the top. (2) An overfull slide (model
> emits content taller than 720) is no longer clipped: `DeckView`'s `MeasureFrame`
> measures the HTML's natural height in an offscreen `sandbox="allow-same-origin"`
> iframe carrying the same `SLIDE_CSP` (so scripts and network stay blocked; the
> display iframe stays `sandbox=""`), then the whole card is laid out at that
> height and scaled to fit — never clipped, never scrolled.

> Terminal-gate + reconciliation (2026-07-24): a slide is generated for a turn
> ONLY after that turn is terminal, and a stored slide is served only while its
> content digest matches the live turn — otherwise it is regenerated. This
> replaced a client-side "is the turn settled?" guess that recorded a stale
> placeholder when a message was sent from slide view (the newest turn existed
> before the agent went active). The turn's authoritative terminal fact
> (`turn_completed`) lives only on the server, so gating is server-authoritative:
> - The in-flight turn is stamped with its anchor `user_message` entry id
>   (`pendingTurn.anchorEntryId`, set in `addLogEntry` in the same synchronous
>   append — no interleaving, so `buildDeckTurns` never sees the turn with the
>   anchor unset); `resolveSlideJob` reports `terminal = anchorEntryId !== entryId`.
> - `ensureSlide` on a non-terminal turn parks a waiter (keeping the latest
>   feedback) and returns `pending` — never formats a half-streamed answer, never
>   writes a placeholder. `onTurnSettled` runs off the `pendingTurn` promise's
>   settle, so EVERY terminal path (turn_completed, error, stream end/catch,
>   session swap, kill, supersession) drains the waiter: it generates the settled
>   slide and pushes `slide_ready`, so a parked request never orphans (a turn that
>   a `/clear` removed is simply dropped — its deck position is gone too).
> - `SlideRecord.contentDigest` (`slideContentDigest`, a 64-bit hash
>   length-prefixed over prompt + answer + error) is the cache-validity key: a
>   stored slide is served only while its digest equals the live turn's, so a
>   stale placeholder whose turn later gained text no longer matches and is
>   regenerated. `commit` re-checks token AND digest before writing, so a mutation
>   mid-generation is discarded, not broadcast (a terminal turn's content is in
>   fact immutable within its token — every edit forks and bumps the token — so
>   this is defence in depth over the token guard). A record with NO digest
>   predates the field and is unverifiable, so it is regenerated once (a
>   placeholder re-commits with no LLM call; a rendered slide regenerates and
>   gains a digest, then validates from cache). The client mirrors this: it skips
>   a cached record only when it carries a digest (a field-presence check, immune
>   to lagging client logs), and requests missing/digestless ones. Note: this
>   discards any pre-digest ↻-tuned slide once, on first view after the upgrade.
> - Client: no timing predicate. It requests visible turns (re-requesting cached
>   placeholders so the server can reconcile them); the newest in-flight turn
>   shows a "Generating" spinner; a `pending` response for a slide already shown
>   drops it (`slide_invalidate`) so the spinner covers the regeneration.

Per-agent "Slide view": a toggle in the agent header that replaces the chat
view with a slide deck — one slide per assistant turn, ←/→ navigation, the
turn's prompt frozen beneath each slide, and the real input box on the newest
slide. Successor to the external `isomux-slide` plugin
(`~/nil/isomux-slide/`), which proved the pipeline but lives on a separate
port; Nil wants this native because that's what he'll actually use.

## Motivation

The SlideGPT idea (task 87b575d9): chat with a model, consume the answers as
slides. What the plugin proved (keep all of it):

- A second, tool-less model pass ("format this response as ONE slide")
  produces good slides from arbitrary chat responses; the system prompt
  matters more than the model tier.
- One-shot generation on subscription auth — isomux already has the exact
  primitive (`backend.oneShotPrompt`) and the exact usage precedent
  (topic generation, `server/agent-manager.ts` ~line 2044).
- Slides as self-contained inline-styled HTML fragments in a sandboxed
  iframe are safe and portable; 1280×720 design size scaled by CSS
  transform works across screens.
- Fire-and-forget generation with a pending state in the UI is fine UX.

## The core model (decided in interview)

**A slide is a nullable attribute of an assistant turn.** It is null until
someone actually looks at that turn in slide view; generated on demand at
that moment; persisted server-side once generated; shared by all devices and
bosses thereafter.

Consequences, all deliberate:

- **No per-agent `slideMode` setting.** The server holds no toggle. The
  slide-view toggle is client UI state (per-device per-agent, in
  `device-settings`). The server just answers slide requests.
- **Cost is proportional to viewing.** Turns nobody ever views in slide
  view are never formatted. While a client has slide view open, new turns
  generate automatically (exactly like live chat appearing — including
  turns initiated by other agents); the saving is only for turns never
  viewed.
- **Decks persist per conversation, forever.** Old conversations keep their
  decks; in v0 you reach them by `/resume`-ing that session (there is no
  read-only conversation browser today; when one exists, decks come along
  for free).

## Decisions ledger (from the interview)

| # | Question | Decision |
|---|---|---|
| 1 | Which turns get slides? | All of them — the deck mirrors the conversation 1:1 (see #8). Origin/sender filtering rejected. |
| 2 | Formatter input for long agentic turns | Full `assistantText` (it already contains only text spans, no tool calls/results). No truncation except a pathological guardrail (~200k chars). The formatter selects what matters. |
| 3 | Agent needs attention while in deck view | Deck view stays thin: activity indicator + badge; one tap flips to chat view. Deck never re-implements chat machinery. |
| 4 | Generation trigger | On-demand, view-driven (the core model above). Proactive per-turn generation rejected. |
| 5 | Storage | Server-side per-conversation sidecar, keyed by turn anchor (see Data model). "Slides are log entries" rejected — on-demand backfill arrives out of order. |
| 6 | Scrollback eagerness | Generate the focused turn + prefetch its two neighbors; max 2 concurrent generations per agent; dedupe in-flight. No batch "generate whole deck" in v0. Raising the cap to the window's width was considered and rejected (Reviewer1, 2026-07-25): the server gets no focus/prefetch priority metadata, so a wider cap does not actually keep a prefetch from queueing ahead of the focused slide — it just spends another process per viewed agent. If queue latency proves material, the fix is explicit priority or a narrower prefetch window, backed by queue-wait measurements. |
| 7 | Toggle scope | Per-device per-agent in `device-settings`. Header-bar button next to the context-fullness battery (27096236). Prerequisite: task efdabed3 frees the header space (Nil does that task first). |
| 8 | Empty turns (interrupted / failed / tool-only) | 1:1 mapping preserved: they get a **placeholder slide** (showing the error text when the turn failed), with the frozen prompt below. The deck preserves the whole conversation chain. Skipping rejected. |
| 9 | Past conversations | Work via `/resume` in v0; data model supports future read-only browsing. |
| 10 | Style continuity | The formatter receives the **previous turn's cached slide HTML** (when available) + the current turn's content, so it can match the established slide style. If the previous slide isn't cached (user jumped mid-deck), no style reference is passed — we do not force-generate a chain. **Known accepted quirk (Nil, 2026-07-19):** viewing a deck back-to-front (start at the end, scroll backward) yields no coherent style across the deck, since each slide generates without its predecessor. Noted, not acted on unless it becomes an issue in practice. |
| 11 | Bad slides | Per-slide ↻ regenerate button in deck view, with an **optional feedback text field** ("what to change") passed to the formatter as an extra instruction. Overwrites the cached slide. Feedback is one-shot, not persisted. |
| 12 | Mobile | Should ideally work on phone, but **not top priority** (Nil, 2026-07-19). Plugin experience: a fixed 1280×720 slide scaled to fit reads fine in phone landscape (~0.65×) but poorly in portrait (~0.3×, body text ≈6px physical). v0 ships the scaled approach; cheap lever now = formatter prompt enforcing larger minimum text; real fix later = portrait-variant slides and swipe navigation. |

## Data model

Turn anchor: the `user_message` LogEntry id that started the turn (stable,
unique, survives in the per-session log file; exists even when the response
is empty).

Sidecar store, one file per conversation:

```
~/.isomux/state/slides/<agentId>/<rootSessionId>.json
{
  "slides": {
    "<userMessageEntryId>": {
      "html": "<div ...>",          // or null for a placeholder-only record
      "placeholder": false,          // true when the turn had no text output
      "errorText": null,             // turn's error, shown on placeholder
      "promptText": "...",           // frozen prompt (originalText)
      "model": "claude-sonnet-4-6",
      "createdAt": 1784300000000
    }
  }
}
```

Notes:

- NOT log entries: log files stay pure chat; out-of-order backfill never
  touches them. `LogEntry` gains nothing.
- Edit-forks: the log rollback machinery already discards the abandoned
  branch; slide records keyed by discarded entry ids become unreachable
  (harmless orphans; a cleanup sweep can prune keys absent from the log).
- Stale-append guard: generation is fire-and-forget, so a result can land after
  the conversation moved on. Conversation identity is the ROOT SESSION ID —
  captured in `SlideJobContext.rootSessionId` before generating and re-checked
  via `SlideModeDeps.isCurrent` before writing/broadcasting, and part of the
  in-flight key so a re-request after a reset starts a fresh job. `/clear` leaves
  the agent with no root at all and a `/resume` into another thread changes it,
  so both drop; a benign `setTopic` doesn't touch it, so in-flight slide work
  survives a topic rename (which is why `topicGenToken` was wrong).

  Deliberately NOT a separate counter. The root id already exists as the deck's
  storage key, is derived from the sessions map rather than hand-maintained at
  every reset call site, and never recycles — a per-agent counter resets to 0
  when `ManagedAgent` is rebuilt (boot, kill/revive) while the in-flight map
  lives on in the `createSlideMode` closure, so counter values could collide
  across a revive.

  An edit-fork keeps the root and is still safe: `editMessage` replays the
  entries BEFORE the edited one and appends the new text under a NEW entry id,
  so the forked turn's own id stops resolving and its in-flight commit discards;
  earlier turns are replayed unchanged and keep matching digests. Identity is
  only the cheap early-out here — the content digest is what guarantees a stored
  slide is never served for content it wasn't generated from.

## Server

### API

- `GET /api/agents/:id/slides?sessionId=...` — the conversation's slide map
  (for initial deck render).
- `POST /api/agents/:id/slides/:entryId` — "ensure slide": returns cached
  immediately, else starts generation and returns `{status:"pending"}`.
  Body options: `{force: true, feedback: "..."}` for regeneration.
- WS push: `{type:"slide_ready", agentId, sessionId, entryId, slide}` on
  completion, or `{type:"slide_failed", agentId, sessionId, entryId, reason}`
  when the generation failed (both in the ServerMessage union in
  `shared/types.ts`; `reason` is a `SlideFailureReason` code). Every request the
  server accepts resolves with one of these, so the client never has to infer an
  outcome from elapsed time.

Auth: same boss-session auth as the rest of the agent API; anyone who can
read the chat can request its slides.

### Generation

Follow the topic-gen precedent, not a hardcoded Claude call:

- `backend.oneShotPrompt(prompt, {modelFamily, systemPrompt, cwd})` on the
  **agent's own backend** — Claude agents use family `"sonnet"`, Codex
  agents their own family (same rule as topic generation).
- System prompt: port from `isomux-slide/formatter.ts` (tuned: single root
  `<div>`, inline styles only, 1280×720 dark, no scripts, compression
  guidance, avoid decorative Unicode for the iOS emoji problem).
- User prompt: current turn's `originalText` + full `assistantText` +
  (when cached) the previous turn's slide HTML as a style reference +
  (on regen) the user's feedback line.
- Concurrency: per-agent queue, max 2 in flight, in-flight dedupe by
  (sessionId, entryId).
- Failure: journal log (`[slide-mode]`), record stays null, and `slide_failed`
  goes out — the client shows its fallback (the response text on a plain
  template) with regenerate available. Reported only when the turn we generated
  from is still the live one and no rerun is queued behind the failed pass: a
  result discarded because the conversation reset or the content forked is not a
  failure, and a request already being retried isn't terminal yet.
  The wire `reason` is a closed set of codes (`generation_failed`,
  `invalid_output`) — the underlying error is backend/provider exception text or
  raw model output, which is neither a stable contract nor something to
  broadcast to every session in the room. Full detail stays in the journal.
- Timing (measured 2026-07-25, real turns): 17-30s end to end, ~1s of it process
  startup and the rest the model writing 3-6KB of HTML. Anything the deck shows
  while waiting has to be sized for that, which is why the wait is not timed.

## UI

**Toggle.** In the agent header bar next to the context battery (after
efdabed3 clears the space). State in `device-settings`, per agent. Toggling
swaps the LogView chat area for the deck; alternate freely, nothing is lost
either way.

**Deck view.**

- Deck positions = the conversation's assistant turns, in order, 1:1
  (placeholders included). ←/→ keys, buttons, counter; slides scale to fit.
- Prompt bar below: frozen `promptText` on past slides; the real chat input
  on the newest position (wired to the normal send path).
- Entering the view / navigating: for each visible position, call "ensure
  slide" (focused + 2 neighbors). Pending positions show a spinner;
  `slide_ready` fills them live. The server gates the still-running newest turn
  (returns `pending` until it is terminal — see the terminal-gate note above).
- What a position shows is decided by reported state, never by elapsed time: a
  spinner until the server resolves the request, the raw-answer fallback once it
  reports `slide_failed` (or `unavailable`). The deck keeps one timer, and it
  only re-asks for a request the server dropped without reporting anything — it
  never changes what is on screen (task 01a7327a).
- New turn while viewing: new position appears (spinner → slide when the turn
  completes). Auto-advance only if the user was already on the last slide.
- Attention badge: permission prompts, questions, errors → badge on the
  header; tap flips to chat view.
- Per-slide ↻ button → optional feedback input → force-regen.
- Rendering: exclusively `<iframe sandbox="" srcdoc="...">`. Never inject
  slide HTML into the app DOM.

No inline slide cards in the chat view in v0 (dropped in the interview —
deck view is the feature).

## Relationship to the external plugin

The plugin (proactive, separate port/viewer, config-file filtering) keeps
working and remains the plugin-system demo. Once native slide view ships,
remove agents from the plugin's `config.json` to avoid paying for proactive
generation you'll no longer look at. No runtime interlock needed — they
don't share storage.

## Implementation sketch (footprint)

| Area | Files | Est. lines |
|---|---|---|
| Slide store (sidecar read/write, pruning) | `server/slide-store.ts` (new) | ~100 |
| Generation (prompt, queue, token guard, backend dispatch) | `server/slide-mode.ts` (new) | ~150 |
| API routes + WS event | `server/index.ts` or route module, `shared/types.ts` | ~60 |
| Deck view (nav, pending, fallback, regen w/ feedback, attention badge) | `ui/log-view/DeckView.tsx` (new), `LogView.tsx` toggle | ~300 |
| Device-settings entry | `ui/device-settings.ts` | ~10 |
| Tests: ensure-slide idempotence, token guard, placeholder path, regen overwrite | server tests | ~100 |

Rough total: ~700 lines. Prereq task efdabed3 is separate and Nil is taking
it. The plugin's formatter/system prompt and viewer are working references
for the two riskiest parts (prompt quality, deck state machine).

## Latency: measured, and settled (task 6eec740d, 2026-07-25)

Nil, after dogfooding: "an extra latency of 30s in my mind kind of kills the
feature ... it no longer feels like an alternative for any kind of interactive
work." So we measured instead of guessing: 3 reps x 4 cells x the same 6 real
turns (72 timed runs plus a floor probe). Raw data and every rendered slide are
kept at `/home/nil/nil/slide-bench/` (`rows.jsonl`, `sheets/turnN.png`).

| cell | median | bytes | out tokens |
|---|---|---|---|
| Sonnet + inline (shipped) | 23.1s | 4599 | 1677 |
| Haiku + inline | 9.6s | 2276 | 824 |
| Sonnet + `<style>` block | 21.8s | 3786 | 1405 |
| Haiku + `<style>` block | 9.9s | 2443 | 859 |
| Haiku + hard brevity cap | 8.0s | 1723 | 635 |

**DECISION (Nil, 2026-07-25): keep Sonnet + inline styles, unchanged.** He
judged the slides side by side and chose composition over speed: "sonnet +
inline is the best. no question about it."

Three findings worth not re-deriving:

- **The `<style>`-block idea is REFUTED, don't re-propose it.** Compliance was
  total (6/6) but the win was only 6% on Sonnet and negative on Haiku, because
  styling does not shrink, it RELOCATES — these slides carry ~40 individually
  styled elements, so there is nothing to factor out. It also introduced a new
  failure mode: on 2/6 Sonnet slides the model declared a `.root` class and then
  emitted the root `<div>` without it, silently losing the dark background, the
  edge padding and the font. Inline styling makes that class of bug impossible.
- **Model tier is the only real lever** (23.1s -> 9.6s): Haiku decodes ~20%
  faster AND writes half as many tokens. The quality cost is compositional —
  Haiku fills the 1280x720 canvas less deliberately (empty bottom thirds; one
  genuinely bad layout in 6) and overflows harder when it does overflow. Note
  the prompt was written against Sonnet, so Haiku's ceiling here is untested.
- **The floor is ~7-8s** for this architecture: ~2.1s fixed overhead (process
  spawn + round trip + teardown) plus ~600 output tokens minimum for a real
  slide. A hard brevity cap bought only 1.6s and cost visible richness. Under
  5s is NOT reachable by model or prompt tuning — it needs an architecture
  change (stream the slide as it is written, or generate speculatively while
  the agent's turn is still running instead of after it settles).

## Resolved-question archive

All four open questions from v1 were resolved in the interview: inline cards
cut from v0 (#4 above made them moot), regenerate included (with feedback),
per-agent model override not needed (backend-family rule instead), and
generation-failure fallback rendered client-side from the response text.
