# Control-plane styling slice (standing orders)

Single-slice loop, authorized by Nil 2026-08-10 ("style should follow
the isomux landing page"). Conventions identical to the prior
control-plane loops (`git show b1213a9:internal-docs/control-plane-ui-loop.md`
for process, gates, rails, and the harness-crash caveat). Delete this
file at close.

## The one ruling

The control-plane web app's visual design follows the ISOMUX LANDING
PAGE's look (site/ - its typography, palette, spacing, component
feel). Not a new design system; the landing is the reference. Where
the landing has no answer (tables, forms, status colors), extend in
its spirit and flag the extension in the report.

## Rails (delta from the prior loop; everything else inherited)

- MECHANICS ARE FROZEN: no changes to routes, services, copy strings,
  data-testids, timelines, or anything under control-plane/ outside
  web/ presentation files. The e2e transcripts and unit tests must
  pass UNCHANGED (string-equality assertions included) - styling that
  needs a copy change is a finding to flag, not an edit to make.
- No new runtime dependencies without flagging at the plan gate (CSS
  approach: prefer what Next supports natively - CSS modules or a
  single global stylesheet; no UI framework).
- No deploys, no real-box work, no Stripe calls, no provider calls.
  This slice needs no box and spends nothing.
- Accessibility floor: honest focus states, readable contrast, the
  attention banner distinguishable without color alone.
- iOS glyph caveat (office memory): no bare Unicode glyphs that
  iOS emoji-renders (▶ ★ etc.) - use SVG or CSS.

## Review shape

Screenshot-driven: the diff gate includes full-page screenshots of all
five surfaces (sign-in, home, signup, office in its main states, ops
floor) at desktop and phone widths, produced by a checked-in-then-
deleted harness or the existing e2e server pattern. Reviewer2 verifies
the screenshots come from the announced fingerprint, checks the
landing-page fidelity claim against site/ directly, and runs the
unchanged e2e/unit suites. Nil judges the final screenshots by eye at
close - the manager forwards them with the report.

## PICKUP: the styling slice (Isomuxer2 / Reviewer2)

Goal: the five surfaces styled to read as the same product as the
isomux landing page, mechanics untouched, suites green unchanged.

Acceptance:
1. Screenshots of every surface/state at 1280px and 390px widths.
2. `bun test control-plane` and the lifecycle/handoff-local e2e runs
   pass with zero assertion edits.
3. Repo CI green (ci:web included).
4. A short fidelity note: which landing tokens (colors, fonts,
   spacing) were reused, what was extended and why.

Decide with the reviewer: CSS mechanism, shared layout components,
how status/attention colors map onto the landing palette.

## Slice checklist

- [ ] Styling slice (Isomuxer2 / Reviewer2)
