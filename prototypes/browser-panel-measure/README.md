# Archived Server browser measurements

The Server browser and remote panel were retired on 2026-09-20. The runnable probes were removed with their runtime. The evidence files below are historical measurements, not current behavior.

# Browser panel repair measurements (2026-09-16)

Run from the worktree root, under `systemd-run --user --scope -p MemoryMax=2G`.
No authenticated pages are used. `dpr.ts` and `panel-check.ts` use temporary
profile roots. `benchmark.ts`, `panel.tsx` and `bridge.cjs` reuse the round-3
instrument from branch `browser-stream`; the import/output paths changed,
and an optional final target screenshot was added outside the timing window.
No branch merge was used.

- `MODE=jpeg PAGE=ordinary BENCH_CLICKS=25 BENCH_RUN=before-clicks bun prototypes/browser-panel-measure/benchmark.ts`
- Same command after the repair, with `BENCH_RUN=after-clicks`.
- `LABEL=before bun prototypes/browser-panel-measure/dpr.ts`, then `LABEL=after`.
- `bun prototypes/browser-panel-measure/panel-check.ts` exercises the production
  panel with a real DPR-2 Chrome viewer and real mouse clicks, across resize,
  navigation and scroll. It also checks wheel distance, 50 move events,
  watcher departure, and CSS-resolution agent screenshots.

Save stdout/stderr to `evidence/<run>.txt`; append the process exit code.
The click instrument counts from viewer input send to the draw containing
changed marker pixels. It first scrolls/inserts text and waits 100 ms, then
clicks the fixed black/white marker. Each failed trial times out at 2 seconds
and resets capture; successful trials do not reset it. Per-trial `captured`
and `received` counts distinguish silence from stale images. Latency
percentiles describe successes only. This is a shared-host loopback test,
not a WAN or phone performance claim.

DPR uses a 390x700 CSS viewport, a DPR-2 request with fixed 780x1400 capture
bounds, then resizes the page to 400x680 with those bounds unchanged. JPEG
SOF headers give delivered dimensions; frame metadata remains CSS geometry.
The before arm also records a raw CDP DPR/bounds-only probe. It is a diagnostic,
not production behavior. `panel-check.ts` additionally exercises fresh bounds
from ResizeObserver after a real panel resize.

Generated profiles, scratch probes, CSVs and development logs are ignored.
The evidence tables and implementation notes are in
`internal-docs/browser-panel-0916.md`.

`transitions.ts` measures time to the first correctly sized JPEG after DPR
join, CSS resize, and DPR departure, with a remaining DPR-1 watcher.
`mutants.py` runs the five named regression mutations and restores the source;
run it in the same 2 GiB scope. The real panel check loads production office
CSS, without the external font import. The round-3 latency instrument keeps
its original unstyled panel so its before/after method is unchanged.

Round 2 follows the PM sharp-frame ruling. Set `DPR=1` or `DPR=2` for the
same 25-trial benchmark. The default remains 1; at DPR 2 physical bounds are
doubled and capped at 2560. `captureSources` counts delivered images matched
to raw stream events versus stills. `DPR=1.5 bun .../panel-check.ts` checks
the fractional real-panel path. `agent-check.ts` checks selector/hover/mouse,
screenshot/input races, page-only repaint, and world reuse at DPR 1.5 and 2.
The additional scale-override mutant runs that real-browser check.

The rejected override and screenshot alternatives are reproducible with
`override-probe.ts`, `capture-options.ts`, and `clip-probe.ts`. They use local
fixtures, never office state. Retained round-1 evidence is historical; the
round-2 hand-off report names hash-prefixed logs produced on the exact final
commit, including final gates and all eight mutants.

Set `PANEL_EVIDENCE_DIR` to an existing output directory to keep a final panel
measurement separate from the committed sample images.
