# Browser panel binary JPEG and pressure control

Lane browser-bandwidth, task effe9a51, 2026-09-12. No office restart or access
rule change. The agent-facing `/browser` route is unchanged.

## Transport

A `browser_watch` with `transport: "jpeg-v1"` and a positive safe-integer
`generation` receives binary JPEG messages. A watch without `transport` receives
only the existing JSON `browser_frame`. An unknown transport or invalid binary
generation is refused. The server sends one transport per watch. This lets an
already-open old client keep working after a server update. The new panel also
accepts JSON from an older server that ignores the opt-in fields. The panel
requests JSON if ImageBitmap is absent. Three consecutive bitmap decode
rejections switch the mounted panel to JSON; a successful decode resets that
count. Resize and reconnect retain that choice until the panel is remounted.

Every binary message has this big-endian header. DataView uses the incoming
view's byte offset, so an unaligned Buffer slice is valid.

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 4 | `ISMX` magic |
| 4 | 1 | Version 1 |
| 5 | 1 | Kind 1: JPEG |
| 6 | 2 | UTF-8 agent-id byte length |
| 8 | 8 | Watch generation, Float64 storing a positive safe integer |
| 16 | 4 | Page viewport width |
| 20 | 4 | Page viewport height |
| 24 | 4 | JPEG byte length |
| 28 | variable | UTF-8 agent id, then JPEG bytes |

The decoder checks lengths, magic, version, kind, identity encoding, generation,
dimensions and JPEG start bytes before it returns a frame. Extra bytes and
truncation are refused. Each message names its agent without a preceding JSON
message or an id table. The variable id costs its UTF-8 byte length per frame;
it also supports imported or future agent ids without a fixed-width assumption.

The panel advances its watch generation on subscribe, reconnect and resize.
The binary panel rejects other agents and older watches. Its separate decode epoch
invalidates an image already loading when status becomes unavailable; the panel
also refuses current-watch frames until an available status arrives. The pool
does not seed a resized watch from a cached frame with old capture bounds. The
sender clears held frames when the page becomes unavailable. Legacy JSON carries
no wire generation, so an old-bounds JSON frame can still arrive and paint after
a resize. This pre-existing limit is unchanged.

`ui/ws.ts` sets `binaryType = "arraybuffer"` on each new office socket and applies
its existing socket-generation guard before dispatch. Binary listeners receive
binary only; raw text listeners and the store receive text only. Log and terminal
messages stay JSON. API-token sockets use their existing separate server arm
and cannot subscribe to browser frames. The frame sender retains the room-access
check on each send and drain, including frames held during an access change.
Only managers drive, only managers receive full URLs, and only manager watches
hold the idle timer open.

The panel uses one decode and one replaceable pending frame. Binary JPEG uses
`createImageBitmap(new Blob(...))`; JSON uses Image with a base64 data URL.
The panel closes every resolved bitmap in a finally block after attempted paint,
including stale or unmounted resolutions and a failed draw. A rejected decode
produces no bitmap to close. The measurement includes both the transport change
and the decode-API change. Neither an overall latency change nor send-to-arrival
is attributed to binary transport alone: capture, scheduling and transport all
precede arrival. Arrival-to-draw includes decode and the pending-slot wait.

Compression is disabled: the office websocket sets no `perMessageDeflate`
option, and Bun's bundled declaration documents the default as false. The local
2026-09-12 paused-reader handshake offered permessage-deflate and received no
extension agreement (`slow-reader.log`). Measurements count received websocket
message bytes, including our header or JSON/base64, but exclude websocket/TCP/IP
framing, TLS, and retransmission overhead, as in round 3.

## Shared capture pressure control

Each watch samples Bun's socket buffer every 250 ms after its first frame.
More than one current frame buffered for 2 seconds lowers one rung. At most a
quarter frame buffered for 8 seconds raises one rung. The middle band resets
the dwell clock. Each change starts a new dwell. The sender continues to retain
only the latest waiting frame and flushes it on drain. It samples quiet pages
too, and stops its timer on unsubscribe or loss of room access.

A resize preserves pressure level and dwell while replacing the sender's held
frame. The panel's requested bounds are capped to the viewport before the ladder
scale is applied. Resize changes those requested bounds; it does not reset the
ladder. The pool selects the highest JPEG quality and the largest scaled bounds
among live watchers. A fast watcher therefore keeps shared capture at its demand.
A slow watcher of that same page still loses delivered frame rate, but cannot
get a separate cheaper encode. This is shared-capture adaptation, not per-viewer
encoding. No extra encoder or per-viewer resize is introduced.

### Image cost

Measured 2026-09-12 in a separate Chrome, using round 3's 1280x800 busy canvas,
frozen at animation time 1000 ms. JPEG is captured through CDP. PSNR compares
RGB pixels against a 640x400 PNG capture; smaller images are enlarged to that
size by Chrome canvas. It is an error measure for this fixture, not a measure
of text comprehension or every website. Files are in
`/home/nil/nil/browser-bandwidth-evidence/`.

| Rung | Quality | Capture | JPEG bytes | RGB PSNR dB | Image cost / file |
| --- | --- | --- | --- | --- | --- |
| 0 | 50 | 640x400 | 28,619 | 26.36 | Small labels are already softened by half-size capture. `q50-640.jpg` |
| 1 | 30 | 640x400 | 22,184 | 25.17 | More edge noise around small labels, with the same pixel count. `q30-640.jpg` |
| 2 | 20 | 640x400 | 17,764 | 24.29 | More visible blocks and color error around letters. `q20-640.jpg` |
| 3 | 20 | 480x300 | 12,890 | 22.49 | Small labels lose detail as both axes lose another quarter of their pixels. `q20-480.jpg` |
| 4 | 20 | 320x200 | 7,702 | 20.76 | Tiny labels cannot be read reliably; layout and large controls remain visible. `q20-320.jpg` |

The quality probe also measured q40 at 25,588 bytes / 25.82 dB and q30 at
480x300 at 16,109 bytes / 23.19 dB. The chosen ladder reduces quality before
pixel count: q20 at full capture is larger than q30 at 480x300, but has less
measured error. These are measured tradeoffs, not a claim of an optimal ladder.
Raw measurements: `quality.log`; reference: `reference.png`.

The 2-second downward dwell exceeds the longest observed capture-restart gap
in the paused-reader diagnostic (about 0.85 seconds at 250 ms sampling). The
8-second recovery dwell leaves several such intervals before increasing traffic.
The first pre-edit click baseline's p95 was 449.2 ms. The controller uses these
measurements to avoid reacting to single frame/capture stalls; its thresholds
are conservative operating choices, not a measured optimum for a WAN. Injected
readings test the exact boundaries, dwell resets, recovery and resize retention.

### Actual socket pressure

Measured 2026-09-12 with a raw TCP websocket reader on loopback, a real BrowserPool
and BrowserFrameSender, and the same animated page at 640x400. The reader drains
for 5 seconds after navigation, pauses reads for 30 seconds, then drains for
40 seconds. Bun socket buffering really occurs; no reading is injected in this
run. `slow-reader.ts`, `slow-reader.log`, and `slow-trace.json` retain the method
and 250 ms samples. The server and target Chrome share a 2 GiB scope.

The committed repeat used capture code at `1664ea17` (the same capture code as
the final comparison). The Bun buffer held 52,314 bytes when the reader resumed.
The reader paused at 9,395.9 ms. Bun first reported a nonzero buffer at
30,160.1 ms: **20.764 seconds before pressure was visible to the controller**.
The first down step followed at 32,543.8 ms, another 2.384 seconds including
sampling and scheduling. The remaining three steps took 6.242 seconds. The
lowest demand therefore arrived 29.390 seconds after pause; the controller did
not spend that whole interval stepping down. Top demand returned 33.057 seconds
after resume. Samples are 250 ms apart plus scheduler delay.

Bun reported zero in 79 of 115 paused samples and 52,314 bytes in the other 36.
The server continued to accept sends while the reader had stopped. This is
consistent with downstream kernel/TCP buffers absorbing data before Bun's own
queue grew; kernel queues were not measured directly. **The guard cannot react
until pressure becomes visible in Bun**, so downstream buffering can hide a
blocked reader for tens of seconds, as on this loopback run. The delay depends
on buffer capacity and production/drain rates, not just link speed. This also
provides a possible explanation for round 3's zero Bun readings, not proof of
the cause of every zero reading. Bun's signal is not total network backlog.

| Change | Time from process start ms | Bun buffered bytes | New demand |
| --- | --- | --- | --- |
| Down | 32544 | 52,314 | q30, 640x400 |
| Down | 34589 | 52,314 | q20, 640x400 |
| Down | 36636 | 52,314 | q20, 480x300 |
| Down | 38786 | 52,314 | q20, 320x200 |
| Up | 47939 | 0 | q20, 480x300 |
| Up | 55935 | 0 | q20, 640x400 |
| Up | 64213 | 0 | q30, 640x400 |
| Up | 72458 | 0 | q50, 640x400 |

The following short windows describe message-byte production, sends accepted
by Bun, and TCP bytes read by the client. TCP read bytes include framing.
A paused reader receives zero bytes by construction; captured bytes show the
separate reduction in the data produced by the capture settings.

| Window from process start | Captured message bytes/s | Bun send bytes/s | Client TCP read bytes/s |
| --- | --- | --- | --- |
| Before pause, 6.18–8.84 s | 655,515 | 655,515 | 655,611 |
| During pause, q20 with shrinking capture, 35.09–38.79 s | 171,012 | 0 | 0 |
| Recovered at q50 / 640x400, 75.32–78.87 s | 367,476 | 367,476 | 367,530 |

One-minute box load at start/end was 5.84 / 6.43; at pause/resume,
5.85 / 6.24. The full trace retains all three load averages. Capture returned to
640x400 / q50 before the end, with a zero Bun buffer.
A stopped TCP reader proves buffer engagement and recovery; it does not model
packet loss, jitter, a real member uplink, mobile decode cost, TLS, or a
rate-limited path with continuous reads. The earlier development diagnostic is
retained as `slow-reader-development.log` and `slow-trace-development.json`.

## Counterbalanced comparison

Measured 2026-09-12 UTC on commit
`644ab58e98f084fd721576bf91be4b7b21f5cf12` (production code unchanged from
`1664ea17`). The merge base is
`0bbd92b433b125b69fec6f536c6160e4de3fd7ac`. The pre-edit 25-click anchor
(`block1-json.log`, 05:01 UTC) is separate from this comparison.

The ported round-3 script reads baseline BrowserPool, BrowserPanel, ws.ts,
frame sender and English catalog from that pinned merge base. The same runner
runs four counterbalanced blocks in one session: JB, BJ, BJ, JB, where J is
JSON and B is binary. Each arm leads twice, with 25 clicks per block and 100
per mode. It uses the round-3 1280x800 moving canvas and black/white click
marker, a 650 CSS-pixel panel (decoded 640x400), production React, a real
BrowserPool and panel, and a loopback websocket. A new viewer Chrome is used
per run, with no office profile. The target scope contains Bun plus target
Chrome; CPU subtracts the Node viewer-controller ticks. The viewer Chrome has
a separate 2 GiB scope. CPU is percent of one core.

Each actual measurement viewer was queried with CDP SystemInfo.getInfo before
timing. All eight reported Chrome 151.0.7922.137, ANGLE with the SwiftShader
Device (Subzero), driver 5.0.0, and GPU compositing `disabled_software`. The
`viewerBackend` record in each log retains the result. The arrival-to-draw leg
is a software-rendered headless-viewer measurement. It does not establish the
decode cost of a member's GPU-backed browser; no such browser was measured.

The binary arm also includes the new per-watch 250 ms pressure timer, a
`Buffer.from(frame.data, "base64")` decode for each captured frame offered to the sender, header-buffer
allocation and copies of id/JPEG bytes. The merge-base arm has none of those
new operations. These costs, the binary transport and the switch from Image to
ImageBitmap are measured together. They are candidates for an upstream timing
change, not measured causes; this experiment does not isolate their CPU or
latency contributions.

The receiver freezes its counters after the click/settle loop. Latency uses
receiver performance.now before mousePressed and immediately before drawing
the changed marker, with readback after that timestamp. Bytes use received
message byteLength (text length for ASCII JSON). The inherited JSON instrument
adds a frameIndex field, about 18 bytes per frame, for tracing; binary uses
the receiver's frame count. This small fixture overhead is included. Neither
message count includes websocket/TCP/TLS overhead.

Rates below divide total measured bytes/frames by total receiver-window time.
Bytes/frame divides total measured message bytes by received frames. Latency
quantiles use all 100 ordered click samples per mode. CPU weights each scope
window by its duration. Raw logs retain per-block values, capture timestamps,
buffers, all load averages and CPU counters. Load is measured, not assumed
constant. Mean window endpoint load is 9.57 for JSON and 9.80 for binary; the
balanced order reduces the earlier order bias but does not make the shared box
controlled or isolate the cost of each implementation change.

| Path | Message bytes/frame | Mbit/s | Delivered / painted fps | Click median / p95 ms | Server CPU % |
| --- | --- | --- | --- | --- | --- |
| Merge-base JSON / Image | 36,448 | 4.64 | 15.92 / 15.69 | 201.6 / 494.2 | 178.6 |
| Binary / ImageBitmap | 27,292 | 3.44 | 15.76 / 14.83 | 232.3 / 546.3 | 184.6 |

Binary saves **25.1% per received frame** at the same image quality. Its measured
traffic rate is 25.9% lower, with similar delivered fps. The binary arm still
has higher pooled click latency and lower painted fps in this counterbalanced,
software-rendered headless fixture. This is an observed bundle-level tradeoff,
not an isolated transport or ImageBitmap effect or a prediction for members.
The earlier fixed-order latency delta was confounded with run order and is
superseded by this table; its dated artifacts are retained below.

| Receiver-clock leg | JSON / Image median / p95 ms | Binary / ImageBitmap median / p95 ms |
| --- | --- | --- |
| Mouse send to changed-frame arrival | 187.4 / 491.7 | 194.2 / 467.6 |
| Changed-frame arrival to draw | 4.9 / 27.9 | 23.6 / 121.0 |

The first leg includes target capture and scheduling as well as transport. The
second includes pending-slot wait and the named decode API. Medians of the
legs do not sum to an exact partition of the total median. JSON had zero
decode errors and 9 pending replacements; binary had zero errors and 41
pending replacements. An overwritten pending JPEG never creates a bitmap.

The pressure ladder stayed at rung 0 during the comparison: all 1,490 recorded
fan-outs in the eight counterbalanced buffer CSVs report zero Bun buffered
bytes (156–211 samples per run). The earlier fixed-order comparison also had
zero nonzero readings in all 1,493 samples. Capture degradation therefore does
not explain the observed timing differences. The timer and binary encoding
work still run at rung 0, as described above; the paused-reader run separately
exercises the degradation and recovery steps.

All rows below are 2026-09-12 UTC. Loads are one-minute load averages at both
ends. Scope load covers the whole run; window load covers the timed samples.

| Block / path | Timed window UTC | Window load | Scope load |
| --- | --- | --- | --- |
| 1 / json | 05:54:03 → 05:54:12 | 5.00 → 6.48 | 3.17 → 6.48 |
| 1 / binary | 05:54:26 → 05:54:38 | 7.85 → 8.62 | 6.84 → 8.62 |
| 2 / binary | 05:54:51 → 05:55:01 | 9.65 → 9.58 | 8.49 → 9.58 |
| 2 / json | 05:55:13 → 05:55:26 | 11.02 → 10.64 | 10.41 → 10.64 |
| 3 / binary | 05:55:39 → 05:55:52 | 10.82 → 10.90 | 10.19 → 10.90 |
| 3 / json | 05:56:03 → 05:56:12 | 10.53 → 10.37 | 10.67 → 10.37 |
| 4 / json | 05:56:26 → 05:56:39 | 11.23 → 11.31 | 11.22 → 11.31 |
| 4 / binary | 05:56:51 → 05:57:04 | 10.76 → 10.23 | 10.57 → 10.23 |

Evidence: `counterbalanced-{1,2,3,4}-{json,binary}.log`, click and buffer CSVs,
`report-counterbalanced.json`, and `report-counterbalanced.py` in the evidence
directory. `compare-counterbalanced.sh` records the order. The only instrument
addition is the viewer-backend query outside the timing window, in both arms.
No npm package, native module or system binary was added.

### Superseded fixed-order comparison

The 2026-09-12 05:31–05:34 UTC run always put JSON first. Its click median/p95
was 199.5/497.5 ms for JSON and 273.1/640.3 ms for binary, but mean window load
was 7.12 versus 8.27. That latency delta was confounded with run order and is
not used as the shipping comparison. The 25.1% message-byte saving remains a
frame-size observation. Raw `final-*` logs and CSVs, `report-fixed-order.json`,
and the original `compare.sh` retain that dated experiment and both endpoint
loads. These rows are not spliced into the counterbalanced table.

### Rejected decode diagnostic

The first full comparison, 2026-09-12 05:17–05:21 UTC on `f7aae820`, used Image
with Blob URLs for binary. It measured 25.07% fewer message bytes/frame, but
click median/p95 was 365.9/946.4 ms versus JSON's 171.4/491.0. Delivered/painted
fps was 11.27/9.58 versus 17.91/17.52. Those rows are not spliced into the final
comparison. Raw `compare-*` logs and `blob-report.json` retain their dates and
start/end load, which ranged from 7.74 to 12.30 in the timed windows.

Source inspection confirmed revokeObjectURL ran in finish after drawImage
inside onload, not immediately after assigning src. A separate 25-click
counted Blob diagnostic (`blob-counted.log`, 2026-09-12) recorded 177 completed
decodes, zero errors, and 23 pending replacements. It supports slow decoding
with pending replacement rather than failed image loads. It does not prove
all causes of the larger upstream latency. Short ImageBitmap and local-data-URL
probes are in `bitmap-probe.log` and `data-url-probe.log`; neither substitutes
for the final interleaved table. The local-data-URL prototype is not shipped.

## Three decode paths: keep ImageBitmap

Task b5abd8cc, measured 2026-09-12 UTC on
`18e0da8cd0dd650e3f12f740413cea239afcfa6e`. **No product code change.**
Object URL fails the decision rule; the current decoder and fallback stay.

The loopback fixture uses the same moving 1280x800 canvas, click marker,
650 CSS-pixel production panel and 640x400 decoded surface as above. J is the
pinned `0bbd92b4` JSON/Image baseline; B is current binary/ImageBitmap; O is
current binary/object-URL/Image. A Bun `onLoad` build transform removes O's
bitmap branch, including its fallback, and uses Image/onload with the same
paint helper, pending slot and epoch guard. It revokes the URL after paint in
`finally`, or on error. Arrival lookup completes before revoke. The decision
requires zero errors in all arms. No product file changed to make O.

The batch order is **JBO, BOJ, OJB, OBJ, BJO, JOB**, with 25 clicks per window
and 150 per arm. Each arm occupies each position twice; each directed adjacent
pair occurs twice within blocks. Startup and settle procedures are the same;
actual gaps vary with process startup/teardown. Each run uses a fresh viewer
without an office profile, with separate 2 GiB target and viewer scopes.
The order balances position and within-block carryover, not shared-box load.

All 18 pre-window CDP viewer queries report Chrome 151.0.7922.137, ANGLE
SwiftShader Device (Subzero), driver 5.0.0, GPU compositing `disabled_software`.
Every log retains its full `viewerBackend`; `report-five.json` retains device,
version and compositing per run. No member browser with a real GPU was measured.

The primary endpoint is **immediately after `drawImage` returns**, before
marker readback. J and O retain `onload`, without `image.decode()`. The earlier
2026-09-12 bandwidth table stops before draw and is not a fourth data point.
Neither endpoint measures display presentation. Readback is timed separately;
it falls outside latency but can affect later scheduling.

The timing rule, recorded in `decision-four.txt` at 06:16 UTC before the run,
requires O's pooled arrival-to-draw-complete median to be at least 25% **and**
5 ms below B, p95 no worse, and median improvement in at least four of six
blocks. `decision-five.txt` also requires 150 matching click/leg samples per
arm, zero errors, identical binary envelopes and O bytes/frame within 1% of B.
Its recorded 32-byte envelope is an arithmetic slip: `bench` has five bytes,
so both arms' same encoder and id give **33 bytes**. The decision file remains
unchanged; its identical-envelope criterion is satisfied. No repeat is allowed
to seek a better result.

The following tables are the 2026-09-12 loopback receiver measurement. Rates
use pooled bytes/frames divided by receiver-window time, excluding
websocket/TCP/TLS overhead. Quantiles select floor(n * fraction) from sorted
samples: 150 clicks/legs, all timed draws, or marker readbacks as labelled.
Medians of separate legs do not add to the total median.

| Arm | Message bytes/frame | Mbit/s | Delivered / painted fps | Click to draw complete median / p95 ms |
| --- | --- | --- | --- | --- |
| json | 36,432 | 4.32 | 14.82 / 14.50 | 230.6 / 512.8 |
| binary | 27,292 | 3.32 | 15.22 / 14.40 | 217.3 / 610.2 |
| object | 27,303 | 3.45 | 15.81 / 14.28 | 241.2 / 590.3 |

| Receiver-clock measure | JSON / Image | Binary / ImageBitmap | Binary / object URL / Image |
| --- | --- | --- | --- |
| Mouse send to changed-frame arrival median / p95 ms | 213.9 / 501.7 | 176.7 / 566.6 | 181.9 / 514.0 |
| Arrival to before draw median / p95 ms | 7.0 / 37.4 | 23.7 / 92.6 | 30.2 / 145.0 |
| drawImage duration (all timed draws) median / p95 ms | 0.1 / 3.7 | 0.1 / 1.0 | 0.1 / 1.9 |
| Arrival to draw complete median / p95 ms | 8.1 / 44.5 | 24.1 / 92.6 | 30.5 / 145.0 |
| Marker readback duration (outside latency) median / p95 ms | 7.3 / 70.0 | 0.4 / 5.8 | 6.9 / 39.4 |

| Block / arm | Window UTC (2026-09-12) | Window load | Scope load | Arrival to draw complete median / p95 ms |
| --- | --- | --- | --- | --- |
| 1 / json | 06:19:55 → 06:20:08 | 9.05 → 9.56 | 8.72 → 9.56 | 7.1 / 59.4 |
| 1 / binary | 06:20:22 → 06:20:38 | 10.64 → 11.87 | 9.13 → 11.87 | 30.2 / 126.7 |
| 1 / object | 06:20:54 → 06:21:10 | 12.18 → 12.87 | 11.88 → 12.87 | 53.1 / 192.0 |
| 2 / binary | 06:21:21 → 06:21:30 | 13.07 → 12.08 | 13.60 → 12.08 | 21.2 / 79.6 |
| 2 / object | 06:21:43 → 06:21:56 | 12.75 → 12.37 | 12.47 → 12.37 | 42.9 / 208.1 |
| 2 / json | 06:22:11 → 06:22:22 | 13.06 → 11.85 | 11.70 → 11.85 | 6.7 / 17.8 |
| 3 / object | 06:22:31 → 06:22:43 | 11.72 → 11.67 | 11.87 → 11.67 | 21.2 / 85.4 |
| 3 / json | 06:22:57 → 06:23:10 | 11.51 → 12.10 | 11.22 → 12.10 | 15.7 / 51.4 |
| 3 / binary | 06:23:22 → 06:23:36 | 12.94 → 12.16 | 13.37 → 12.16 | 24.1 / 121.8 |
| 4 / object | 06:23:50 → 06:24:01 | 12.44 → 12.44 | 11.43 → 12.44 | 18.8 / 82.3 |
| 4 / binary | 06:24:16 → 06:24:26 | 12.73 → 11.92 | 11.92 → 11.92 | 17.2 / 41.7 |
| 4 / json | 06:24:39 → 06:24:51 | 14.41 → 14.77 | 14.01 → 14.77 | 7.0 / 25.5 |
| 5 / binary | 06:25:04 → 06:25:17 | 14.76 → 13.39 | 14.31 → 13.39 | 26.5 / 99.1 |
| 5 / json | 06:25:31 → 06:25:44 | 13.31 → 13.95 | 13.11 → 13.95 | 5.8 / 22.9 |
| 5 / object | 06:26:00 → 06:26:13 | 12.40 → 11.50 | 12.71 → 11.50 | 31.2 / 123.2 |
| 6 / json | 06:26:25 → 06:26:37 | 12.28 → 12.33 | 10.74 → 12.33 | 7.6 / 35.4 |
| 6 / object | 06:26:50 → 06:27:04 | 11.52 → 11.38 | 11.82 → 11.38 | 26.2 / 123.4 |
| 6 / binary | 06:27:17 → 06:27:28 | 10.60 → 9.95 | 11.09 → 9.95 | 25.0 / 73.4 |

| Arm | Click / send-arrival / arrival-draw samples | Decode errors / pending replacements | Timed draws / marker readbacks |
| --- | --- | --- | --- |
| json | 150 / 150 / 150 | 0 / 21 | 1052 / 560 |
| binary | 150 / 150 / 150 | 0 / 59 | 1043 / 586 |
| object | 150 / 150 / 150 | 0 / 114 | 1086 / 607 |


Window and scope loads are the box's one-minute averages at both ends; logs
retain all three averages and scope timestamps. Mean window endpoint load is
J 12.35, B 12.18, O 12.10. All 3,495 buffer samples are zero (J 1,135; B 1,126;
O 1,234), so the pressure ladder stays at rung 0. CPU is not compared here.

B and O's envelopes are 28 header bytes plus the five-byte `bench` id. Their
received JPEG payloads therefore average 27,258.7 and 27,269.5 bytes (message
size minus 33). Mean message sizes differ by 0.039% between these independent
animated captures. Source-window JPEG means are J 27,253.6, B 27,258.8 and
O 27,267.9 bytes; that window differs slightly from receiver counting and
cannot yield an exact JSON envelope by subtraction. J carries base64, JSON
and the inherited `frameIndex` trace field. O saves 25.06% of message
bytes/frame versus J. Object URLs add one URL allocation and revoke per decode;
this run makes no thread claim.

O's arrival-to-draw-complete median/p95 is **30.5/145.0 ms**, versus B's
**24.1/92.6** and J's **8.1/44.5**. O improves in only one of six blocks and
fails the median and p95 criteria. No decoder change ships.

B is faster overall than J in this run: **217.3 versus 230.6 ms** median.
Its changed frame arrives about 37 ms sooner (176.7 versus 213.9), while its
arrival-to-draw leg is about 16 ms longer. The earlier run's total went the
other way. With changed endpoints and shared-box variation, neither run
establishes an overall speed advantage; the bandwidth saving and ordering of
the arrival-to-draw medians persist.

The arrival-to-draw leg is **not an isolated decode measurement**. It includes
pending-slot wait. Pending replacements are J 21, B 59 and O 114; the binary
arms also deliver more frames. Arrival rate and superseding can affect this
leg, and this confound remains unresolved. Removing ImageBitmap did not remove
the extra cost, so ImageBitmap alone cannot explain it. The cause remains open
between Blob loading, pending-slot wait and scheduling. This does not prove a
cost from binary framing or say that a member browser with a GPU pays it.

Draw medians are 0.1 ms in all arms, but readback medians differ: J 7.3, B 0.4,
O 6.9 ms. Readback can flush deferred canvas work; these latency endpoints do
not capture total rendering cost.

The old 05:17 Blob arm received 11.27 fps against JSON's 17.91; here O receives
15.81, B 15.22 and J 14.82. The old deficit was in receipt rate, before the
arrival-to-draw leg it was used to judge, and this object-URL run does not
reproduce it. Both the old `f7aae820` arm and O create an Image per frame and
revoke after onload paint; effect-scoped versus frame-local URL ownership is
structural under serial decoding. This run changes order and endpoint, but
neither that nor the code difference establishes the old delta's cause. The
old dated rows remain; this run supersedes them for the decoder decision.

Evidence: `/home/nil/nil/browser-bandwidth-evidence/`, `five-*-{json,binary,object}`
logs, click/buffer CSVs and injected `-panel.tsx` files; `five-benchmark.ts`,
`five-panel.tsx`, `three-bridge.cjs`, `compare-five.sh`, `decision-{four,five}.txt`,
`report-five.{py,json}` and `tables-five.md`. Script imports point at this
worktree and must point at the reproduction checkout. The file prefix is an
instrument revision, not an arm count. No dependency was added.

On 2026-09-12, `three-*` stopped on the timing-review blocker and `four-*` was
lost to process teardown during an interrupted chat turn after two completed
windows. Both remain excluded. The independent transient-unit launch first
failed before timing because Bun was absent from PATH (`five-launch-failure.log`).
After supplying PATH, all 18 `five-*` windows and the batch ended `exit=0`.
No measurement was repeated to select a better result.
