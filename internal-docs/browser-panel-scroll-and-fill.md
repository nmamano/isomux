# Browser panel: scroll diagnosis and full viewport

Historical design and evidence. The Server browser and remote panel were retired on 2026-09-20. Current Chrome control and migration: [browser-extension.md](browser-extension.md). Server screenshot previews remain supported.

Lane browser-0913, tasks b5356276 and 11e1feda. Report dated 2026-09-13.

## Scope and decision

The scroll task changes no transport, decoder, capture rate, or wheel handling.
The implementation makes the page viewport follow the manager panel, under the
PM's 2026-09-13 ruling. The latest manager resize wins across devices. Other
room viewers contain the shared image and do not resize the page. The agent's
next action uses the current shared viewport. A narrow panel selects responsive
mobile layouts where the site provides them.

The panel debounces geometry for 150 ms. It sends CSS viewport dimensions on the
existing `browser_input` socket command with `kind: "viewport"`. The server
checks the manager on each message, requires integer dimensions in 320..2560,
and serializes viewport changes with page actions. The panel clamps its CSS
request before sending; the pool retains an internal defensive clamp. Resize
counts as manager activity and restarts capture. The server explicitly sends
`browser_status` with optional `resizing: true` before it changes the viewport,
clears held frames, and sends normal status before new capture. Each serialized
resize has its own true/false status pair, including successive resizes on a
quiet page. The panel invalidates pending and in-flight decodes at each barrier,
including read-only watchers, without resetting page availability. A status
change or reconnect does not reassert an existing manager viewport. The server
also refuses frames whose page dimensions differ from the current viewport. No agent HTTP route is added.
Capture demand remains separate: content-box CSS dimensions × devicePixelRatio,
rounded up to a multiple of 16, clamped to 320..2560, capped to page viewport,
scaled by each watcher's pressure rung, then combined across watchers. The
highest demand still wins. Capture does not grow past the page viewport at DPR 2.

The barrier protects both decode APIs in a new panel on a new server. Legacy
JSON still has no watch generation, so an old capture-bounds frame can be
accepted across an ordinary capture subscription resize. Older bundles ignore
the optional barrier and retain their previous stale-frame behavior. The
barrier does not retrofit protection into those bundles.

The canvas fills the available surface even when the capture degrades. It uses
contain to preserve the shared page aspect ratio when another manager device
sets a different shape. Input coordinates account for those margins and ignore
input outside the image. The 320..2560 viewport bounds can also leave margins
in a smaller or larger panel; the image remains complete and undistorted.

## Scroll measurement

Evidence and reproduction scripts are in
`/home/nil/nil/browser-0913-evidence/`: `bench.ts`, `panel.tsx`, `viewer.cjs`,
`report-scroll.py`, and the dated run logs/JSON. Scripts import the reproduction
checkout by path; update those paths when reproducing elsewhere.

The fixture mounts the real production React BrowserPanel and sends inputs over
a loopback WebSocket to the real BrowserPool. The real BrowserFrameSender sends
binary JPEG. It uses an isolated target Chrome with no office profile and an
isolated headless viewer, each inside a separate 2 GiB systemd scope. No office
restart or real login is used. This measures the actual component and browser
pipeline, with a local fixture socket dispatcher, rather than a full office
session or a physical trackpad. It does not measure Nil's device or network.

The scrolling page has 100-pixel row marks and a fixed 12-bit scroll-position
marker. Twelve black/white 80×80 CSS-pixel blocks encode rounded `scrollY` in a
4×3 grid. At 320×200 capture of a 1280×800 page, each cell remains 20×20 pixels.
The validation reads zero, every individual bit, and 4095 at pressure rung 4
before any gesture. All values must match. A small changing mark keeps frames
flowing on the otherwise quiet validation page. The marker updates on scroll
and animation frames. JPEG pixel readback happens after `drawImage` returns.

Each gesture dispatches 120 DOM wheel events of 16 CSS pixels, scheduled at
120 Hz for a total of 1920 pixels. The real React handler sends the messages.
The viewer records actual send timestamps, not intended timer deadlines. The
viewer stops when it paints 1920 and retains target wheel/scroll event counts,
server dispatch completion times, socket buffer samples, and start/end load.

Two endpoints describe the gesture. During-gesture lag is cumulative sent
pixels minus the most recently drawn position, sampled on a 1 ms receiver-clock
grid from first scheduling to the end of input. This includes time spent on a
stale frame between paints. Settle time runs from the last dispatch to the first
draw of the final position. A secondary threshold latency matches each sent
16-pixel increment to the first drawn position at or beyond it; several inputs
can match one frame. This is not 120 independent click samples. All latency
endpoints use the same viewer `performance.now()` clock and end at canvas draw,
not physical display presentation. Readback follows the endpoint but can affect
later scheduling. Target event timestamps use a separate clock and are not
subtracted from viewer timestamps.

Measured 2026-09-13, 15:59 UTC, at `b26678ebb17bb30a2687f739e90ac0f59643016c`,
recorded at both run ends. The baseline panel is pinned to `127ee3ee`;
its 650×900 box produces a 640×400 binary JPEG stream. Six gestures all
reach the requested final 1920-pixel position. Every gesture sends 120 messages
and 16,920 UTF-8 JSON bytes (141 bytes/message), excluding socket/TCP/TLS framing.
The actual input rate is 92.34–120.96 messages/s and 13,019–17,055 bytes/s.
The intended cadence is 120 Hz; scheduling stretches the third gesture to
1.30 seconds. The target receives 67–84 wheel events, each gesture retaining
all 1920 pixels of wheel delta. Chrome coalesces the input, but Isomux has
already sent all 120 messages and issued all 120 CDP calls.

| Gesture | Input span ms | Draws during input | Time-weighted position lag median / p95 CSS px | Final settle ms | Target wheel / scroll events | Box load start → end |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1004 | 12 | 576 / 800 | 553.9 | 67 / 18 | 12.89 → 14.26 |
| 2 | 992 | 16 | 384 / 640 | 155.3 | 79 / 29 | 14.26 → 14.26 |
| 3 | 1300 | 7 | 736 / 1088 | 330.7 | 67 / 20 | 14.26 → 14.24 |
| 4 | 997 | 11 | 560 / 912 | 602.8 | 74 / 24 | 14.24 → 14.24 |
| 5 | 993 | 16 | 416 / 576 | 230.7 | 77 / 32 | 14.24 → 14.24 |
| 6 | 992 | 18 | 320 / 464 | 184.1 | 84 / 35 | 14.24 → 14.62 |

The median lag across each gesture is 320–736 CSS pixels; individual stale
intervals reach 1264 pixels. Final settle is 155.3–602.8 ms. The matched
threshold-latency medians range from 187.2 to 634.0 ms, with per-gesture p95
257.5–871.9 ms (`scroll-report.json`). These threshold values explain the
continuous lag without substituting click measurements for it.

Server input receipt to CDP resolution is 87.3 ms median and 426.8 ms p95 over 720 calls. These values do not
partition the viewer-clock latency. All recorded Bun frame buffers are zero,
so the observed lag does not require pressure-ladder engagement. The earlier
bandwidth report explains why zero Bun buffering does not prove zero downstream
backlog. Here, loopback, capture, browser scheduling and decode all remain in
the path. The headless viewer reports SwiftShader and software GPU compositing.
Per-gesture marker readback medians are 0.4–0.5 ms and p95 values 0.6–8.3 ms;
that extra work can affect later scheduling. This loaded-box run establishes a
scrolling symptom, not a single causal attribution or a WAN latency estimate.

**Recommendation for the later lane:** first measure summed wheel deltas with
one scheduled flush per animation frame, and compare a bounded in-flight send
policy. Preserve total deltas and page/line units. Orca implements accumulation
and one in-flight operation in the source linked below. Isomux's current input
traffic is only about 0.10–0.14 Mbit/s here; the reason to test accumulation is
the 120 message/CDP operations per gesture, not a claim that input bytes dominate
JPEG traffic. Compare the same position-lag and settle endpoints before choosing
a change. Do not introduce client-side scroll prediction without accounting for
nested scroll containers, sticky content and page event handlers.

Video remains a separate candidate if JPEG capture/traffic is still limiting.
The round-3 capture-consent bypass remains prohibited on the shared browser.
Native local rendering, isolated display capture, and a consent-safe video
pipeline have different deployment costs. None is implemented in this lane.


## Prior art, checked 2026-09-13

Public documentation and source inspection establish these mechanisms. No
vendor session was purchased or benchmarked. An advertised live view does not
establish its codec or prove that scrolling is lag-free.

| Product | Verified live-view mechanism | Lag evidence and applicable lesson |
| --- | --- | --- |
| AdaL | Its [Browser Use guide](https://docs.sylph.ai/features/browser-use/) says it opens a dedicated Chrome window; other AdaL sessions can share that window. | The documented local window avoids the remote image-stream leg. The guide does not establish a streamed-view codec or a measured scrolling fix. |
| Orca local/remote | Its [browser guide](https://www.onorca.dev/docs/browser/overview) documents native Chromium in a pane. For remote workspaces, the default renders locally while network traffic goes through the remote host. Server-streamed pages remain an option. | Local rendering avoids a remote pixel stream for interaction. This is a different client architecture, not a drop-in Isomux transport change. |
| Orca streamed | Public source at `fe4237cd41e4d48793fd135640939ef8aa5418e0` reads CDP screencast images, converts base64 to bytes and emits a binary JPEG/PNG envelope with sequence and scroll/viewport metadata over its WebSocket RPC transport. | Its wheel handler sums pending deltas, normalizes line/page units, schedules via animation frame, and allows one wheel operation in flight. Its frame pacer retains the latest pending frame, delays CDP acknowledgments and retries blocked sends. These are concrete implementations; their speed on this office is unmeasured. |
| Browserless | [LiveURL schema](https://docs.browserless.io/bql-schema/operations/mutations/live-url) exposes JPEG/PNG image streaming, JPEG quality, compression, and viewer-driven viewport resizing. | Its [tuning guide](https://docs.browserless.io/baas/advanced-configurations/hybrid-automation-configurations) recommends lower JPEG quality for slow links. Its schema describes a compression/latency tradeoff. These sources do not prove a scrolling latency bound or identify every wire layer. |
| Browserbase | [Session live view](https://docs.browserbase.com/platform/browser/observability/session-live-view) offers an interactive embeddable view. The cited public page does not establish its live-view codec. | The page explicitly lists lag as a troubleshooting case. Its [performance guide](https://docs.browserbase.com/optimizations/latency/speed-optimization) recommends placing browsers near automation code to reduce repeated CDP round trips. That is not evidence of a specific scroll encoding fix. |
| KasmVNC | [Server documentation](https://www.kasmweb.com/kasmvnc/docs/master/serverside.html) describes default WebSocket transport and experimental WebRTC **data-channel** UDP. Its [client documentation](https://www.kasmweb.com/kasmvnc/docs/latest/clientside.html) describes mixed JPEG/WebP image compression. | The client guide warns that lower-end clients can obtain higher frame rates by disabling WebP. WebRTC here does not imply an H.264 video track. The server guide describes STUN and NAT limits, including lack of TURN support in that documented version. |
| n.eko | [Project overview](https://neko.m1k1o.net/) describes a Docker browser using WebRTC. Its [capture configuration](https://neko.m1k1o.net/docs/v3/configuration/capture) uses X-display capture and GStreamer video pipelines with VP8, VP9, AV1, H.264 or H.265, subject to client support. | [Release notes](https://neko.m1k1o.net/docs/v3/release-notes) record video-lag fixes, a macOS scroll-speed fix, and experimental bandwidth estimation/adaptive quality. These are acknowledged problems, not comparable latency measurements. Its [troubleshooting guide](https://neko.m1k1o.net/docs/v3/troubleshooting) shows the UDP/NAT reachability work that a WebRTC deployment needs. |

Orca source links, pinned to the inspected revision:

- [CDP frame receipt](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/main/browser/browser-screencast-cdp-events.ts)
- [WebSocket dispatch](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts)
- [Binary envelope](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/shared/browser-screencast-protocol.ts)
- [Frame pacing](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/main/browser/browser-screencast-frame-pacer.ts)
- [Wheel accumulation](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-wheel.ts)
- [Shared capture budget](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/src/main/browser/browser-screencast-frame-budget.ts)

Orca chooses the most constrained viewer's size/quality budget. Isomux currently
preserves the fastest viewer's demand. Copying Orca's budget rule would change
that policy. Its delayed-ACK rule would also need a final-static-frame test;
this lane changes neither rule.

## Locally running Isomux offices

Source: `server/browser-session.ts` (`launchOptions`, `createSession`,
`humanInput`, `startScreencastNow`), `server/preview-capture.ts`
(`defaultFindBrowser`), and `ui/log-view/BrowserPanel.tsx`, inspected 2026-09-13.

The office launches headless Chrome on the computer that runs Isomux. A local
installation therefore runs both the agent and controlled page locally, but
still streams the controlled page into the office Browser panel. It does not
attach to the member's everyday Chrome window or inherit that Chrome profile.
The office keeps its own per-member saved browser state and per-agent contexts.
The existing browser finder checks Chrome/Chromium executable names on PATH,
Linux install paths, or `ISOMUX_PREVIEW_BROWSER`. A local machine must provide a
usable executable; a default macOS application-bundle path is not in that probe.
This report does not change discovery or add a desktop mode.

On the same computer, panel traffic can stay on loopback. From a phone, the
controlled page still runs on the office computer and the JPEG/input stream
crosses the connection to that computer. Local deployment removes WAN travel
only when the viewer is also local; capture, encoding, decoding and scheduling
still apply. Isomux's HTTP(S) page requests originate from the office computer,
so localhost URLs address that computer. BrowserPool uses headless mode even
when a display exists.

## Bandwidth and verification

Measured 2026-09-13 on `67af01a376e3c5d2cb6f2bb418838053a0eca2b6`;
the later barrier change does not change steady-state capture settings. Each
server log records that hash at start and end. The before arm builds BrowserPanel
from `127ee3ee`; the pool/sender use this lane and the old panel sends no viewport
inputs. Global office CSS is injected in both arms. Each receiver window is
15 seconds. These are fixed-order image-cost observations, not a balanced
latency or CPU comparison. The box is shared and loaded.

The outer dimensions include the toolbar; the surface below it is the page
viewport target. Width loses one CSS pixel to the panel border. Before the
change, the capture observer excludes 10 pixels of padding on each edge.

| Panel / DPR | Before observer CSS → capture request → decoded JPEG | After observer CSS → capture request → page viewport / decoded JPEG |
| --- | --- | --- |
| 650×900 desktop / 1 | 629×770 → 640×784 → 640×400 (page 1280×800) | 649×790 → 656×800 → 649×790 |
| 1300×900 wide / 1 | 1279×770 → 1280×784 → 1254×784 (page 1280×800) | 1299×790 → 1312×800 → 1299×790 |
| 390×844 phone shape / 2 | 369×714 → 752×1440 → 752×470 (page 1280×800) | 389×734 → 784×1472 → 389×734 |

Every traffic figure in the next two tables describes **binary JPEG**.

| Panel | Message bytes/frame before → after | Calculated Mbit/s at historical 15.76 fps before → after | Calculated Mbit/s at historical 10.78 fps before → after |
| --- | --- | --- | --- |
| Desktop | 27,258 → 59,699 | 3.44 → 7.53 | 2.35 → 5.15 |
| Wide | 66,303 → 72,514 | 8.36 → 9.14 | 5.72 → 6.25 |
| Phone shape / DPR 2 | 34,260 → 31,730 | 4.32 → 4.00 | 2.95 → 2.74 |

At the same frame rate, the taller desktop capture costs about 119% more in
this busy fixture. The wide case costs about 9% more. The phone case costs
about 7% less because the page becomes 389×734; DPR 2 cannot exceed that cap.
On the DPR-2 phone display, the live image now has about half the previous
horizontal resolution (389 rather than 752 pixels), is upscaled 2× to 778
device pixels, and will look softer. The CSS viewport cap prevents the separate
device-pixel capture request from restoring that sharpness. Changing the page
device scale factor would also change agent-visible DPR, image selection and
canvas rendering. On 2026-09-13 the PM approved deferring that policy and
keeping this lane at DPR 1. The lower traffic comes with lost sharpness; it is
not a free saving. Nil can decide whether HiDPI rendering needs its own lane.
These are content-specific results, not a general bandwidth promise.

Update 2026-09-16: the DPR-1 deferral above is superseded by the
[browser-panel DPR repair](browser-panel-0916.md). That report records the
watcher-DPR policy, CSS-resolution agent screenshots, and new measurements.

| Arm / panel | Delivered fps | Measured binary Mbit/s | Start → end one-minute box load |
| --- | --- | --- | --- |
| Before desktop | 15.46 | 3.37 | 13.54 → 16.43 |
| Before wide | 9.93 | 5.27 | 17.38 → 16.60 |
| Before phone | 16.33 | 4.48 | 16.54 → 17.28 |
| After desktop | 17.40 | 8.31 | 16.89 → 16.10 |
| After wide | 10.79 | 6.26 | 15.62 → 15.87 |
| After phone | 21.93 | 5.57 | 22.85 → 20.87 |

The phone arm's actual traffic is higher because it delivered more frames;
the rate-normalized table isolates image cost from that rate difference.
The evidence keeps `before/after-{desktop,wide,phone}.json`, viewer/server logs,
and screenshots at rung 0 and rung 4. At rung 4, the new desktop canvas remains
649×790 while its image decodes to 325×395. The old canvas shrinks to 320×200.
The wide and phone screenshots also show full use of the manager surface.

The 2026-09-13 interaction run at `b26678eb` opens two manager panels. The second
sets 389×734. A real PanelResizer drag using native Chrome mouse input takes
5,675 ms for 60 moves and sends six viewport requests. The viewport settles at
769×790 and stays there for a further two-second check. Opening a read-only
1000×700 panel leaves it unchanged. That viewer contains the shared image in
its 999×590 surface, including at rung 4 (385×395 decoded). This confirms
that the losing manager and a room viewer do not reassert their own geometry.
Evidence: `interactions.json`, its server/viewer logs, `two-managers-a.png`,
`dragged-manager-rung4.png`, and `readonly-rung{0,4}.png`.

The 150 ms trailing debounce produced six relayout requests over that 5.7-second
loaded-box drag, about one per second, rather than one per move. Gaps longer
than the debounce permit intermediate resizes; it is not a release-only rule.
That retains feedback during a paused drag while bounding continuous movement.
The final request follows the final move. No claim of one resize per gesture
or a strict maximum event rate is made.

The new binary barrier test resolves an old decode after each of two barriers,
for a manager and a read-only viewer, and requires zero old paints. Removing
`generation++` in the `message.resizing` branch is the named mutant. On
`b26678eb`, `two viewport barriers reject old in-flight binary paints for
managers and room viewers` failed at `expect(paints).toBe(round)`, expected 0,
received 1 (`barrier-mutant.log`, exit 1). The source was restored. Server tests
also require two true/false barrier pairs, ordered viewport ownership, fresh
capture bounds, and manager-only dispatch. Coordinate tests cover all four
corners and the centre with both horizontal and vertical margins for pointer
and wheel input; margin events are dropped. A mouse press inside the image
followed by release in a margin sends no release, so the page can keep the
button down. This known behavior also existed with the old smaller canvas.

On 2026-09-13, worker and reviewer reproduced the barrier mutant on the reviewed
hash `be200ac3`; the same assertion failed (worker log:
`final-barrier-mutant.log`).

The frame-dimension guard compares page metadata, not decoded JPEG dimensions.
The current DPR-1 context reports the CSS viewport dimensions in that metadata,
including at reduced capture sizes in the three measured shapes. The guard
stays active between resizes because a delayed old frame can arrive after the
resize flag clears. A future device-scale change must verify this assumption.
The test `drops mismatched frame metadata without caching it and publishes
matching frames` rejects each mismatched axis for both current listeners and
late subscribers, then checks that a matching frame is delivered and cached.
Its named mutants remove the viewport mismatch guard in `publishFrame`, or
replace the screencast metadata dimensions with the current viewport dimensions.
In both cases, the first `expect(frames).toEqual([])` in that test must fail
because the mismatched frame reaches a listener. The round-2 reproduction logs
are `r2-guard-mutant.log` and `r2-metadata-mutant.log` in the evidence directory;
each records the tested hash and failure location.

### Excluded fixtures and historical CSS limits

The first 2026-09-13 runs imported `ui/styles.ts` but did not inject its exported
CSS. They also left the fixture navigation state busy. Those runs are preserved
as `unstyled-*` and excluded from the final tables. The marker's first static
validation timeout is retained as `scroll-instrument-static-failure.log`; no
samples from it are used. The final fixture injects CSS and supplies normal
navigation status. It adds a tiny changing mark for static marker validation.

The retained counterbalanced 2026-09-12 runner and its
`browser-stream-benchmark-panel.tsx` do not inject the office CSS. The original
round-3 runner's CSS setup was not independently established in this lane.
The documented historical 650-pixel captures were nevertheless 640×400.
This lane remeasures the before side with CSS: it again decodes to 640×400 and
measures 27,258 binary message bytes/frame, close to the historical 27,292.
The 640×400 image-cost anchor therefore survives; historical toolbar geometry,
wide-panel dimensions and click latency are not assumed to transfer. The new
styled wide before measurement is 1254×784, not round 3's 1229×768.


The historical anchors remain unchanged: on 2026-09-12 the 640×400 binary path
measured 27,292 message bytes/frame at 15.76 delivered fps, or 3.44 Mbit/s.
The JSON comparison was 36,448 bytes/frame and 4.64 Mbit/s. Round 3's 1229×768
row was JSON/base64, with 64,213 **JPEG payload** bytes/frame and 7.39 Mbit/s at
10.78 fps. It must not be compared directly with a binary traffic rate. Sources:
[browser-panel-bandwidth.md](browser-panel-bandwidth.md) and
[browser-panel-round-3.md](browser-panel-round-3.md).

The new measurements use binary JPEG on both sides. Received bytes include the
28-byte header plus five-byte `bench` identity and JPEG payload, excluding
WebSocket/TCP/TLS framing. The busy fixture preserves the round-3 160 moving
labelled rectangles and black marker but makes its canvas follow the page
viewport. New viewport shapes therefore change visible content as well as
pixel count. Bytes do not scale linearly with pixel count. Rate-normalized
figures multiply measured message bytes/frame by the historical measured fps;
they are calculated bandwidth estimates, not newly measured throughput.


## Drag selection and copy (2026-09-16)

The panel sends the held left button on pointer moves. It captures the pointer,
clamps a drag to page bounds, and releases on pointer-up, cancellation, lost
capture, window blur, and unmount. Chrome receives the existing mouse protocol.
The panel starts in its loading state; LogView keys it by agent and drive access.
An access change remounts the panel to cancel pending copy state; the live view
is blank until its next frame.

Copy selection uses a new WebSocket input request and a response sent only to
that manager connection. The server checks management before and after the
read. The agent HTTP `text` action stays unchanged. Both paths use the same
text helper and 20,000-character cap. The selection path reads a fixed
`window.getSelection()` expression; it accepts no script from the client.
The response carries a separate truncation flag. The manager device writes
only the text to its clipboard; the panel reports empty selection, truncation,
and clipboard failure. Clipboard writes require a secure context and permission.

Observed on 2026-09-16 in headless Chrome: Playwright mouse down/move/up on the
real BrowserPanel canvas, bridged to a real BrowserPool with Chrome screencast
frames, selected text visibly in the live view. Clipboard readback on the
manager page matched the selection. A 21,000-character selection returned
20,000 characters and a visible truncation note. Denied clipboard permission
produced a visible failure. A drag released outside the canvas sent a clamped
mouseReleased event and selected the complete line.

BrowserFrameSender uses its single 250 ms unref interval for pressure samples
and held-frame retries. Senders without pressure callbacks start the interval
when a frame is held and clear it when no frame is held. Tests use a socket seam
whose buffered amount stays high across a timer tick and then falls to zero;
the final frame arrives without a drain call. This proves timer recovery, not
Bun drain behaviour on a congested production socket. No socket rig was added.
