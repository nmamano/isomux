# Headless-Chrome UI verification recipes

Consolidated from Isomux room memory, 2026-08-22. DOM render tests (see
internal-docs/testing-guide.md) cover wiring; what a surface looks like is
verified with headless Chrome.

## Demo-bundle route

Build both demo bundles with `bun run build:demo`. It runs separate production
builds for `ui/demo-entry.tsx` and `ui/demo-app-entry.tsx` WITHOUT `--splitting`
(with it the office silently never mounts), and writes
`/demo/demo-entry.js` and `/demo/demo-app-entry.js`. `demoApi` THROWS on
unmapped routes, so a new endpoint needs a demo arm. Drive a /tmp COPY of the
demo output served over HTTP - `file://` blocks ES modules (CORS) - with an
injected `?goto=` driver.

Custom-harness route over CDP: import the global stylesheet (ui/styles.ts) or
box-sizing/theme vars are silently wrong; headless Chrome ignores
`--window-size`, use `Emulation.setDeviceMetricsOverride`. Delete harness
files before committing.

## Loading state

`bash scripts/loading-check.sh <out-dir under /tmp> [--phone] [--light]
[--root <css>] [--name <name>] [-- <selector to click>...]` shows a view of
the demo while its data is held, then loaded, and lists what jumped. With no
selectors the demo is held from boot (the office state and every fetch); with
selectors, the hold starts before the last click, the one that opens the view.
`ui/demo-hold.ts` holds every answer of the demo server until release.

The report names each element that moved or changed size relative to its
parent, and each new element in space no removed placeholder held. Elements
that still change after load (timers, animations) are left out. It writes
`loading-<name>.png` (Loading and Loaded, a red box on each jump) for the
sign-off packet. Exit 0: no jump; 1: jumps; 2: the check failed. A view whose
data the demo does not serve needs a demo arm first. It needs Google Chrome
and playwright-core: `--playwright <path to playwright-core/index.mjs>`, else
the bare `playwright-core` package, else the path in the script.

## Demo-bundle dialog testing

The demo drives the REAL EditAgentDialog: click a desk sprite (the nameplate
is NOT clickable) to open the log view, then the agent's name in the header
opens Settings drilled into the agent. It shows one part at a time: click
`button[data-settings-part="<id>"]` (general, access, instructions,
engine), then find a field inside its section class (`.agent-engine-section`
and so on) rather than by DOM order. A room and a member drill in the same
way; the open part's fields are in `[data-settings-part-body="<id>"]`. A new agent's form is still a dialog
(click an empty desk). Layout is viewport-dependent - fix the viewport before
hardcoding any coordinate. An A/B "before" bundle builds
straight from the main checkout with `--outdir /tmp` (non-mutating).

## From a worktree

Create a ready worktree from the main checkout with `scripts/worktree-setup.sh <name>`; it installs the control-plane/web dependencies too, which root tsc needs. Remove one, or a leftover folder git no longer lists, with `scripts/worktree-remove.sh <name> [--force]`. isomux itself does not
depend on playwright-core; import it from another project's node_modules
(e.g. `~/nil/wallgame/node_modules/playwright-core/index.mjs`) with
`chromium.launch({channel:"chrome"})` - /usr/bin/google-chrome is installed,
no browser download needed. Serve the demo bundle from a dir whose /demo/
path matches demo.html's absolute /demo/demo-entry.js refs. Do not pkill by
name pattern to stop the static server - the safety hook blocks it; keep the
PID (`$!`) and kill that. The standalone fixture is served at
`/demo/app?name=<fixture-name>`. (Verified 2026-08-24, task 539d1d7d.)

## Tooltips and accessibility

Native title tooltips never render in headless screenshots - hover the exact
painted target and assert its non-ignored accessibility description via CDP
`Accessibility.getPartialAXTree` instead (found by Worker 2/Reviewer 2, task
9b2f4316).

## Isolating what paints an artifact

When a screenshot shows something wrong but the source does not say which
element draws it, measure instead of reading. Set one group's `style.display`
to `none` in the live page, screenshot the SAME clip with and without it, and
diff the two: what changes is exactly that group's painted footprint, which
you can then compare against the geometry it is supposed to follow. Amplify
the per-pixel delta (multiply it, clamp to 255) so contributions under one
unit still show.

It answers both directions of the question. In the visual-wall lane it found
a leak - a jar's shaded face ended a unit below the body's bottom curve, so it
hung out under the base as a thin tab - which reading the source would not
have caught, because that face's own numbers look reasonable until you compare
them against the curve beside them. It also DISPROVED one: a contact shadow
looked like it ran past the window ledge onto the wall, and the footprint
measured inside the ledge everywhere. The darker band under it was the sill's
own fill.

Three things to control first. Call `svg.pauseAnimations()` before both shots
or SMIL - twinkling stars, drifting petals, the cat's tail - makes the diff
noisy. `deviceScaleFactor` sets the measurement resolution, so raise it when
the defect is a unit or less; at 1 a one-unit leak is one pixel and rounds
away. Keep the clip off the floating nameplates and the live ghost, which
animate independently of the scene SVG. (visual-wall lane, 2026-09-05.)

## User-scoped panes

An agent token gets 403 on `/api/me/*`, so the Settings and Integrations panes
of a member need a member session. Two ways:

- **Scratch office.** Boot the worktree's server on a spare port with its own
  state: `PORT=<port> ISOMUX_HOME=/tmp/t-<task8>/office
  ISOMUX_BACKUP_DIR=/tmp/t-<task8>/backups HOME=/tmp/t-<task8>/home bun run
  server/isomux-office.ts`. Claim the owner through the setup link it prints,
  then drive it in headless Chrome. This reproduces a code defect, not one
  that needs the real office's data. (Isomux Worker 2, 2026-10-19, task
  2a3b5645.)
- **The real office.** The member offers a Chrome tab that shows the office
  (Browser Use). Browser control refuses an office page in a tab offered on
  another site, so the member must offer the office tab itself.
