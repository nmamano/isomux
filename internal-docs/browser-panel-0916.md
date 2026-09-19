# Browser panel still frames and DPR (2026-09-16)

Historical design and evidence. The Server browser and remote panel were retired on 2026-09-20. Current Chrome control and migration: [browser-extension.md](browser-extension.md). Server screenshot previews remain supported.

This repair addresses the quiet-page frame loss and CSS-resolution capture
reported by the browser-stream design lane. Measurements and commands live in
[the local harness](../prototypes/browser-panel-measure/README.md).

## Behavior (revised after review)

DPR 1 keeps the original every-second-frame screencast with no emulation
commands. After human input, a still crosses a two-animation-frame paint
barrier in an isolated world. There is no fixed delay for clicks or keys.
Only mouse moves have a 50 ms trailing delay, to coalesce a drag. New input
invalidates a still that started before the latest input. A 300 ms server
limit bounds the barrier; capture still runs when the barrier fails or times
out. A newer delivered frame, stop, resize, or session close discards a late
result. Every detached promise catches rejection.

Above DPR 1, screencast images are change triggers and are never delivered.
They use everyNthFrame=1 and CSS viewport bounds. Identical trigger images
are ignored: screenshot capture can itself cause a duplicate compositor
frame. CSS bounds retain small changes that a one-pixel trigger can lose.
A trigger starts a sharp screenshot without a paint barrier. One capture
runs at a time. Mouse moves, keys, clicks, and page triggers all use throttle
semantics: input cannot reset a pending timer or postpone capture without
bound. New input during settlement or capture queues one follow-up with a
fresh paint barrier. The current still can publish if nothing newer has been
delivered, even when newer input has arrived. This keeps motion and typing
visible. The DPR-1 path retains its stricter stale-input discard rule. Trigger frames never increment the delivered
frame revision. All watchers receive the same high-DPR stills. Capture pauses
when every sender is blocked; a slow sender holds only the newest frame and
cannot block a ready sender. The pressure ladder still controls bounds and
quality. These rules implement the PM ruling of 2026-09-16.

Watch requests can carry `deviceScaleFactor`: absent means 1, non-number and
non-finite values are rejected, finite values are clamped to 1..4 without
rounding. The highest active watcher DPR wins. CSS viewport limits remain
320..2560; physical capture dimensions are limited to 2560 per axis. The CDP
device-scale override changes raster density only. There is no render-scale
or visible-size override. Pointer coordinates and wheel deltas remain CSS.
Still clips follow the current visual viewport, including scroll offsets.

Resize applies Playwright's viewport first, then starts a new CDP session
with the current watcher DPR. Agent screenshots use Playwright `scale: css`.
At DPR 1 they do not stop capture. Above DPR 1 they stop capture, set CSS dimensions and DPR 1 before detaching
CDP, take the CSS screenshot, and restore current watcher demand on a fresh
CDP session. Explicit reset prevents Chrome from briefly exposing the old
physical surface dimensions as the CSS layout after detach. Human
input waits for this whole window; frames from a stopped session cannot
publish. The page can observe DPR go from watcher DPR to 1 and back during the
window; CSS layout dimensions stay unchanged. Responsive images and
DPR-sensitive page listeners can react. A failed restore signals unavailable;
a later capture refresh retries with current demand. The last watcher leaving
removes the override and restores DPR 1.

A capture-only zoom at page DPR 1 was measured and rejected locally: text
was sharp, but the page chose its 1x srcset image and its canvas was visibly
soft. DSF-only with screenshot scale 1 selected the 2x image and sharp canvas.
Both shapes passed 40 concurrent selector/mouse clicks during screenshot
bursts on 2026-09-16. Full Chrome 151 new-headless still produced a CSS-sized
screencast with DSF only. The browser-wide force-scale flag worked, but cannot
follow watcher demand. Probe sources are retained in the local harness.

## Baseline

Measured on auntie, 2026-09-16, source `de28ff3a`, before product edits:
25 quiet-page trials, 9 successes, 13 failures with no frame and 3 failures
with one stale frame. No success follows a success. Sequence:
`f f F S f S f S f S f f F S f S f S f S f f F S f`.
Here `f` means no frame, `F` one stale frame, and `S` a changed marker.
Successful-click median: 59.4 ms; p95: 68.7 ms. Failures stop at 2000 ms.

DPR-2 watcher request, 390x700 CSS viewport: delivered JPEG 390x700.
After resizing to 400x680 with the same 780x1400 requested capture bounds:
delivered 400x680. Agent PNG dimensions match the CSS viewport.

The final after results are recorded in the evidence files alongside this
report. Public controls and visible copy do not change. The public browser
feature and setup descriptions remain accurate; the REST type comment now
states the CSS screenshot contract. Deployment needs merge, UI build, and an
approved server restart.

## Superseded round-1 measurements (2026-09-16)

Rejected production source: `8ab23241`. These numbers describe the original
scale/visible-size implementation, which broke agent selector input. The
final hand-off report and hash-prefixed logs supersede this table.
All retained measurement logs have an explicit `exit=0`.

| Quiet-page metric, 25 trials | Before | After |
| --- | ---: | ---: |
| Changed marker delivered | 9 | 25 |
| No-frame failures | 13 | 0 |
| One-stale-frame failures | 3 | 0 |
| Success after success | 0 | 24 |
| Successful-click median | 59.4 ms | 166.5 ms |
| Successful-click p95 | 68.7 ms | 222.3 ms |

The after sequence is 25 successes, with no capture reset. The longer
successful-click latency includes the trailing still path. The before latency
excludes 16 trials that reached the 2-second deadline, so the two success-only
percentiles must not be read as overall response-time parity.

| DPR-2 watcher, fixed 780x1400 bounds | Before JPEG | After JPEG | Agent PNG, both |
| --- | --- | --- | --- |
| CSS 390x700 | 390x700 | 780x1400 | 390x700 |
| Resize to CSS 400x680 | 400x680 | 780x1326 | 400x680 |

The second row keeps the original physical width limit of 780, so Chrome
preserves aspect ratio within that bound. The real panel check sends fresh
bounds on resize: CSS 399x707 delivers 798x1414, and CSS 409x707 delivers
818x1414. Navigation and scrolling retain DPR 2 and these dimensions.
Real panel mouse clicks arrive at CSS (150,250) and hit the fixture button.
A wheel delta of 100 moves the page 100 CSS pixels. A drag with 50 mouse moves
at 5 ms intervals requests one still after the motion stops. Agent screenshots
remain CSS-sized, and the page returns to DPR 2 after each screenshot.

The transition probe measured a first frame after DPR-2 join in 114.3 ms,
after CSS resize at DPR 2 in 134.2 ms, and after DPR-2 departure in 51.0 ms.
The join/departure gaps did not exceed the measured resize gap. A lower-DPR
join caused zero capture restarts. Last departure restores DPR 1 and leaves
no screencast. These are one local sample per transition, not latency bounds.

## Round-1 regression sensitivity

`python3 prototypes/browser-panel-measure/mutants.py` runs each mutation
separately and restores the committed source even on failure. All five died
on source `8ab23241` (2026-09-16):

| Mutant | Production change | Failing test / line |
| --- | --- | --- |
| rejected-frame-suppresses-seed | Treat a rejected frame as delivered at `browser-session.ts:775` | seed test, `browser-session.test.ts:1717`: no initial still |
| dispatch-only | Remove paint barrier at `browser-session.ts:950` and trailing delay | latest-input test, `browser-session.test.ts:1568`: old paint delivered before repaint |
| revision-before-settle | Sample frame revision before barrier instead of line 962 | latest-input test, line 1572: stale stream frame suppresses final still |
| leading-settle | Remove latest-input check at line 961 | settlement-restart test, line 1698: screenshot requested before second barrier |
| overwrite-live | Weaken frame-revision guard at line 965 | late-still test, line 1625: obsolete screenshot replaces live frame |

Additional tests cover timeout fallback, isolated-world use, drag coalescing,
stop/resize/close/rejection, DPR join/leave and fractional values, 2560 physical
bounds, CSS frame geometry, pointer conversion, agent screenshot restoration,
wire validation and defaulting, and DPR-only changes without a CSS resize.

## Existing assertions changed

No assertions were removed. The following assertions were extended or changed:

- `server/test-support/browser-session.test.ts`, “streams frames only while a
  viewer is attached and dispatches human input”: find the dispatch call by
  method rather than assuming it is the final CDP call. The argument assertion
  remains intact; still capture now follows input.
- `ui/log-view/BrowserPanel.dom.test.tsx`, “subscribes, paints frames, and forwards
  pointer and keyboard input” and “three consecutive bitmap rejections select
  JSON once; late binary frames are ignored”: expected watch request includes
  DPR 1.
- Same file, “requests device pixels and debounces quantized capture bounds”
  and “debounces manager CSS viewport changes separately from device-pixel
  capture”: expected watch request includes DPR 2.

No user-visible copy was added or changed. REST/wire comments and internal
measurement documentation were updated. No HTTP route was added or changed.

## Round-2 verification

The revised tests exercise 16 ms triggers over 2 seconds with a 65 ms capture
cost: at least 20 and at most 34 delivered stills, one capture in flight, and
the final changed frame. Other tests cover blocked/ready senders, latest-only
drain, input queued through an agent screenshot, watcher departure during a
screenshot, restore failure and recovery, and absence of DPR-1 emulation.

`agent-check.ts` runs the real pool at DPR 1.5 and 2 after a 300 CSS-pixel
scroll. It checks selector click, hover, page.mouse, a human click raced with
an agent screenshot, a single page-driven repaint, CSS agent PNG dimensions,
and isolated-world creation over 100 stills. `panel-check.ts` accepts `DPR`
to check the real panel mouse path at both values. The final report records
measurements run on the exact hand-off hash. No route or product copy changed.

Additional replaced assertions in round 2, all in browser-session.test.ts:
- “uses the highest watcher DPR, preserves CSS input and screenshot geometry,
  and caps physical capture”: replace scale/visible-size and multiplied-input
  expectations with DSF-only, CSS input, trigger-only delivery, screenshot
  cap, and every-frame trigger checks. DPR 1 now asserts no metrics command.
- “seeds the view when the first stream frame has pre-DPR dimensions”: renamed
  to “...mismatched dimensions” and uses DPR 1 with a wrong-size stream frame;
  DPR > 1 now has its own trigger-only first-frame path.

## Round-3 continuous-input repair (2026-09-16)

On round-2 source `9f5ef13d`, the new hover and typing tests both fail at
browser-session.test.ts:1876: zero frames arrive during input. Each test runs
for 2 seconds at DPR 2, with a 33 ms paint barrier and a 65 ms capture. Hover
inputs arrive every 16 ms; typing inputs arrive every 80 ms. Each input also
causes a page trigger. The throttle repair delivered 19 frames during each
run, then the final input frame (20 total). Tests require 15..23 frames during
input, one capture in flight, and the final changed frame after input stops.
That lower bound is at least 7.5 frames/s including settlement and scheduling,
against a nominal 98 ms barrier-plus-capture cost. Final hand-off logs repeat
this measurement on the named commit. Existing leading-settle and early
revision-sample mutants still protect the distinct DPR-1 behavior.

The real drag measurement now reports input paint barriers and total captures
without requiring one barrier: DPR > 1 must continue delivery during input.
The previous one-barrier assertion in panel-check.ts was replaced with a
nonzero-capture assertion; continuous cadence and final content are pinned by
the timed regression tests above. The generated viewer image is committed;
no lane stash remains.
