# Headless-Chrome UI verification recipes

Consolidated from Isomux room memory, 2026-08-22. The repo has no DOM test
harness, so UI changes are verified with headless Chrome. Four proven recipes.

## Demo-bundle route

Build the demo bundle with `bun build ui/demo-entry.tsx` WITHOUT `--splitting`
(with it the app silently never mounts). `demoApi` THROWS on unmapped routes,
so a new endpoint needs a demo arm. Drive a /tmp COPY of demo.html served over
HTTP - `file://` blocks the ES module (CORS) - with an injected `?goto=`
driver.

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

A fresh worktree has no node_modules - run `bun install --frozen-lockfile` in
it first or every build fails on react/jsx-runtime. isomux itself does not
depend on playwright-core; import it from another project's node_modules
(e.g. `~/nil/wallgame/node_modules/playwright-core/index.mjs`) with
`chromium.launch({channel:"chrome"})` - /usr/bin/google-chrome is installed,
no browser download needed. Serve the demo bundle from a dir whose /demo/
path matches demo.html's absolute /demo/demo-entry.js refs. Do not pkill by
name pattern to stop the static server - the safety hook blocks it; keep the
PID (`$!`) and kill that. (Verified 2026-08-10, task 0448b11e.)

## Tooltips and accessibility

Native title tooltips never render in headless screenshots - hover the exact
painted target and assert its non-ignored accessibility description via CDP
`Accessibility.getPartialAXTree` instead (found by Worker 2/Reviewer 2, task
9b2f4316).
