# OpenCode third-backend audit

Measured 2026-08-28 against branch `opencode-backend` after OC1 S7.

## Result

A production-code sweep found 71 exact backend comparisons. The backend
dispatcher is exhaustive across Claude, Codex, and OpenCode. The remaining
backend-specific branches are capability gates, backend-only diagnostics,
backend-specific validation, or deliberately narrow onboarding behavior.

One two-engine product assumption remained. `ContextMenu` computed its single
alternate as `Codex ? Claude : Codex`. An OpenCode agent could not start a
Claude conversation from that menu, and a Claude agent could not start an
OpenCode conversation. Commit `bcc2bc3` derives every alternate from
`ENGINE_OPTIONS` and renders all engines except the current one.

The engine-list helper has an invariant test: for every configured engine, its
alternates equal `ENGINE_OPTIONS` without the current engine, never contain the
current engine, and have the derived length `ENGINE_OPTIONS.length - 1`. The
test covers the helper, not the `ContextMenu` render wiring. Reverting the
wiring to the old ternary leaves the UI test suite and TypeScript green. A
store-backed `renderToStaticMarkup` test is a follow-up, not a claim made by
this audit.

## Deliberate backend branches

- `server/backends/index.ts` handles all three engines and has a `never`
  exhaustiveness default. A fourth backend breaks the build until it is added.
- Welcome-agent setup accepts only the narrowed type `"claude" | "codex"`.
  Fresh offices deliberately seed those two welcome agents; TypeScript rejects
  an accidental OpenCode caller.
- Slide formatting chooses a Claude or Codex model only after the backend
  reports `oneShot`. OpenCode reports `oneShot: false`, so the Codex fallback is
  unreachable for OpenCode.
- Topic generation is also capability-gated off for OpenCode. Its non-Claude
  fallback would use the agent's own model rather than a Codex constant.
- The busy-turn watchdog deliberately observes every non-Claude backend without
  applying Claude's recovery.
- Claude process-exit hints, shutdown rejection detection, and extra system
  prompt clauses inspect Claude-owned files or behavior and remain Claude-only.
- Fixed-CWD handling explicitly groups Codex and OpenCode. Model, permission,
  effort, sandbox, login, discovery, and cron branches each use their
  backend-specific contract.
- The model header deliberately gives non-Claude agents a backend badge when
  the model label does not already identify the engine.

## Visual identity

OpenCode does not get a different character body, outfit, desk, animation, or
state treatment. It uses the shared randomized avatar system. Its explicit
visual distinctions are the orange OpenCode accent in engine-selection UI and
the conditional `OPENCODE` badge beside the model label. The fixed welcome
outfits apply only to the deliberately narrowed Claude and Codex welcome
agents. This audit adds no invented OpenCode character styling.

## Prose sweep

The code was three-backend aware in the deliberate branches above, but prose
still contained old two-backend language.

Nil approved two user-visible replacements:

- `api/chat.ts` now says plugins add behavior "across agents."
- `ui/demo-entry.tsx` now says "To connect real agents."

Internal comments with the same stale assumption were corrected in
`server/cronjob-manager.ts`, `server/agent-manager.ts`,
`server/attachment-prompt.ts`, `shared/types.ts`,
`ui/log-view/LogEntryCard.tsx`, and
`internal-docs/context-fullness-visibility.md`. Matching test and internal
testing/voice documentation comments were corrected at the same time, after
Nil approved the two customer-facing updates. The Postgres-engine references in
`control-plane/roles.ts` and `control-plane/ssh.ts` are unrelated and were not
changed.

## Gates

The ContextMenu change passed its focused invariant test, the full UI test
suite in review (507 pass, 0 fail), ESLint, `tsc --noEmit`, and `build:ui`.
The test coverage limitation above remains explicit.
