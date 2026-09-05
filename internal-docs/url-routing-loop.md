# URL routing loop (standing orders)

Slice loop authorized by Nil 2026-09-05 (tasks 5769e5d3 and b14b2124). Lane:
Isomux Worker 2 / Isomux Reviewer 2, worktree `url-routing` (persistent for
the loop, rebased on main at every slice start). The worker re-reads this
whole file at every slice. Delete this file at loop close.

North star: the full-page views of the office UI (tasks, cronjobs, apps,
settings) are real URLs: `/tasks`, `/cronjobs`, `/apps`, `/settings`. A
link can be shared and opens that page; reload keeps the page; the browser's
back and forward buttons step through pages the way they do on any site.
The office stays at `/`. Everything else about the SPA (websocket, saved
spot, drafts, the chat-over-office model) stays as it is.

Today (as of 101414e): `ui/App.tsx` keeps four booleans (`tasksOpen`,
`cronjobsOpen`, `appsOpen`, `usersOpen`) plus `settingsTarget`, pushes ONE
history entry when any page is "deep" (`isDeep`, ~line 521) and clears
everything on popstate (~line 541). The saved spot lives in
`ui/view-persistence.ts` (`SavedPanel`, with `users` kept as an alias of
`settings`). The server already serves `index.html` for any unknown path
(`server/isomux-office.ts` ~5364), so no server change is needed; check
`ui/demo-server.ts` does the same for the demo.

## Rulings (final)

1. Test runtime is the constraint (Nil). DOM tests exist only for the
   routing and dirty-check flows. Hard cap: 5 s wall-clock per test file,
   asserted in the file itself (a timer around the suite, or bun's
   per-test timeout set to fail, not just warn). No browser in ci.
2. The harness is happy-dom plus @testing-library/react as devDependencies;
   registration is per test file through one helper
   (`ui/test-support/dom.ts`), never through the global bunfig preload,
   which serves the server suite.
3. Routes: `/tasks`, `/cronjobs`, `/apps`, `/settings`. `/users` is
   accepted and rewritten to `/settings` (mirror of the persistence alias).
   Settings sections and agent chats are NOT routes in this loop; both are
   parked for Nil with a note on what they would take.
4. Precedence on load: a page path in the URL wins over the saved spot for
   the PAGE; the saved spot still supplies room and agent. `/` uses the
   saved spot as today.
5. History model: one entry per page change, pushed with the real path;
   back from a page returns to where the user came from (chat or office),
   as today. The saved-spot write keeps happening as today.
6. Route parsing and formatting is a pure module (`ui/routes.ts`) with
   plain unit tests; the DOM tests cover App wiring only.
7. No change to the log view, the settings page internals, the mobile
   layout, or the hosted-office proxy path.
8. R-2026-09-05-3 (deep link with no office entry underneath; ruled on
   Reviewer 2's S2 escalation). No synthetic history entries, ever: a
   `/tasks` link opened in a new tab is one entry, `replaceState`d to
   carry its page, and the browser's Back leaves the site as on any site.
   The in-app return controls (Close, Escape, the office button) must
   still work: on an entry the app did not push, `goHome()` replaces the
   current entry with the office (`replaceState({ isomux: true, page:
   null }, "", "/")`) and resets the page state, instead of calling
   `history.back()`. Loading `/` with a saved panel keeps today's model
   (the page is opened on top of the load entry, so Back returns to the
   office). Mechanism (worker+reviewer settle): the boot must mark the
   entry as app-owned-but-not-pushed so the sync effect adds no duplicate
   entry and `goHome()` takes the replace path; a tri-state ref or a
   second ref both qualify.

## Gates (every hand-off)

Every gate log starts with `git rev-parse HEAD` and is produced after the
commit under review.

    bash -c 'systemd-run --user --scope -p MemoryMax=2G bun test <touched suites> > /tmp/ur-lane.log 2>&1; echo exit=$? >> /tmp/ur-lane.log'
    bunx eslint <touched files>
    bun run build:ui
    bun run build:demo      # when ui/demo-server.ts is touched
    bunx tsc --noEmit       # once, before the final hand-off of each slice

Never a bare `bun test`. Never prettier. Report every test file's wall-clock
from the log in the hand-off.

## Prohibitions

- No new runtime dependency (only devDependencies for the harness).
- No router library.
- No change to `server/`.
- No `git stash`, no rebase while the reviewer holds the token.

## Decision protocol

Worker+reviewer settle: helper API, test names, how App exposes state for
tests. Manager settles: rulings, slice order, a runtime over the cap.
PARKED FOR NIL: any new route beyond ruling 3, any visible copy, the
PWA `start_url` if it turns out to matter.

## Slice checklist (per slice)

1. `git rebase main`; gates green on the rebased base.
2. Plan-gate with the reviewer.
3. Implement; gates; commit; hand the token with the hash.
4. Iterate to approval; final `bunx tsc --noEmit`.
5. Report to the PM: what changed, verification, approved hash, per-file
   test runtimes, parked items.

## Slice cut

- S1: harness. devDependencies, `ui/test-support/dom.ts`, one proving test
  that renders a small existing component (pick one with no websocket
  dependency) and one that mounts `App` far enough to assert the current
  popstate behaviour (if App cannot mount without a socket, the proving
  test documents the seam S2 must add, and the App test moves to S2).
  Doc: a short section in `internal-docs/testing-guide.md`.
- S2: `ui/routes.ts` (parse/format, alias), App reads the path on boot and
  writes real paths on push/replace; popstate restores the page from the
  entry's path instead of clearing everything. DOM tests: open page,
  back, forward, reload-on-path, `/users` alias.
- S3: dirty-check flows (settings with unsaved edits, the cronjob dialog)
  under back/forward; demo server fallback; doc surfaces per
  `internal-docs/documentation.md`; `docs/features.md` line proposed for
  Nil, not written.

## PICKUP S1 - render-test harness (Worker 2 / Reviewer 2)

Goal: `bun test ui/test-support/dom.test.ts` (or the chosen names) proves a
React component renders in happy-dom under 5 s, and the seam for testing
App's history behaviour is known.

Mechanics:
- `bun add -d happy-dom @testing-library/react` in the worktree; the
  lockfile change is part of the slice. Report the versions.
- `ui/test-support/dom.ts` registers happy-dom's global registrator on
  import and exports a `cleanup` for `afterEach`. The server preload in
  `bunfig.toml` must stay untouched; verify a server test file still runs
  without a DOM (`bun test server/test-support/harness.test.ts`).
- The proving component test: choose from `ui/components/` something with
  no socket or store dependency (AppsView has a test already; read how it
  is tested today and pick a component that is pure props).
- The App seam: read `ui/App.tsx` from the top and write down what App
  needs to mount (socket, store, session context). If a fake of those is
  under ~60 lines, add it and one test that pushes tasks open and asserts
  the history entry and popstate reset. If not, write the seam plan into
  the report and stop there.
- Runtime cap: put `performance.now()` around the file and fail if over
  5000 ms, or use bun's `--timeout` in the documented command; both are
  acceptable, pick one and use it in every DOM test file.

Acceptance: harness files, one green component test, either an App test or
a written seam plan; per-file runtime in the hand-off; server suites
unaffected; `internal-docs/testing-guide.md` has the DOM-test section.

Decide with reviewer: file names, cleanup strategy, the App seam.
Locked: rulings 1, 2; no routing code in S1.

- [x] S1 landed as e8f74b5 (harness: happy-dom 20.14.0, its global registrator, @testing-library/react 16.3.3; App mounts bare with the store's default contexts, so S2 drives the real App with no fake; a warm App render is ~275 ms, measured 2026-09-05).

## PICKUP S2 - real paths for the four pages (Worker 2 / Reviewer 2)

Goal: `/tasks`, `/cronjobs`, `/apps`, `/settings` open their page on load,
show in the address bar when opened from the office, and back/forward
step between them and the office the way they do on any site. `/users`
opens settings at `/settings`.

Mechanics:
- `ui/routes.ts`, pure: `pageForPath(pathname)` returning one of the four
  page names or null (office), with `/users` mapping to settings and
  trailing slashes tolerated; `pathForPage(page | null)` returning the
  path (`/` for null). Plain unit tests in `ui/routes.test.ts`, no DOM.
- App wiring (`ui/App.tsx`): keep ruling 5's one-entry-per-page-change
  model. Where App pushes or replaces the `{ isomux: true }` entry today
  (~line 529), carry the page in the entry state and the real path as
  the third argument: `pushState({ isomux: true, page }, "", path)`.
  On popstate, restore the page from the entry (state.page, falling back
  to `pageForPath(location.pathname)`) instead of clearing every page
  flag; an entry with no page is the office, or the chat when focus is
  set, exactly as the tasks-over-chat branch works today. Agent chats are
  not routes: a chat entry keeps path `/`.
- Boot: after the saved-spot restore has supplied room and agent, read
  `pageForPath(location.pathname)`; a page wins over the saved panel
  (ruling 4) and is opened with `replaceState` so the first entry carries
  its state; `/users` is rewritten to `/settings` with replaceState. On
  `/`, a saved panel opens as today and the URL is replaced to its path
  so the address bar and the view agree.
- Every "return to office" path still goes through `goHome()` and
  `history.back()`, as today.
- Trap, check it from the artifact: a reload on `/tasks` is served
  `index.html` by the office server (`server/isomux-office.ts` ~5364, the
  unknown-path fallback), so the bundle must be referenced by an
  ABSOLUTE path. Open `ui/dist/index.html` after `bun run build:ui` and
  paste the script and stylesheet tags in the hand-off; a relative
  `src` is a bug S2 must fix in `ui/index.html` or the build script.
  The demo server's fallback is S3, not this slice.
- DOM tests (extend `ui/App.dom.test.tsx` or add a second file, both
  under the 5 s cap): open each page from the office and assert
  `location.pathname` and the entry state; back returns to `/`; forward
  reopens the page; mounting App at `/tasks` opens tasks; mounting at
  `/users` ends at `/settings`; tasks opened over a chat, then back,
  lands on the chat with path `/`.
- View persistence is untouched except for the boot precedence above.

Acceptance: routes unit tests plus the DOM cases above, per-file runtimes
in the hand-off; `bun run build:ui` green and the index.html tag check
pasted; the existing ui suites green; `bunx tsc --noEmit` before the
final hand-off; no change under `server/` or to `ui/demo-server.ts`.

Decide with reviewer: the exact entry-state shape; whether the boot page
opens before or after the first full_state arrives (it must not fight
the saved-spot restore).
Locked: rulings 3, 4, 5; no new routes; no visible copy.

- [x] S2 landed as 608c65e (ui/routes.ts; entry carries page + path; tri-state ownership ref for ruling 8; bundle refs absolute in index.html; demo entry passes routing off, so the public demo never pushes paths; four App DOM files, worst in-file clock 2.9 s at load 16.8).
## PICKUP S3 - dirty-check flows under the new history, and the doc surfaces (Worker 2 / Reviewer 2)

Goal: the two unsaved-edit guards keep working with real paths, their
behaviour under Back is pinned and reported, and every doc surface that
describes the pages knows they are URLs. The loop closes after this
slice.

Mechanics:
- The guards, as they exist today: `ui/components/TaskView.tsx` (the edit
  panel's dirty/discard flow, `confirmDiscard`, Escape routed through it)
  and `ui/components/UserSettingsView.tsx` (the unsaved-changes guard that
  captures Escape so App's `goHome` never sees it while edits are
  pending). Read both before writing a test.
- DOM tests, one new file under the 5 s cap (`ui/App.dirty.dom.test.tsx`
  or similar), each case named for the flow: (1) Escape in a dirty task
  edit panel on `/tasks` shows the discard prompt and stays on `/tasks`;
  (2) Escape in dirty settings on `/settings` shows its prompt and does
  not leave the page; (3) Back (popstate) from `/tasks` with a dirty edit
  panel: PIN WHAT HAPPENS TODAY, whatever it is (the page closes and the
  edits are dropped without a prompt, or the prompt appears); do not
  change it. Write the observed behaviour into the loop file's S3 note
  and into the report as a question for Nil, with a recommendation
  (the browser's own model: Back discards, as on any site without a
  beforeunload guard; or intercept: re-push the consumed entry and show
  the discard prompt). Ruling 8's "no synthetic entries" covers boot,
  not a cancelled Back; still, no interception lands in this loop.
  (4) The S2-parked case: a cold `/tasks` whose saved spot restores an
  agent, closed to that chat at `/`, then the next in-app return replaces
  to the office.
- Demo: routing is off in the demo entry, so the demo server needs no
  fallback; state that in the loop file's S3 note and leave
  `ui/demo-server.ts` alone.
- PWA: `ui/manifest.json` has `start_url: "/"`; check whether a service
  worker or install flow references paths (grep serviceWorker, manifest)
  and report; change nothing unless a real path breaks it.
- Doc surfaces: walk `internal-docs/documentation.md` and update every
  surface that describes opening the task board, cron jobs, apps or
  settings as an in-app state where a URL now applies (README, docs/*,
  the agent-facing system prompt if it tells agents how to link to the
  board, in-app help strings). The `docs/features.md` line is PROPOSED in
  the report in Nil's voice, not written. List every touched surface in
  the report with the old and new sentence.
- Loop close: the worker does not delete the loop file; the PM does.

Acceptance: the four DOM cases green with their mutants named (drop the
guard's Escape capture; drop the adopted-entry replace); per-file
runtimes in the hand-off; the S1/S2 suites green; build:ui, build:demo
(if demo files are touched), eslint on touched files, `bunx tsc
--noEmit` before the final hand-off; doc surfaces listed with before and
after text.

Decide with reviewer: test-file split; how to drive a dirty edit panel
in happy-dom.
Locked: rulings 1-8; no interception of Back; no new routes; no visible
copy written (proposed only).

### S3 notes (worker, 2026-09-05)

Back with unsaved edits, as it behaves TODAY - measured on the task board's
create panel, opened dirty from the quick-add row. `history.back()` closes the
page, returns the URL to `/`, and drops the edits with no prompt. Nothing in
`ui/` listens to popstate except `App`, so the panel simply unmounts. Pinned in
`ui/App.dirty.dom.test.tsx` and deliberately unchanged.

What reload does is NOT the same for the two forms, which is what decides the
question for Nil. `UserSettingsView` installs a `beforeunload` guard around the
same `isDirty()` the tested pane uses (`ui/components/UserSettingsView.tsx:1139`),
as do `EditAgentDialog`, `CronjobDialog` and `ExternalAccessPane`. `TaskView`
does not. So today: settings warns on reload and goes silently on Back, and the
task panel goes silently on both. Settings is the inconsistent one, and that is
an argument for a guard rather than against it.

A future unified guard needs BOTH mechanisms, not one. `beforeunload` does not
fire on same-document history traversal between pushState entries, so it cannot
cover Back; and intercepting Back cannot cover a reload or a closed tab. The
shape would be a `beforeunload` on `TaskView` plus a cancelled-dirty-Back path
for both forms. None of it is implemented in this loop; it wants its own ruling.

Demo: routing is off in `ui/demo-entry.tsx`, so the demo never writes a page
path and `ui/demo-server.ts` needs no unknown-path fallback. Left untouched.

PWA: `ui/manifest.json` has `start_url: "/"` and `scope: "/"`. The scope covers
the four new paths, and `start_url` opening the office is what an installed app
should do. `ui/sw.js` is a two-line no-op with no caching and no path
references. Nothing changed.

- [ ] S3 landed (hash, note)

