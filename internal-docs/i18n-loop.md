# Office internationalization loop (standing orders)

Slice loop authorized by Nil 2026-09-05 (board task: see the PM). Lanes
alternate: Isomux Worker 1 / Isomux Reviewer 1 on odd slices, Isomux Worker 2 /
Isomux Reviewer 2 on even slices. One worktree, `i18n` (branch `i18n`), kept
for the whole loop; at every slice start the worker runs `git reset --hard
main` in it (the PM has squash-merged the previous slice into main by then).
The worker re-reads this whole file at every slice. Delete this file at loop
close.

North star: a boss whose language is Spanish or Catalan reads the office in
that language: every view, dialog, the settings page, the office scene's
labels, toasts, empty states, dates and relative times, and the human-facing
text the server writes back to a known user (slash-command responses, welcome
text). English stays the source of truth and the fallback. Agents keep seeing
English. Nothing about the product changes except the language it speaks.

Today (as of bd790b7, measured 2026-09-05):

- `shared/languages.ts` has `SUPPORTED_LANGUAGES` with `en` and `es` (code,
  label, englishName, speechLocale). `users.json` carries a per-user
  `language` (null = never chosen; one user is on `es`). `ui/preference-form.ts`
  is the one place that answers "which language is in effect for this user":
  an explicit preference wins, otherwise the browser language, and English is
  never seeded. `ui/components/PreferencesPane.tsx` is the picker.
  `ui/App.tsx` (~line 272) auto-commits the browser language once.
- The preference drives only the agent reply-language clause in the system
  prompt and the voice locale. The UI chrome is not translated. No i18n
  library, no catalog: strings are inline JSX text, string props, template
  literals. Rough counts of capitalised prose literals of three or more words:
  ui/components 118, ui/log-view 117, ui top level 88, ui/office 7; server
  human-facing: server/commands.ts 65, server/isomux-office.ts 32,
  server/command-handlers.ts 22. Real counts are higher (short labels,
  aria-labels, multi-line JSX).
- 20 `toLocale*String` calls and no `Intl.*` use in ui; relative times are
  formatted by hand.
- DOM render harness: `ui/test-support/dom.ts` (happy-dom, per-file
  registration, dynamic imports after `setUpDomTestFile()`), 5 s cap per test
  file. Existing DOM tests find elements by English text.
- Server identity: route handlers get `ctx.identity` (userId for a human,
  an agent id for a bearer agent).

## Rulings (final)

1. Register: informal. Spanish uses tú; Catalan uses tu. Never usted or
   vostè. Nil's copy rule holds in every language: short, plain, no filler.
2. Server strings: slash-command responses and welcome/onboarding text are
   translated for a known human user. API error messages (the `fail(...)`
   strings) stay English. Agent bearer callers always get English.
3. The demo bundle is not a target. It shares the UI bundle and translates
   with it; seeded demo content stays English.
4. Mechanism: no library. A typed catalog per language with a lookup
   function and `{name}` interpolation. Plurals are explicit keys (`one` /
   `other`) picked with `Intl.PluralRules`; Spanish and Catalan need no more.
5. No language picker before sign-in. The sign-in page follows the browser
   language.
6. English copy is frozen. Moving a string into the catalog never changes
   it (JSX whitespace normalization excepted). Any English wording change is
   PARKED FOR NIL with the proposed text.
7. Catalog shape: English is the typed source of truth; the other languages
   are typed as complete records over the English keys, so a missing key is
   a compile error. A test also proves every key exists in every language,
   no value is empty, and every value carries the same placeholders as the
   English one. Keys name the surface and the meaning (`tasks.empty`), never
   the English text.
8. Language resolution stays where it is: `ui/preference-form.ts` decides
   the effective language for a user; the UI gets one language context fed
   from it. The server resolves from the requesting user's stored
   preference and falls back to English. No second resolver.
9. Catalan joins `SUPPORTED_LANGUAGES` as `ca` / `Català` / `Catalan` /
   `ca-ES`. Anything that enumerates languages by hand (tests, docs, the
   system-prompt clause) is found by grep, not assumed.
10. Test runtime is the constraint (Nil): 5 s wall-clock per DOM test file,
    asserted in the file. DOM tests that find elements by text look the text
    up through the catalog, or pin the key, so a translation change never
    silently breaks a test.
11. Proper nouns stay as they are in every language: Isomux, Claude, Codex,
    OpenCode, Tailscale, GitHub, model names, slash commands, route paths,
    key names shown as code.
12. Dates and relative times (S4) go through `Intl.DateTimeFormat` and
    `Intl.RelativeTimeFormat` with the effective language; no hand-built
    month or weekday tables.
13. Nil does the final language read on the live UI, not in chat. The
    reviewer checks every catalog entry for meaning drift and register; the
    worker writes Spanish and Catalan itself.

## Gates (every hand-off)

Every gate log starts with `git rev-parse HEAD` and is produced after the
commit under review. Never a bare `bun test`; guard against an empty file
list.

    bash -c 'systemd-run --user --scope -q -p MemoryMax=2G bun test <touched suites> > /tmp/i18n-lane.log 2>&1; echo exit=$? >> /tmp/i18n-lane.log'
    bunx eslint <touched files>
    bun run build:ui
    bun run build:demo      # when ui/demo-server.ts or shared/storage-labels.ts is touched
    bunx tsc --noEmit       # once, before the final hand-off of each slice

Report every DOM test file's wall-clock from the log in the hand-off, and
the size of `ui/dist/index.js` before and after the slice.

## Prohibitions

- No new dependency, runtime or dev. No i18n library.
- No English wording change (ruling 6). No change to agent-facing prompts
  (`server/system-prompt.ts`, cron-run prompts), docs/, README, site/,
  `api/chat.ts`, or the control plane.
- No server change before S5, except `shared/languages.ts` in S1.
- No `git stash`, no rebase while the reviewer holds the token, never
  prettier, never a server restart, never a push.
- No machine translation pasted from a service; the worker writes the text.

## Decision protocol

Worker+reviewer settle: file layout under the catalog directory, key names,
the hook and helper API, how a pure module receives the language, test names,
the fixture that puts a user on a language in DOM tests. Manager settles:
rulings, slice order, a runtime over the cap, a string whose ownership
(UI or server) is unclear. PARKED FOR NIL: any English wording change, any
docs/README/landing line about language support, the PreferencesPane
explanatory copy once it has to say the office itself is translated.

## Slice checklist (per slice)

1. `git reset --hard main` in the worktree; gates green on that base.
2. Plan-gate with the reviewer.
3. Implement; gates; commit; hand the token with the hash.
4. Iterate to approval; final `bunx tsc --noEmit`.
5. Report to the PM: what changed, verification, approved hash, per-file
   DOM test runtimes, bundle size delta, every new or changed user-visible
   English string verbatim (there should be none), parked items.

## Slice cut

- S1 (lane 1): catalog and plumbing. Catalog module, lookup with
  interpolation and plurals, `ca` in `SUPPORTED_LANGUAGES`, the language
  context in the UI, the catalog completeness test, the DOM fixture for a
  user on a language, and ONE tracer converted end to end with Spanish and
  Catalan text: the preferences pane and the nav bar's action labels. DOM
  test proving the switch.
- S2 (lane 2): the settings page and every dialog (UserSettingsView and its
  panes, EditAgentDialog, CronjobDialog, CronjobsPromptDialog, the prompt
  and confirm dialogs).
- S3 (lane 1): the log view and its cards (LogView, LogEntryCard, the
  isomux-curl labels in `ui/log-view/isomux-curl.ts`), terminal and editor
  panel chrome, context battery, subscription pill.
- S4 (lane 2): office view and scene labels, task board, apps view, cronjobs
  views, agent list, empty states, toasts, context menu; dates and relative
  times through Intl.
- S5 (lane 1): server-produced human-facing strings resolved per user:
  slash-command descriptions and responses, welcome and onboarding text.
  Resolution from `ctx.identity` to the stored preference; agents get
  English.
- S6 (lane 2): sweep. Grep for prose left in English in ui/ and the S5
  server files; the demo builds and shows a translated chrome; doc surfaces
  per `internal-docs/documentation.md` that describe language support get
  proposed lines for Nil (not written); loop close.

## PICKUP S1 - catalog and plumbing (Worker 1 / Reviewer 1)

Goal: a user on Catalan sees the preferences pane and the nav bar's action
labels in Catalan, a user on Spanish in Spanish, everyone else in English;
the mechanism the next five slices convert into exists and is tested.

Mechanics:

- Lookup module importable from both ui/ and server/ (S5 reuses it), so it
  lives under `shared/`; the UI-only React context and hook live under
  `ui/`. Worker and reviewer settle the exact paths and names.
- English catalog as a typed const object; `es` and `ca` typed as complete
  records over its keys (ruling 7). Interpolation `{name}`; plurals as
  explicit `one` / `other` entries picked with `Intl.PluralRules`.
- Catalog completeness test (ruling 7), plain `bun test`, no DOM.
- `ca` in `SUPPORTED_LANGUAGES` (ruling 9). Grep every hand enumeration of
  language codes and labels (tests, `server/system-prompt.ts`'s clause, the
  picker) and update what breaks; the system-prompt clause uses
  `englishName` and should need no prose.
- Language context: fed from the effective language for the self user as
  `ui/preference-form.ts` already computes it (explicit preference, else
  browser language, else English). Read `ui/App.tsx` ~line 272 and
  `useSelfUser` to find where the self user is known; the provider wraps
  the app once. A pure ts module that builds strings receives the language
  or `t` as an argument, never reads a global.
- Tracer: `ui/components/PreferencesPane.tsx` (its labels and the
  explanatory copy) and the nav bar's action labels (the `label` values App
  passes to `NavActions`). Spanish and Catalan text written by the worker,
  register per ruling 1.
- DOM test fixture: a way to render with a self user on a given language.
  Read how the existing `ui/App.*.dom.test.tsx` files get the store state
  in (websocket fake or store seeding) and reuse it; if App cannot be put
  on a language cheaply, the tracer test renders PreferencesPane inside the
  provider directly and the App-level switch is proven in S2.
- One DOM test file: renders the tracer on `ca`, asserts a Catalan label;
  switches to `es`, asserts Spanish; default is English. Under 5 s,
  asserted in the file.
- Measure `ui/dist/index.js` before and after; report the delta.

Acceptance: catalog and lookup with tests; `ca` selectable in the picker;
the preferences pane and nav labels render in all three languages from the
user's effective language; completeness test and DOM test green; existing
DOM tests still green (they assert English on a null-language user, which
stays English); `internal-docs/testing-guide.md` gains a short note on the
language fixture; bundle delta reported.

Decide with reviewer: paths, names, the hook API, the fixture.
Locked: rulings 1, 4, 6, 7, 8, 9, 10; nothing beyond the tracer is converted
in S1.
