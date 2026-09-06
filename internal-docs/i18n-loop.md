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
    asserted in the file. The text oracle is ruling 14.
11. Proper nouns stay as they are in every language: Isomux, Claude, Codex,
    OpenCode, Tailscale, GitHub, model names, slash commands, route paths,
    key names shown as code.
12. Dates and relative times (S4) go through `Intl.DateTimeFormat` and
    `Intl.RelativeTimeFormat` with the effective language; no hand-built
    month or weekday tables.
13. Nil does the final language read on the live UI, not in chat. The
    reviewer checks every catalog entry for meaning drift and register; the
    worker writes Spanish and Catalan itself.
14. DOM oracle (Reviewer 1, S1): a DOM test asserts literal translated
    strings, never text read back through the translator, so a broken
    provider cannot pass its own test. Unit tests may pin keys.
15. Key names carry the full surface name (`preferences.*`, `settings.office.*`),
    never an abbreviation. A string shared verbatim by more than one surface
    lives under `common.*`; the second use moves it there. Key segments are
    camelCase (the catalog test enforces it), so an id with a hyphen or
    underscore is converted, never used verbatim (`templates.moneyPlanner`).
16. Rich text: a sentence with an inline link, code span or element is ONE
    key with a named placeholder, rendered by a helper in `ui/i18n.tsx`.
    Never split a sentence into before/after keys; word order differs per
    language.
17. Time helper zero cases (ruled after S3, 2026-09-05): `Intl` runs with
    numeric "always", so no language gets "this minute", "this hour",
    "anteayer" or "demà passat" in a column. The under-a-minute and
    under-an-hour cases are discriminated results of the helper, rendered
    by the caller from the catalog with the pre-S3 English ("just now",
    "0h"), so ruling 6 holds for English exactly.
18. Helper convention (S3): a component takes the translator from the
    context hook; a function that runs during render but is not a component
    takes the translator as its first argument (a hook there breaks the
    rules of hooks).
19. A catalog value never contains angle brackets that are not a `rich()`
    tag pair (`https://<host>` fails the balanced-tag test). Such a fragment
    is code (ruling 11) and is passed in as a placeholder from the call site.
20. Nil, 2026-09-06: the subscription reset keeps its weekday. S8 adds a
    weekday-bearing shape to `shared/i18n/time.ts` (Intl weekday short,
    day, month short, 24-hour clock) and `SubscriptionPill` uses it; unit
    test pins the native Intl English, "Sat, Aug 1, 09:00" (amended at the
    S8 plan gate: the weekday is Nil's ask, the exact pre-S5 bytes were the
    PM's pin, and the shape change is a formatting change under ruling 6).

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
the size of `ui/dist/index.js` before and after the slice. Bun prints no
per-file time: run each DOM file in its own `bun test <file>` invocation
inside the same log (the S1 log `/tmp/i18n-lane.log` has the shape).

`t` is a common local name in this codebase (`tabs.map((t) => t.path)`, a
speech transcript). In a file that already binds it, hold the whole translator
(`const i18n = useI18n()`) and call `i18n.t`; a destructured `t` there
type-checks as the local and fails with "has no call signatures" (S5).

The DOM fixture is `onLanguage(language, element, over?)` from
`ui/test-support/language-fixture.tsx`, loaded with `await import` after
`setUpDomTestFile()`. The App DOM tests supply state through
`StateCtx.Provider`, not store seeding. Two DOM traps are documented in
`internal-docs/testing-guide.md` (S2): a pane fetch that settles after the
file ends prints "pass, 0 fail" AND exits 1, so read the exit line; and a
sidebar click proves nothing until the row reports `aria-current`. A list
seeded through the fixture's `over` needs its loaded flag TRUE, or the
seed hook fetches and a shim answer overwrites the seeded rows (S3).

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

- S1 (lane 1): catalog and plumbing, Catalan, the tracer (preferences pane
  and the office nav labels). Landed.
- S2 (lane 2): settings page shell (sidebar, headers, back link, section
  titles, dirty-check prompt) and the office-side panes: Office, Room,
  Theme, My devices, Update, Usage, Storage.
- S3 (lane 1): the access and connections panes: Invites, External access,
  API tokens, Connections, ProviderSignInCard, access-shared (wholesale,
  including the tables and list sections the My devices pane renders; ruled
  on Reviewer 2's S2 escalation, 2026-09-05), ManagedEnvEditor.
- S4 (lane 2): the dialogs: EditAgentDialog, CronjobDialog,
  CronjobsPromptDialog, the prompt and confirm dialogs, ExpandableTextarea
  chrome.
- S5 (lane 1): the log view and its cards (LogView and its own nav actions,
  LogEntryCard, the isomux-curl labels in `ui/log-view/isomux-curl.ts`),
  terminal and editor panel chrome, context battery, subscription pill.
- S6 (lane 2): office view and scene labels, task board, apps view,
  cronjobs views, agent list, empty states, toasts, context menu, the theme
  display names in `ui/themes.ts` (shown by ThemePane), and
  `PENDING_PROMPT_BADGE` in `ui/pending-prompt.ts`, whose four one-word
  badges S5 left English because only `ui/office/DeskUnit.tsx` renders them
  (its sibling `PENDING_PROMPT_LABEL` is already a key map); numbers through
  Intl, and every surface still formatting a time by hand moves onto
  `shared/i18n/time.ts` (S3), which S6 reuses and does not extend for the
  existing cases; specifically `shared/format-human.ts`'s formatRelativeTime,
  shared by StoragePane and `server/storage-report.ts`, which S3 did not
  touch (ruling 12).
- S7 (lane 1): server-produced human-facing strings resolved per user:
  slash-command descriptions and responses, welcome and onboarding text,
  and `shared/update-notice.ts` (consumed by `server/update-checker.ts` and
  the UI; the builder takes a translator; ruled 2026-09-05). Resolution
  from `ctx.identity` to the stored preference; agents get English.
- S8 (lane 2): sweep. Grep for prose left in English in ui/ and the S7
  server files; the demo builds and shows a translated chrome; the two
  parked English strings from S1 (preferences.intro, preferences.languageHint)
  get Nil's wording; doc surfaces per `internal-docs/documentation.md` that
  describe language support get proposed lines for Nil (not written).
- Extended by Nil, 2026-09-06 (extra slices in this loop, not a new one):
  the product sends a boss to isomux.com to learn what it is, so the
  public explanation follows the boss's language too. Docs, README, the
  developer API page and the legal pages stay English; the legal pages
  are named as the governing text.
- S9 (lane 1): the pre-sign-in office pages in `server/auth-middleware.ts`
  (first-time claim, invite accept, login): Accept-Language negotiation
  with quality values, English fallback, a `lang` attribute on the served
  HTML, strings in the shared catalogs, a route test per language. Ruling
  5 delivered; task 852694dc folds in.
- S10 (lane 2): the landing page (`site/index.html`) and the hosted page
  (`site/hosted.html`) in Spanish and Catalan as static copies under their
  own paths with hreflang and a language switch; the office links a boss
  to the copy in their language. The legal pages stay English with one
  line on the hosted page saying so. The Spanish and Catalan copy is Nil's
  voice on the public site: the report pastes it verbatim and the slice
  merges only on his word.
- S11 (lane 1): the control plane web app (`control-plane/web`): sign-in,
  plan choice, payment, the waiting-for-your-office page and the emails,
  with its own copy of the catalog pattern (it cannot import
  `shared/i18n`), locale from Accept-Language and then the stored
  preference; `bun run ci:web` is the gate. Loop close after S11.

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

- [x] S1 landed as 248cf0b (+ format 6bde1b1). Catalog under `shared/i18n/`
  (en.ts, es.ts, ca.ts, translate.ts), `translatorFor(language)` with `t`
  and `tn`, `LanguageProvider`/`useI18n` in `ui/i18n.tsx`, fixture in
  `ui/test-support/language-fixture.tsx`. Bundle +3379 bytes; the new DOM
  file 3.0 s whole-invocation (measured 2026-09-05). Two stale controls in
  the S1 pickup corrected above (nav actions live in OfficeView and
  AgentListView; App tests use StateCtx.Provider). Parked for Nil: the
  English of preferences.intro ("My devices" row no longer exists) and
  preferences.languageHint ("stays in English for now").

## PICKUP S2 - settings page shell and the office-side panes (Worker 2 / Reviewer 2)

Goal: a user on Catalan or Spanish reads the settings page shell and the
Office, Room, Theme, My devices, Update, Usage and Storage panes in their
language; everyone else sees the English bytes unchanged.

Mechanics:

- Files: `ui/components/UserSettingsView.tsx` (the shell and every string
  it holds, including the browser confirm for unsaved edits), `OfficePane`,
  `RoomPane`, `ThemePane`, `MyDevicesPane`, `UpdatePane`, `UsagePane`,
  `StoragePane`, `DevicePane` (added by PM ruling on Reviewer 2's plan-gate
  escalation, 2026-09-05: it sits in the Device group beside Theme; keys
  `settings.device.*`), plus `ui/storage-prune-form.ts` and
  `ui/device-settings.ts` where they build prose. Not in S2: the access and
  connections panes (S3), the dialogs (S4).
- Keys: `settings.*` for the shell, then `settings.office.*`,
  `settings.room.*`, `settings.theme.*`, `settings.devices.*`,
  `settings.update.*`, `settings.usage.*`, `settings.storage.*`. Words
  shared verbatim (Save, Cancel, Delete, Close, Loading…, Saved.) move to
  `common.*` on their second use, S1's `preferences.*` copies included; the
  S1 DOM test pins literal text, so a key rename does not touch it.
- Rich text: first need lands here. Settle the helper's API with the
  reviewer at the plan gate (ruling 16); put it in `ui/i18n.tsx`.
- Numbers, sizes and timestamps in Usage, Storage and Update keep their
  current formatting; S6 owns Intl. Only the surrounding words move.
- `shared/storage-labels.ts` feeds `build:demo`: identifiers stay English
  (ruling 11); if the Storage pane reads prose from it, the prose moves to
  the catalog and the label table keeps its identifiers. Run `build:demo`
  when it is touched.
- Tests: the five `ui/App.settings-*.dom.test.tsx` files stay green (null
  language user, English). One new file `ui/settings.i18n.dom.test.tsx`
  mounts the settings page on `ca` through `onLanguage`, asserts the
  sidebar labels and one literal anchor per pane, rerenders to `es`, under
  5 s in-file (ruling 10, oracle per ruling 14).
- Acceptance grep on the touched files: JSX text, `title=`, `aria-label=`,
  `placeholder=` and template literals show no English prose beyond proper
  nouns and code.
- Translation register per ruling 1; Spanish buttons in the infinitive,
  Catalan buttons in the imperative, as S1 set.

Acceptance: the listed files read the catalog; the catalog test is green
with the new keys; the new DOM file and the five settings DOM files green;
eslint, `build:ui`, `build:demo` when applicable, `tsc` once; bundle delta
reported. The report names every string whose translation the reviewer
debated and the choice made; the rest is the catalog diff, which the PM
reads.

Decide with reviewer: the rich-text helper API, `common.*` membership, the
new DOM file's anchors.
Locked: rulings 1, 6, 7, 10, 14, 15, 16; no access panes, no dialogs, no
Intl work.

- [x] S2 landed as 99dd399 (+ format 97bf70b). `rich()` in `ui/i18n.tsx`
  (one key per sentence, named tag pairs, catalog test holds every language
  to the English tag multiset), `common.*` live, S1 keys renamed under
  `preferences.*` and `settings.*`. Bundle +51802 bytes; new DOM file
  1.7-3.2 s (measured 2026-09-05). Scope ruling mid-slice: text produced by
  `access-shared.tsx` (S3) and `shared/update-notice.ts` (S7) stayed
  English. Main gained the owner-only "Individual Connections" section in
  `UserSettingsView.tsx` (task cf86212c) after S2 branched: its five
  strings are English and belong to S3.

## PICKUP S3 - access and connections panes (Worker 1 / Reviewer 1)

Goal: a user on Catalan or Spanish reads the Invites, External access, API
tokens, Connections (office-wide and individual) and Sign-in links panes,
the provider sign-in card, the managed-variables editor, and the shared
tables and list sections those panes and My devices render, in their
language.

Mechanics:

- Files, each named on purpose: `ui/components/access-shared.tsx` (its
  own file in this slice: `renderListSection`, `InvitesTable`,
  `SessionsTable`, loading and empty states, headers, expiry labels,
  controls; translating it changes what `MyDevicesPane` renders, which is
  intended, and S2's DOM file asserts only that pane's own heading),
  `InvitesPane`, `ExternalAccessPane`, `ApiTokensPane`, `ConnectionsPane`,
  `ProviderSignInCard`, `ManagedEnvEditor`, and the `MemberVariableNames`
  section in `UserSettingsView.tsx` (heading "Individual Connections", its
  hint, "No variables.", "Could not load variables.", "Loading…").
- Keys: `settings.invites.*`, `settings.sessions.*`,
  `settings.externalAccess.*`, `settings.apiTokens.*`,
  `settings.connections.*`, `settings.signIn.*`, `settings.env.*`,
  `settings.memberConnections.*`. Sidebar labels for these panes already
  exist from S2 (`settings.sidebar.access`, `.invites`, `.sessions`,
  `.connectionsOffice`, `.connectionsPersonal`, `.apiTokens`,
  `.signInLinks`): reuse a key for a pane heading only when the bytes
  match; never mint a second key for the same string. `common.*` second-use
  rule applies; "Delete", "Close", "Got it" are pane-local in S2 and move
  on their second use.
- Rich text through `rich()` (ruling 16). Variable NAMES, token prefixes,
  URLs, and anything shown as code stay as they are (ruling 11).
- Timestamps, relative times and expiry values (ruled on Reviewer 1's
  plan-gate escalation, 2026-09-05): S3 introduces the Intl time helper
  under `shared/i18n` (relative formatter with the existing thresholds and
  the just-now/expired cases on `Intl.RelativeTimeFormat`; absolute
  formatter on `Intl.DateTimeFormat`), language as an argument, unit test
  on en/es/ca at the thresholds. `access-shared.tsx` uses it; S6 reuses it
  for the rest of the UI. A shape change in the English output (Intl vs the
  hand-built text) is a formatting change, allowed under ruling 6; the
  report lists the before/after pairs.
- Tests: the existing `ui/App.settings-connections.dom.test.tsx` and its
  siblings stay green on a null-language user; one new DOM file
  `ui/settings-access.i18n.dom.test.tsx` mounts the settings page on `ca`
  through `onLanguage`, asserts one literal anchor per pane plus one
  access-shared table header and one empty state, rerenders to `es`, under
  5 s in-file (rulings 10 and 14). Mind the two DOM traps in the gates
  section.
- Acceptance grep on the touched files as in S2.

Acceptance: the listed files read the catalog; catalog test green with the
new keys; the new DOM file, the settings DOM family and
`ui/settings.i18n.dom.test.tsx` green; eslint, `build:ui`, `build:demo` if
`ui/demo-server.ts` is touched, `tsc` once; bundle delta reported. The
report names the strings the reviewer debated and the choice made; the rest
is the catalog diff.

Decide with reviewer: `common.*` moves, the new DOM file's anchors, how
`access-shared.tsx` receives `t` (hook inside the components, or a
parameter for the pure helpers).
Locked: rulings 1, 6, 7, 10, 11, 14, 15, 16; no dialogs, no Intl work, no
server change.

- [x] S3 landed as 670a464 (+ format 1672bbc). `shared/i18n/time.ts`
  (timeSince, timeUntil, absoluteTime; expired as a discriminated result),
  about 150 settings.* keys, 19 common.* keys. Bundle +35536 bytes; new DOM
  file 2.0 s (measured 2026-09-05). Parked for Nil: "Individual Connections"
  heading capital C versus "Individual connections" elsewhere (frozen under
  ruling 6, own key); the External access Public URL placeholder is this
  box's own tailnet hostname (task filed). Ruling 17 reverses the two
  Intl phrase substitutions S3 shipped ("just now" -> "this minute", "0h" ->
  "this hour"); S4 applies it first.

## PICKUP S4 - the dialogs (Worker 2 / Reviewer 2)

Goal: a user on Catalan or Spanish reads the agent dialog (new and edit),
the schedule dialog, the schedules prompt dialog, and every prompt or
confirm dialog the office opens, in their language.

Mechanics:

- First, ruling 17 in `shared/i18n/time.ts`: numeric "always"; timeSince
  under a minute returns `{ kind: "now" }` rendered by its callers from
  `common.justNow` ("just now"); timeUntil under an hour returns
  `{ kind: "underHour" }` rendered by the invites caller with its pre-S3
  text ("0h"); unit tests updated at the same boundaries; the S3 report's
  before/after table returns to the S3 "before" column for English.
- Files: `ui/components/EditAgentDialog.tsx`, `ui/components/CronjobDialog.tsx`,
  `ui/components/CronjobsPromptDialog.tsx`, `ui/components/ExpandableTextarea.tsx`
  chrome, and whatever else renders `role="dialog"` or a browser
  confirm/prompt in ui/ outside the log view and the office scene (grep;
  name each in the plan gate).
- Keys: `dialogs.agent.*`, `dialogs.schedule.*`, `dialogs.schedulePrompt.*`,
  `dialogs.confirm.*`; `common.*` second-use rule.
- Option labels: the effort level labels, model family labels and
  permission mode labels that the UI reads from `shared/types.ts` tables
  are prose and move to the catalog keyed by their id (`effort.minimal`,
  `modelFamily.opus`, `permissionMode.<value>`), the table keeping the id
  and the UI mapping id to text; model NAMES and slugs stay (ruling 11).
  Labels that arrive from the server (the live Codex model list, backend
  permission modes from `/api/backends`) stay as delivered in S4 and are
  listed in the report for S7 to decide. Verify which is which before
  building on it.
- Validation and error messages the dialogs compose client-side move to
  the catalog; messages relayed from a server error stay as delivered
  (ruling 2 keeps API errors English).
- Agent templates (ruled on Reviewer 2's question, 2026-09-05): the card
  label and description are prose and move to the catalog keyed by template
  id; the spawned agent's name is data authored at spawn time and takes the
  label in the user's language, unless code matches on the English label
  after spawn (verify by grep; then the name stays English and the report
  says which code forced it); customInstructions stay English.
- Tests: `ui/components/EditAgentDialog.test.ts`, `ui/App.dirty.dom.test.tsx`
  and every other existing dialog test stay green on a null-language user;
  one new DOM file `ui/dialogs.i18n.dom.test.tsx` mounts the agent dialog
  and the schedule dialog on `ca` through `onLanguage`, asserts one literal
  anchor per dialog section, rerenders to `es`, under 5 s in-file. Mind
  the DOM traps in the gates section.
- Acceptance grep on the touched files as in S2.

Acceptance: the listed files read the catalog; catalog test green; the new
DOM file and the existing dialog tests green; eslint, `build:ui`,
`build:demo` if `ui/demo-server.ts` is touched, `tsc` once; bundle delta
reported; ruling 17 applied and its unit tests green. The report names the
strings the reviewer debated and the choice made, and lists the
server-delivered labels left for S7.

Decide with reviewer: the option-label key layout, the new DOM file's
anchors, whether ExpandableTextarea has any prose at all.
Locked: rulings 1, 6, 7, 10, 11, 14-19; no log view, no office scene, no
Intl beyond ruling 17, no server change.

- [x] S4 landed as d8152e6 (+ format a046505). Dialogs, effort labels
  (`ui/effort-label.ts`), templates by id with the spawned name seeded from
  the localized label, ruling 17 applied. About 165 keys (553 English keys
  total). Bundle +33485 bytes; new DOM file 1.5 s (measured 2026-09-05).
  Left for S7 by report: every server-delivered label (live model lists,
  OpenCode "<provider> - <model>", relayed ApiError messages, the whole
  AgentChoiceInteraction built in `server/agent-manager.ts` and
  `server/command-handlers.ts`; `EFFORT_LEVELS` still carries an English
  label because `/effort` renders from it server-side, pinned to
  `common.effort.*` by the catalog test). Kept English by the worker's
  call: the persisted fallbacks "Untitled schedule" and "Agent {n}".

## PICKUP S5 - the log view and its panels (Worker 1 / Reviewer 1)

Goal: a user on Catalan or Spanish reads the agent log view (its chrome,
its cards, its empty states and toasts, the slash-command menu chrome, the
API-call card labels), the terminal and editor panels' chrome, the context
battery and the subscription pill in their language. Log CONTENT (what
agents and users wrote, tool output) stays as written.

Mechanics:

- Files: `ui/log-view/LogView.tsx`, `ui/log-view/LogEntryCard.tsx`,
  `ui/log-view/isomux-curl.ts` (ROUTE_LABELS is prose keyed by operation:
  the label text moves to the catalog keyed by opId, the route table keeps
  its ids and field lists), `ui/log-view/TerminalPanel.tsx`,
  `ui/log-view/PanelResizer.tsx`, the editor panel, `ContextBattery.tsx`,
  `SubscriptionPill.tsx`, and every helper module beside them under
  `ui/log-view/` and `ui/` that holds prose the log view renders
  (`ui/pending-prompt.ts`, `ui/cwd-display.ts`, `ui/voice-input-error.ts`
  are candidates; grep and name each in the plan gate; S4 found three
  such modules beside the dialogs).
- Keys: `logView.*`, `cards.*` (by card kind), `apiCall.<opId>.*`,
  `panels.terminal.*`, `panels.editor.*`, `contextBattery.*`,
  `subscription.*`; `common.*` second-use rule.
- Server-delivered text stays as delivered and is listed for S7: slash
  command names and descriptions from `server/commands.ts`, choice
  interactions, permission prompt text from the backends, system
  notices the server writes into the log. The chrome around them (menu
  headings, buttons, hints) is S5.
- Dates and relative times in the log view go through
  `shared/i18n/time.ts` (ruling 12, 17); numbers keep their formatting
  (S6).
- Tests: existing `ui/log-view/*.test.*` and the App DOM files that open
  a chat (`App.over-chat`, `App.restored-chat`) stay green on a
  null-language user; one new DOM file `ui/logview.i18n.dom.test.tsx`
  mounts the log view on `ca` through `onLanguage` with a small seeded
  log (one user message, one tool call, one API-call card, one empty
  state), asserts one literal anchor per surface, rerenders to `es`, under
  5 s in-file. `TerminalPanel.replay.dom.test.tsx` carries a real xterm;
  keep it green and do not widen it.
- Acceptance grep on the touched files as in S2.

Acceptance: the listed files read the catalog; catalog test green; the new
DOM file and the existing log-view tests green; eslint, `build:ui`,
`build:demo` if `ui/demo-server.ts` is touched, `tsc` once; bundle delta
reported. The report names the strings the reviewer debated and the
choice made, and lists the server-delivered text left for S7.

Decide with reviewer: the card key layout, the new DOM file's seed and
anchors, how the pure helpers receive the translator (ruling 18).
Locked: rulings 1, 6, 7, 10, 11, 14-19; no office scene, no server change,
no Intl beyond time.ts reuse.

- [x] S5 landed as 6e41f4c (+ format 28b8794). Log view, cards, API-call
  labels by opId, subscription pill, context battery, terminal and editor
  chrome, copy and speak buttons; 322 keys (875 English keys total);
  `PlainMessageKey` for id-to-key tables. Bundle +59363 bytes; new DOM
  file 2.0 s (measured 2026-09-06). Parked for Nil: `apiCall.memory.saveOffice`
  reads "Save a office memory" (pre-existing article bug, frozen under
  ruling 6; proposed "Save an office memory"). Product gap filed as a
  task: `ui/spoken-punctuation.ts` is English-only dictation parsing.
  Left for S7 by report: slash-command names and descriptions, skill
  descriptions, choice interactions, backend permission prompt text,
  system entries the server writes into the log ("Conversation cleared."
  at `server/command-handlers.ts` and `server/agent-manager.ts`), relayed
  ApiError text, subscription window labels ("Weekly (Opus)").
  Rule learned: a memoized value never carries finished text; a helper
  whose caller memoizes on inputs without the language returns a key.

## PICKUP S6 - office view, pages, scene labels, numbers (Worker 2 / Reviewer 2)

Goal: a user on Catalan or Spanish reads the office scene and its labels,
the task board, the apps page, the schedules pages, the agent list, the
top-level app chrome (toasts, notices, context menu, nav), the theme names,
and every number and remaining hand-formatted time in their language.

Mechanics:

- Files: `ui/office/*` (DeskUnit incl. `PENDING_PROMPT_BADGE` from
  `ui/pending-prompt.ts`, Floor, OfficeView remainder, Character labels,
  room and desk tooltips), `ui/components/TaskView.tsx`,
  `ui/components/AppsView.tsx`, `ui/components/CronjobsView.tsx`,
  `ui/components/CronjobRunView.tsx`, `ui/components/AgentListView.tsx`
  remainder, `ui/components/ContextMenu.tsx`, `ui/components/NavIcons.tsx`
  if it holds labels, `ui/App.tsx` and `ui/store.tsx` prose (toasts,
  notifications, confirms), `ui/themes.ts` display names, `ui/cwd-display.ts`
  and `ui/roomSelection.ts` if they build prose, and every helper module
  beside these that holds prose (grep; name each in the plan gate).
- Keys: `office.*`, `tasks.*`, `apps.*`, `schedules.*`, `agentList.*`,
  `contextMenu.*`, `toasts.*`, `themes.<id>`; `common.*` second-use rule;
  camelCase segments (ruling 15).
- Numbers (ruling 12): one `formatNumber(language, n)` (and a bytes/size
  variant if the code has one) in `shared/i18n/number.ts` on
  `Intl.NumberFormat`, unit-tested on en/es/ca; every `toLocaleString` and
  `toLocaleDateString`/`toLocaleTimeString` call in `ui/` (20 measured on
  bd790b7; `ContextBattery`'s "en-US" token counts included) moves to it
  or to `shared/i18n/time.ts`. `shared/format-human.ts`'s
  `formatRelativeTime` is shared with `server/storage-report.ts`: the UI
  callers switch to `time.ts`; the server keeps `format-human.ts` and S7
  decides its fate.
- Scene text drawn on canvas or SVG: translate the source string the same
  way; the DOM test asserts where the text reaches the DOM (title, aria
  label, tooltip) and the report says which labels are canvas-only.
- Memoization: a memoized value never carries finished text unless the
  language is in its dependency list (S5 rule).
- Shared helpers with server callers (ruled on Reviewer 2's S6 escalation,
  2026-09-06): `sessionResumeLabel` in `shared/session-label.ts` takes an
  optional fallback label defaulting to the current English (server
  callers byte-identical; ContextMenu passes the catalog value); schedule
  sentences get a localized display helper under `shared/i18n` (Intl
  weekday and date parts, catalog keys, language first) used by
  CronjobsView, while `humanizeSchedule` in `shared/types.ts` stays for its
  server callers until S7 decides.
- Tests: existing `ui/App.*.dom.test.tsx`, `ui/office/*.test.*`,
  `ui/components/*.test.*` stay green on a null-language user; one new
  DOM file `ui/office.i18n.dom.test.tsx` mounts the office view, then
  the tasks page and the apps page, on `ca` through `onLanguage`, asserts
  one literal anchor per surface plus one formatted number, rerenders to
  `es`, under 5 s in-file; `shared/i18n/number.test.ts` plain unit.
- Acceptance grep on the touched files as in S2.

Acceptance: the listed files read the catalog; catalog test green; the new
DOM file, the number test and the existing tests green; no `toLocale*`
call left in `ui/` (grep in the report); eslint, `build:ui`, `build:demo`
if `ui/demo-server.ts` or `shared/storage-labels.ts` is touched, `tsc`
once; bundle delta reported. The report names the strings the reviewer
debated and the choice made, the canvas-only labels, and anything left
for S7.

Decide with reviewer: the number helper API, the new DOM file's anchors,
the key layout for the scene.
Locked: rulings 1, 6, 7, 10, 11, 14-19; no server change; no log view
changes beyond `ContextBattery`'s number call.

- [x] S6 landed as ee01e63 (+ format d6a9c96). `shared/i18n/number.ts`
  (formatNumber, formatDecimal, formatMoneyUSD, formatBytes),
  `shared/i18n/schedule.ts` (scheduleText, weekdayName), `time.ts` shape
  set and timeUntilFine; no `toLocale*` left in ui/ (19 calls removed;
  the pickup's 20 was the bd790b7 count). 1,076 English keys. Bundle
  +30049 bytes; new DOM file 2.4 s (measured 2026-09-06). Parked for Nil:
  `common.loading` "Loading…" and `common.loadingDots` "Loading..." both
  exist (pre-existing inconsistency, frozen; proposed one spelling,
  "Loading…"). Conventions learned: a module under `shared/i18n` takes a
  translator only when its output is a catalog sentence (`schedule.ts`);
  value formatters (`time.ts`, `number.ts`) hold no words and the caller
  words the cases Intl has no reading for. State that outlives a render
  (useState, memo) holds a key, not finished text; a table typed over a
  union of keys uses `PlainMessageKey`. For S8: `cards.diff.reasonUntracked`
  and `cards.diff.summaryOnly` carry a bare ">" (reads as greater-than,
  cannot form a tag; letter of ruling 19); `ui/App.tsx`, `ui/store.tsx`,
  `ui/cwd-display.ts`, `ui/roomSelection.ts` hold no user-visible prose.

## PICKUP S7 - server-produced text, resolved per user (Worker 1 / Reviewer 1)

Goal: a user on Catalan or Spanish reads, in their language, the text the
server writes for them: slash-command names and descriptions in the
command menu, slash-command responses and the system entries the server
writes into their log ("Conversation cleared." and its siblings), the
choice interactions (/effort, /model and the rest: title, instruction,
choice labels and descriptions), the update notice, the storage report,
and the welcome and onboarding text. Agents keep English. API error
messages (`fail(...)`) stay English (ruling 2).

Mechanics:

- Resolution: one function on the server, per call, no global state:
  from the request's identity to a translator. A human identity resolves
  to that user's stored language (null means English: the browser
  language is unknown server-side, and the UI already commits it once at
  first sign-in, so a null here is rare); an agent identity resolves to
  English. Find where slash commands typed in chat carry their user
  (the socket's identity) and where HTTP handlers carry `ctx.identity`;
  both paths go through the same function. Name it in the plan gate.
- Catalog: the same three files under `shared/i18n`, new namespaces
  `commands.<name>.*` (description, response keys), `systemEntries.*`,
  `choices.<interaction>.*`, `updateNotice.*`, `storageReport.*`,
  `welcome.*`. The catalog completeness test covers them for free.
- `EFFORT_LEVELS` in `shared/types.ts` still carries an English label
  because `/effort` renders it server-side (S4): `effortDisplayLabel`
  takes a translator, the duplicate label is deleted, the catalog test's
  pin goes with it, and the UI's `ui/effort-label.ts` stays the UI path.
- `shared/session-label.ts`: `server/command-handlers.ts` passes the
  user's fallback label (the parameter exists since S6).
- `shared/types.ts` `humanizeSchedule`: `server/cronjob-manager.ts` moves
  onto `shared/i18n/schedule.ts` (its test already holds the English
  equal), then `humanizeSchedule` is deleted if no caller remains.
- `shared/update-notice.ts`: settle with the reviewer whether the server
  sends the status data and each client words it (preferred: the UI
  already has a translator, and the server's own log line stays English)
  or the builder takes a translator; either way `server/update-checker.ts`
  emits no finished English for a user's screen.
- `shared/format-human.ts`: the `/isomux-storage` report and
  `server/attachment-prompt.ts` still use it. The report is for a user:
  it moves to `number.ts` and `time.ts` with the report's words in the
  catalog. The attachment prompt is agent-facing and stays.
- Anything a server string carries that is data (paths, agent names,
  model slugs, command names, key names) is a placeholder (ruling 11).
- Tests: server harness tests (the `server/test-support/*` families that
  cover commands and choices) gain: a slash-command response for a user
  whose stored language is `es` arrives in Spanish; the same command from
  an agent bearer arrives in English; a null-language user gets English;
  a choice interaction for a `ca` user carries Catalan labels; the update
  notice and the storage report each have one language assertion. UI DOM
  tests stay green; if the update notice moves to the client,
  `UpdatePane`'s tests follow it.
- Docs: `internal-docs/documentation.md` names the surfaces; S8 proposes
  the docs lines. S7 touches no docs/ file.

Gates for a server slice: the touched server suites plus the whole
`server/test-support/` family that asserts over commands and choices
(grep the touched file names in `*.test.*`), `build:ui` (shared changes
reach the bundle), `bunx tsc --noEmit` once, eslint. The PM runs the boot
smoke and the restart after merge.

Acceptance: every surface in the goal reads the catalog through the
per-identity translator; agents and API errors unchanged (a test proves
each); no finished English left in the listed server files for a known
user (grep in the report); catalog test green; server suites green; the
report lists the before/after of any server line whose bytes changed for
English (there should be none beyond the storage report's number and time
formatting).

Rulings during the S7 plan gate (2026-09-06): the pre-sign-in HTML pages
in `server/auth-middleware.ts` (first-time claim, invite accept, login)
are OUT of S7: they need Accept-Language negotiation before any identity
exists, a mechanism decision of its own; ruling 5's pre-sign-in promise is
therefore undelivered at loop close and S8 files the follow-up. The
welcome agents' prompt is agent-facing and out. Corrected controls:
`shared/update-notice.ts` has no server caller (the builder takes a
translator, nothing moves between tiers); `humanizeSchedule` stays, its
only caller is the cron-run system prompt (frozen agent text);
`format-human.ts` keeps `formatSize` for the agent-facing attachment
prompt and loses `formatRelativeTime` with the storage report; the storage
report reuses S6's category key table. For Nil at close: server text is
resolved at write time and broadcast, so in a multi-boss office a Spanish
boss's `/clear` writes Spanish into a log an English boss reads; the
durable fix is a log entry carrying `{messageKey, params}` worded by each
client, a log-schema change beyond this loop.

Ruled during S7 round 2 (2026-09-06): `server/backend-failure-text.ts`'s
Isomux-authored sentences (SIGTERM, SIGKILL, signal, recovery) and
agent-manager's "Agent stopped: {status}." fallback are in S7 and resolve
per user; the raw classification, metadata and unknown-error pass-through
stay byte-identical.

Decide with reviewer: the resolver's name and home, key layout for
commands and choices.
Locked: rulings 1, 2, 6, 7, 11, 12, 15-19; the no-server-change prohibition
is lifted for S7 only; no UI copy changes beyond what the update notice
move requires; never restart the server.

- [x] S7 landed as 3f7854a (+ format 5ed18e2). `server/i18n.ts` resolver
  (translatorForUsername for the chat path, translatorForUserId for the
  owner fallback; agents English), `shared/i18n/command-keys.ts`, 91
  command descriptions and every response, lifecycle log entries, choice
  cards, permission prompt, storage report, update notice, backend failure
  sentences. 1,406 keys per language. Bundle +88438 bytes. English bytes
  changed on one surface only: the storage report's ages (round vs floor at
  the minute and hour; the day bucket opens at 48 h), and the old date calls
  used the server's system locale (en-US on this box). Conventions: server
  state that outlives a render holds a language-independent identity;
  id-to-key tables use own-property lookup (`keyFrom`). No signed-in
  onboarding prose exists. Ruling 5's pre-sign-in promise was outstanding
  here and S9 delivered it (task 852694dc). Deliberately English: the
  unknown-error pass-through in
  `humanizeBackendFailure`, `formatSize` for the attachment prompt.

## PICKUP S8 - sweep and loop close (Worker 2 / Reviewer 2)

Goal: nothing a boss reads in the office is left in English by accident;
ruling 20 delivered; the demo shows a translated chrome; the docs lines
proposed for Nil; the loop ready to close.

Mechanics:

- Ruling 20 first: a weekday-bearing shape in `shared/i18n/time.ts`
  (Intl weekday short, day, month short, 24-hour clock) whose English
  pins to "Sat 1 Aug, 09:00"; `SubscriptionPill` uses it; unit test on
  en/es/ca.
- The sweep: for every file under `ui/` and the S7 server files, the
  acceptance grep of S2 (JSX text, `title=`, `aria-label=`,
  `placeholder=`, template literals, and, for the server, the log-writer
  method as S7 learned) lists every remaining English literal. Each one is
  either converted, or listed in the report under one of: proper noun or
  code (ruling 11), agent-facing (frozen), API error (ruling 2),
  deliberately English (S7's two), or persisted data. Nothing is left
  unlisted.
- Catalog hygiene: the S6 curly apostrophe in `schedules.nextRunIn` to
  straight; the two bare ">" values (`cards.diff.reasonUntracked`,
  `cards.diff.summaryOnly`) stay as English bytes (ruling 6) and the
  catalog test's comment names them as the allowed exception; any key
  with no remaining caller is deleted (grep each namespace).
- Demo: `bun run build:demo`, then the demo bundle in headless Chrome
  (internal-docs/ui-verification.md) with the demo user put on `ca`: the
  office, the settings page and one dialog read Catalan; screenshot paths
  in the report.
- Docs, proposed not written (Nil's copy): one line for
  `docs/features.md` and one for the README and landing feature list per
  `internal-docs/documentation.md` (landing wins; sync the README to it)
  saying the office reads in English, Spanish and Catalan per user
  preference; the `docs/features.md` voice-to-text bullet stays.
  `internal-docs/documentation.md` already names the command surface (S7).
- The parked English strings are NOT changed (Nil's call); the report
  repeats them with the proposed text in one list: `preferences.intro`
  ("My devices"), `preferences.languageHint` ("stays in English for now"
  is now false), "Individual Connections" capital C,
  `apiCall.memory.saveOffice` ("Save a office memory"), `common.loading`
  vs `common.loadingDots`.
- Tests: the whole `ui/` DOM family and the S7 server suites green;
  `bunx tsc --noEmit` once.

Acceptance: ruling 20 landed with its test; the sweep report has zero
unlisted English literals; catalog test green with no orphan keys; demo
screenshots in Catalan; proposed docs lines verbatim in the report;
bundle delta reported.

Ruled during the S8 plan gate (2026-09-06): eight Isomux-authored system
log writes in `server/agent-manager.ts` (editor not found / not a file /
binary / too large; read-file not found / not a file / too large; diff not
a repository) are in S8 through `logWords`, with one scoped language test
per family; the no-server-edit rule is lifted for those lines only. The
login instructions (the fallback at agent-manager.ts:410 and the
per-adapter `getLoginInstructions`) are out: cross-adapter scope, filed as
a follow-up at close.

Decide with reviewer: the sweep's grep commands (write them in the
report so the next loop reuses them), the orphan-key method.
Locked: every ruling; no English wording change; no docs/ or site/ edit;
no server change beyond deleting orphan keys' callers if any.

- [x] S8 landed as e43bcd6. AST literal inventory (15,150 literals over
  120 ui/ files and 7 server files, scripts kept at /tmp/s8/), ruling 20
  (`weekdayDateTime`), eight agent-manager log writes through `logWords`,
  no orphan among 1,435 keys, demo verified in Catalan through the real
  picker. Bundle +5256 bytes. English formatting changes: subscription
  reset "Fri, Jan 2, 15:04"; sizes at 1 GiB read "1.0 GB"; "1,024.0 KB"
  gains its separator. Ruling 10 is proven by the harness exit code, not
  by whole-invocation clocks. For follow-up tasks at close: the login
  instructions (agent-manager.ts:410 and per-adapter getLoginInstructions);
  three thrown Errors that read as UI guidance (agent-manager.ts:1276-1298,
  :4579, :4596); `commands.*` keys read from non-command HTTP paths (move
  the shared ones to `systemEntries.*`); tracked `ui/index.js` looks dead;
  40 English values carried by more than one key. Docs lines proposed in
  the S8 report, for Nil.

## PICKUP S9 - the pre-sign-in office pages (Worker 1 / Reviewer 1)

Goal: a visitor whose browser prefers Spanish or Catalan reads the
first-time claim page, the invite-accept page and the login page in that
language, with no picker (ruling 5); everyone else reads English. Ruling
5 becomes delivered; task 852694dc closes with this slice.

Mechanics:

- Files: `server/auth-middleware.ts` (the three server-rendered HTML
  pages, their titles, headings, labels, buttons, errors and hints, and
  any inline script text they render), the shared catalogs, and the S7
  resolver in `server/i18n.ts`, which gains the pre-identity path.
- Negotiation: one pure function (`languageFromAcceptLanguage(header)`),
  beside `detectBrowserLanguage` in `shared/languages.ts`: parse the
  header with quality values, pick the highest-q language whose primary
  subtag is supported, English when nothing matches or the header is
  absent or malformed. Unit test on `es-ES`, `ca`, `en-GB`, `es;q=0.8,
  ca;q=0.9` (ca), `fr`, empty, garbage. The route uses it only when no
  identity exists; a signed-in user's stored preference still wins
  (ruling 8: this is the same resolver's pre-identity input, not a second
  resolver).
- The served HTML carries `lang="es"`/`"ca"`/`"en"` and the page's
  `<title>` is in the catalog. Pages keep working with no JavaScript.
- Keys: `preAuth.claim.*`, `preAuth.invite.*`, `preAuth.login.*`,
  `common.*` second-use rule. Product names, URLs and codes stay (ruling
  11). English bytes unchanged (ruling 6).
- Tests: the existing auth-middleware and access route tests stay green;
  new route tests request each of the three pages with `Accept-Language`
  set to `es`, `ca`, `en` and unset, asserting a literal anchor and the
  `lang` attribute per case; one test proves a signed-in Spanish user on
  the login route (if reachable) is not affected by an English header.
- Gates: the touched server suites and `shared/languages.test.ts`,
  eslint, `bunx tsc --noEmit` once; `build:ui` is not affected unless a
  shared file the bundle imports changes (it does: the catalogs), so run
  it.

Acceptance: three pages in three languages by header, tests per case,
`lang` attribute present, no picker, English bytes unchanged, resolver
unit test green. The report lists every string of the three pages in the
three languages (they are short) and anything a page renders that stayed
English with its category.

Ruled at the S9 plan gate (2026-09-06): renderInviteError,
renderInviteIdentityConflict and renderLockoutBlocked are in S9 (same
pre-sign-in surface, same file); the signed-in login test has no target
and is replaced by a test that a stored Spanish preference beats an
English Accept-Language header on the identity-conflict page.

Decide with reviewer: where the pages' HTML template functions take the
translator, the key layout.
Locked: every ruling; server edits limited to `server/auth-middleware.ts`,
`server/i18n.ts` and their tests; no UI change; never restart.

- [x] S9 landed as a90619c (+ format b1dee1d). Six pre-sign-in surfaces
  (claim, invite accept, login, invite error, identity conflict, sign-out
  blocked), `languageFromAcceptLanguage` in `shared/languages.ts`,
  `translatorForRequest` in `server/i18n.ts` (precedence in one function
  over an already-resolved identity), page templates take the translator
  first and write `<html lang>`. 40 keys per language (1,475 total).
  Bundle +10572 bytes. Sixty rendered English pages byte-identical to
  c6618dd (reusable check: /tmp/s9/reviewer-byte-check.ts). Ruling 5
  delivered; task 852694dc done. Parked for Nil: the claim and
  invite-accept intros differ by one character ("name; it'll" vs "name -
  it'll"); proposed the semicolon on both.

## PICKUP S10 - the landing and hosted pages (Worker 2 / Reviewer 2)

Goal: a visitor reads isomux.com and isomux.com/hosted in Spanish or
Catalan at their own paths, the three versions point at each other, and
the office sends a boss to the copy in their language. Docs, README,
developer API and legal pages stay English; the legal pages are the
governing text.

Mechanics:

- Files: `site/index.html` (1094 lines) and `site/hosted.html` (857)
  become `site/es/index.html`, `site/es/hosted.html`, `site/ca/index.html`,
  `site/ca/hosted.html`: full static copies with the same markup, styles
  and scripts, text translated, `lang` set, `<link rel="alternate"
  hreflang>` for en, es, ca and x-default on all six pages, and a small
  language switch (three links) in the same place on every page. The
  English files gain only the hreflang links and the switch (ruling 6).
- Links inside the Spanish and Catalan pages: docs and legal pages point
  at the English pages (they stay English); the hosted page carries one
  sentence saying the legal pages are in English and are the governing
  text, proposed for Nil in the report and written in es and ca only
  once he accepts the English (ruling 6 applies to the English copy).
- `vercel.json`: `cleanUrls` serves `/es/hosted`; verify the catch-all
  rewrite (the `/(.*)` source) does not swallow `/es/` and `/ca/`, and
  that the sitemap generator in `scripts/build-docs.ts` lists the new
  pages (or say why it should not).
- The office: `ui/office/Floor.tsx` opens `https://isomux.com` in two
  places; it opens `/es/` or `/ca/` for a boss on that language and the
  root for English. The developer-API link in `ApiTokensPane` stays
  English. `api/chat.ts` stays as it is.
- Translation: this copy is Nil's voice on the public site. Register per
  ruling 1, short and plain, product names and code untouched (ruling
  11). The report pastes every Spanish and Catalan sentence next to its
  English, page by page. The slice merges only on Nil's word.
- Checks: a small script (`scripts/site-i18n-check.ts`, plain bun test)
  proving the six pages agree on hreflang, that every relative link in
  the es and ca pages resolves to a file under `site/` or a docs path,
  and that the switch appears on all six; `bun run build:docs` still
  passes; `format:check` covers whatever it covers today (verify).
- `internal-docs/documentation.md`: sections 1 and 2 gain the rule that
  the Spanish and Catalan copies follow the English in the same commit.

Acceptance: six pages, hreflang and switch consistent, links resolve,
the office links a Spanish or Catalan boss to their copy (DOM test on
`Floor` or the helper that builds the URL), the check script green, the
report carries the full bilingual copy.

Ruled at the S10 plan gate (2026-09-06): the fixed client labels in
`site/chatbot.js` and `site/theme-toggle.js` are in S10, keyed on
`document.documentElement.lang`, English bytes preserved, `api/chat.ts`
untouched; the Vercel rewrite precedence for `/es/` and `/ca/` is settled
by a deployment check or provider evidence, not by a comment.

Decide with reviewer: where the switch sits, the URL helper's home, the
check script's shape.
Locked: every ruling; no docs/, README, legal or `api/chat.ts` change;
no server change.

## PICKUP S11 - the control plane web app (lane: whichever frees first)

Goal: a customer at cloud.isomux.com reads sign-in, sign-up, plan choice,
payment hand-off, the waiting-for-your-office page and the office page
in Spanish or Catalan when their browser prefers it, and the emails the
control plane sends them arrive in that language. Ops pages stay English.

Mechanics:

- Worktree with `--web` (`scripts/worktree-setup.sh <name> --web`);
  control-plane tests need the user unit `pg-local.service`
  (127.0.0.1:5433); the gate is `bun run ci:web` plus the touched
  control-plane suites.
- `control-plane/web` cannot import `shared/i18n`: it gets its own small
  copy of the pattern under `control-plane/web/lib/i18n/` (typed English
  catalog, `es` and `ca` as complete records, `translatorFor`,
  interpolation; no library, ruling 4), with the same completeness test.
- Locale: `Accept-Language` on the server side (Next request headers,
  reuse the S9 negotiator's logic, copied not imported), then a cookie
  set by a language switch on the pages, then the customer's stored
  language once one exists. Storing a language on the customer record is
  a Postgres schema change: settle with the reviewer whether it is worth
  it in this slice or whether the cookie carries it; the emails need a
  stored value to be reliable, so lean to storing it if the migration is
  small.
- Surfaces: `app/page.tsx` and `home-view.tsx`, `app/signin`,
  `app/signup`, `app/office` and the components they render (plan copy,
  policy notice, office view, progress), `layout.tsx` (`lang`); the
  Stripe checkout call passes `locale` for es and ca; the emails in
  `control-plane/` (find every subject and body; list each). `app/ops`
  stays English.
- Copy: register per ruling 1; product names, plan names and prices
  untouched (ruling 11); English bytes unchanged (ruling 6). The emails
  and the policy notice go out under Nil's name: the report pastes them
  verbatim in the three languages, and the slice merges only on his word
  for those; the page chrome he reads live.
- Tests: the existing `home-view.test.tsx` and `office-view.test.tsx`
  stay green (English, no header); new render tests for the sign-up page
  and the office page under `es` and `ca`; a test that the first paint
  of the landing shell keeps its exact English bytes; one email
  rendering test per language.

Acceptance: the named pages and emails in three languages by header,
cookie or stored value in that precedence; `bun run ci:web` green; the
control-plane suites green against pg-local; the report carries the
emails and the policy notice verbatim in three languages and lists any
customer-facing text left English with its category.

Decide with reviewer: the stored-language migration, the switch's place,
the catalog module layout.
Locked: every ruling; no change to `docs/`, `site/` legal pages or the
office server; ops pages English.
