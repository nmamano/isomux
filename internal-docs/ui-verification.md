# Headless-Chrome UI verification recipes

Consolidated from Isomux room memory, 2026-08-22. The repo has no DOM test
harness, so UI changes are verified with headless Chrome. Five proven recipes.

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

## Demo-bundle dialog testing

The demo drives the REAL EditAgentDialog: click a desk sprite (the nameplate
is NOT clickable) to open the log view, then the "Agent" header button opens
Edit Agent. Fields are inputs/textareas 2..6 in global DOM order (0/1 are
office search + chat composer). Layout is viewport-dependent - fix the
viewport before hardcoding any coordinate. An A/B "before" bundle builds
straight from the main checkout with `--outdir /tmp` (non-mutating).

## From a worktree

Create a ready worktree from the main checkout with `scripts/worktree-setup.sh <name> [--web]`; use `--web` for control-plane/web work. isomux itself does not
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
