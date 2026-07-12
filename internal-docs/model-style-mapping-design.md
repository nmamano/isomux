# Design: model -> style mapping (task c269ff78)

Status: implemented as designed (ui/model-styles.ts + ui/model-styles.test.ts;
consumers: DeskUnit, LogView, DeskSprite).

## Problem

Per-model visual styling is hardcoded in three places, keyed on exact
model-family strings:

- `MODEL_TINT` (nametag + avatar frame colors), duplicated verbatim in
  `ui/office/DeskUnit.tsx:8` and `ui/log-view/LogView.tsx:92`.
- Desk decorations gated on `modelFamily === "haiku"` (crayons) and
  `=== "opus"` (book + clock) in `ui/office/DeskSprite.tsx:374,422`.

Every new model needs edits in all three spots, and a model with no entry
falls back to flat gray (`--bg-tag` / `--border-medium`), so new models are
visually indistinguishable from each other.

## Proposal

One new UI module, `ui/model-styles.ts` (config-as-code; no server changes,
no runtime settings UI). It lives in `ui/` rather than `shared/` because
the data is pure presentation (CSS colors, desk sprite props) with no
server consumer, and both consumers (office view and LogView) sit under
`ui/`.

```ts
export type DeskProp = "crayons" | "book"; // extensible union
export interface ModelStyle {
  border: string; // CSS color
  bg: string; // CSS color
  deskProp?: DeskProp;
}
// Explicit entries for every known model, seeded verbatim from today's
// MODEL_TINT values, plus deskProp: "crayons" on haiku and "book" on opus.
export const MODEL_STYLES: Record<string, ModelStyle>;
// The single lookup all render sites use.
export function styleForModel(modelFamily: string | undefined): ModelStyle;
```

- `styleForModel` returns the explicit entry when present.
- Missing/empty input (DeskSprite declares `modelFamily?: string`) returns
  a neutral style (today's `--bg-tag` / `--border-medium` gray, no
  deskProp). Missing identity is never hashed into a fake model color.
- Unknown non-empty strings get a deterministic fallback: a tiny stable
  string hash (explicit unsigned/modulo handling) indexes into a fixed
  palette of ~8 entries, chosen to hold up in both dark and light themes
  and in both consumers (thin border + translucent bg). This guarantees
  deterministic variety, not uniqueness: collisions are possible, but a
  brand-new model still gets a stable color instead of today's flat gray.
- `DeskUnit`, `LogView`, and `DeskSprite` all consume `styleForModel`; the
  two `MODEL_TINT` copies and the hardcoded family checks are deleted.
- Unit tests: explicit lookup, unknown-string determinism + palette
  membership, missing-input neutral, and no negative-modulo hash bucket.

## Where the mapping lives: code, not a runtime setting

Model availability is already code-defined (`MODEL_FAMILIES`,
`FAMILY_TO_MODEL`, `CODEX_MODELS` in `shared/types.ts`): adding a model to
isomux is a code change today, so its style entry belongs in the same
commit, in one file. This is config-as-code: inspectable, greppable,
versioned. The hash fallback covers models that show up dynamically (the
Codex backend lists models at runtime) before anyone adds an entry.

Alternative considered: an overrides file (`~/.isomux/model-styles.json`)
merged over the code defaults and shipped to the UI in the state payload.
Runtime-editable without a rebuild, but adds server plumbing + merge logic
for a mapping that changes a few times a year. Easy to layer on later,
since all render sites will already go through the single `styleForModel()`
seam. Not proposing it now.

## What a "style" is

Exactly what models visually control today, nothing more:

- border + bg color: nametag badge in the office view, avatar frame in
  LogView. Kept as explicit CSS strings (not base color + derived alphas):
  current styles do not share opacity rules (border alphas span .60-.95,
  bg .20-.40), and explicit values preserve exact migration and allow
  independent tuning.
- optional desk prop: the crayons/book decoration on the desk sprite. Note
  "book" means the whole current opus rendering, including the
  deskIndex-dependent clock variation; that variation stays inside the
  prop renderer, keyed on deskIndex as today.

The display label ("Opus 4.8", "GPT-5.6 Sol") stays in
`familyDisplayLabel()`: that is identity, not style, and it already handles
unknown strings by passing them through.

## Thinking effort: already decoupled, no work needed

Effort is a separate field (`EffortLevel`) rendered as plain text labels in
the edit/cronjob dialogs, the /effort picker, and cronjob run metadata.
Thinking blocks in the log are styled by theme variables
(`--thinking-bg` / `--thinking-border`), not by model. The only place
effort touches model identity is capability filtering (`effortLevelsFor`,
`claudeFamilySupportsMaxEffort`), which is semantics, not styling; it stays
where it is in `shared/types.ts`.

## Migration

`MODEL_STYLES` is seeded with today's exact colors and props, so day one is
zero visual change for all explicitly known models. Unknown runtime models
change intentionally: gray today, hashed palette color after. Haiku keeps
crayons, opus keeps the book, now as data instead of hardcoded
conditionals. Restyling later (e.g. giving fable or sonnet a desk prop)
becomes a one-line data edit.

## Doc surfaces (resolved at implementation)

Checked per `internal-docs/documentation.md`: the chatbot system prompt
(`api/chat.ts`) line "Opus agents have a book; Haiku agents have crayons"
remains true (the default mapping is unchanged), and `docs/features.md`
does not mention model tints or desk items. No copy changes needed.
