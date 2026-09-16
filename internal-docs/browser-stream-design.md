# Browser stream architecture decision

Measured 2026-09-16. Design only; no product change.

## Decision

Round 1b measured both arms on shaped links and did not change this decision.

**Do not replace the shipped stream on this evidence.** External H.264 over a
TCP WebSocket is the best next architecture candidate, but it did not meet Nil's
bar of a visible latency gain. On the moving page it measured 102.7/130.2 ms
median/p95 against fresh full-resolution JPEG at 104.3/134.5 ms. Its bandwidth
fell from 16.74 to 5.22 Mbit/s. That is useful compression, not a demonstrated
interaction improvement. Keep the result negative rather than compare it only
with an older, more heavily loaded host.

The ordinary page exposes a separate shipped JPEG defect: **the same periodic
stall occurred in all four blocks**. Of 100 trials, 64 missed the two-second
deadline; all 36 successes were the first click after a failed trial and capture
restart. This is a deterministic fixture result, not an estimated random failure
rate. Every-frame JPEG and all four complete external-display variants delivered
100/100. That result requires a
separate capture fix; it does not prove that video itself makes general browsing
feel local. The PM has recorded the defect separately. This design does not fix it.

If Nil authorizes another stream round, use headful Chrome on an isolated virtual
display, external H.264 encoding, and the existing one-port TCP route through
Caddy as its starting architecture. Do not add WebRTC on this evidence: the
measured Neko path is slower and requires UDP that the deployment does not offer.
No implementation is authorized by this document.

## Candidates and source basis

1. **External display capture.** Xvfb plus ffmpeg x11grab sends raster pixels to
   libx264 and WebCodecs over a TCP WebSocket. The measured Annex B variant waits
   for the next access-unit delimiter to frame a packet. A loopback-RTP framing
   experiment passed its busy block but lost a local packet during ordinary-page
   startup, closed the decoder, and never reached timing; it has no 100-trial
   result. Neko is a separate measured VP8/WebRTC implementation. Its
   [capture documentation](https://neko.m1k1o.net/docs/v3/configuration/capture)
   describes X display capture through GStreamer, ximagesrc and appsink, including
   software VP8 and x264 pipelines. Neither path needs browser tab-capture consent.
2. **Improved CDP capture.** The [CDP schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)
   exposes JPEG/PNG, quality, maximum dimensions and everyNthFrame. It does not
   expose a WebP screencast format or damage rectangles. This spike measures
   everyNthFrame=1 separately from shipped everyNthFrame=2. PNG and custom
   screenshot differencing are unmeasured; differencing after capture would still
   pay capture/decode work. A frame budget can limit queued work but cannot make a
   missing final static frame arrive. Do not describe the variant as shipped JPEG.
3. **Other rendering prior art.** [Cloudflare's NVR account](https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/)
   describes interception of pre-raster Skia commands and replay in WebAssembly.
   It describes proprietary technology, not an implementation measured here.
   [Chromium's compositor documentation](https://raw.githubusercontent.com/chromium/chromium/main/docs/how_cc_works.md)
   distinguishes recorded paint operations from raster bitmaps/textures. Capturing
   an X display gets the resulting pixels; it does not recover that command stream.
4. **Damage-region display protocols.** KasmVNC is the primary measured candidate;
   TigerVNC/noVNC is the simpler comparison. [KasmVNC](https://github.com/kasmtech/KasmVNC)
   departs from legacy RFB and supplies its own browser client. Its
   [configuration](https://kasmweb.com/kasmvnc/docs/latest/configuration.html)
   describes framebuffer comparison, rectangle quality, and JPEG/WebP video-mode
   thresholds. These moving docs explain the family; measurements below use
   KasmVNC 1.3.4, not a claim about current defaults. [Xpra's HTML5 client](https://github.com/Xpra-org/xpra-html5)
   and [encoding choices](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Encodings.md),
   and [Guacamole's browser/guacd architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html),
   are sourced prior art, not additional measured rows.
5. **Scramjet with an injected DOM mirror and action bridge:** recorded and not
   measured this round by Nil's ruling. Task 5add7b5d, “Browser stream for general
   browsing,” on the [office task board](https://office.nilmamano.com/tasks) records
   Nil's manual five-site load/typing success and the remaining playback,
   Amazon load, navigation/reload and AGPL blockers; it also records that the
   automated harness overstated site challenges. This is a reported manual result,
   not a conclusion from this stream benchmark.

## Measurements

The retained evidence is on branch `browser-stream`, commit `59cb2366`, path
`prototypes/stream/evidence/`. Its `summary.json` contains all 48 completed block
records, including source hashes and endpoint loads. The method and run
instructions are on the same branch at commit `6633a99d`, path
`prototypes/stream/README.md`. These commits are local and unpublished; readers
need a checkout that retains them and can use `git show <commit>:<path>`.
Retain that branch. The prototype and evidence do not merge; the PM cherry-picks
this document.

All rows have 1280x800 source and decoded pixels. The JPEG rows override
`pool.watch` capture bounds to 1280x800 for pixel parity; the shipped default
sizes capture to the watcher, and the 4.61 Mbit/s historical anchor below is that
640x400 sized configuration. The 16.74 Mbit/s row is not the default panel's
bandwidth. JPEG and its variant use a
650x500 CSS panel with a 650x379 canvas box and contained image. H.264 uses a
640x400 CSS canvas. Kasm and Tiger use 1280x800 CSS canvases. Neko uses a
1280x800 viewer viewport with its native controls; its screenshot shows the video
at about 1016x635 CSS, and its hidden observer canvas is 1280x800. Equal decoded
pixels do not imply equal CSS size or equal visual quality. The separate
`dimensions-*.txt` probes verify the host canvas dimensions; Neko RTC stats verify
1280x800 video. Those probes are not extra latency samples.

### Moving canvas

| Path | Success / trials | Median / p95 ms¹ | Mbit/s² | Target CPU %³ | Target peak MiB³ |
| --- | --- | --- | --- | --- | --- |
| Shipped JPEG, full resolution | 100/100 | 104.3 / 134.5 | 16.74 | 176.0 | 544 |
| JPEG every frame (variant) | 100/100 | 123.7 / 193.6 | 29.98 | 171.3 | 543 |
| Xvfb → H.264 → WebSocket | 100/100 | 102.7 / 130.2 | 5.22 | 157.8 | 584 |
| KasmVNC | 100/100 | 283.1 / 420.9 | 9.81 | 261.0 | 900 |
| Neko / VP8 / WebRTC | 100/100 | 173.9 / 311.4 | 2.21 | 179.1 | 569 |
| TigerVNC / noVNC | 100/100 | 130.8 / 186.3 | 26.77 | 151.6 | 491 |

### Ordinary text

This bandwidth column measures a scroll-dominated workload: the controller
scrolls to `(i%5)*240` and types before every click, repainting the viewport.
Idle or quiet static-page traffic was not measured.

| Path | Success / trials | Median / p95 ms¹ | Mbit/s² | Target CPU %³ | Target peak MiB³ |
| --- | --- | --- | --- | --- | --- |
| Shipped JPEG, full resolution | 36/100 | 64.7 / 97.0 | 0.95 | 20.5 | 493 |
| JPEG every frame (variant) | 100/100 | 63.7 / 89.6 | 6.69 | 60.0 | 531 |
| Xvfb → H.264 → WebSocket | 100/100 | 81.3 / 102.5 | 3.03 | 106.8 | 553 |
| KasmVNC | 100/100 | 82.5 / 109.8 | 5.89 | 62.5 | 900 |
| Neko / VP8 / WebRTC | 100/100 | 123.1 / 188.2 | 1.95 | 140.5 | 601 |
| TigerVNC / noVNC | 100/100 | 31.2 / 49.3 | 23.09 | 42.9 | 478 |

¹ Quantiles include successful trials only. All 36 ordinary JPEG successes
immediately followed a failed trial and capture restart: 64.7/97.0 ms describes
those first clicks after repair, not continuous ordinary interaction. No block's
first trial succeeded, and no success followed a success. Every mode has the
same two-second deadline.

² Byte bases differ: JPEG counts binary image messages plus their application
header; H.264 counts payload plus its one-byte keyframe prefix; Kasm and Tiger
count all WebSocket message bodies; Neko counts inbound video RTP payload.
These exclude TCP/TLS/IP overhead; Neko also excludes signaling, audio and
ICE/DTLS/UDP overhead. VNC message counts are not frame counts.

³ CPU is percent of one core. Each target and viewer has a 2048 MiB limit. Target
memory peaks include controllers for host runs; controller CPU is subtracted.
Container totals include the desktop and helpers, excluding the outside controller
and viewer. Container peaks cover their lifetime across blocks, not a reset peak
per page. These are whole configurations, not isolated codec costs.

The September 12 historical anchor was **195.2/448.0 ms at 4.61 Mbit/s**, but its
source was 1280x800 and its decoded image was **640x400** in a 650 CSS-pixel panel.
The prior H.264/WebRTC tab-capture result was 525.1/896.6 ms at 1.27 Mbit/s,
decoded at 1280x800. The [round-three record](browser-panel-round-3.md) reports a
loaded host with one-minute load above eight at every endpoint. This fresh run's
endpoint loads range from 2.32 to 9.24. Neither the different pixels nor the
different host load permits an old-versus-new speedup claim. Fresh JPEG is the
control for the decision above.

## What the comparison establishes

External TCP H.264 has the best moving-page bandwidth/latency balance among the
complete TCP candidates, but its latency matches JPEG. Every-frame JPEG improves
ordinary-page completion and is faster there, but raises busy bandwidth to
29.98 Mbit/s and busy p95 to 193.6 ms. Tiger's 31.2/49.3 ms ordinary-page response
is the fastest, but its 23.09 Mbit/s scroll-dominated traffic and slower moving-page
result do not justify choosing it for general browsing on this evidence. This does
not establish its bandwidth on a quiet page or rule out a damage-region advantage
there. Kasm's tested configuration is
slower on the moving page. Neko saves bandwidth but loses latency and does not
satisfy the one-port TCP constraint. These findings apply to the tested versions
and settings, not every possible configuration in those families.

On the moving page JPEG receives about 29.7 fps, every-frame JPEG 53.2 fps,
H.264 30.5 fps and Neko decodes 25.0 fps. Native VNC frame rates are not measured.
Matching-frame arrival-to-draw median/p95 is JPEG 13.0/22.5 ms, every-frame JPEG
24.8/43.3 ms, and H.264 2.2/8.9 ms. These are different decoder paths and do not
partition total latency by subtraction. VNC only pairs a draw with the latest
WebSocket packet, so its values in the raw summary are approximate. Neko's
WebSocket arrivals are signaling, not video; the summary omits that split.

Busy-page endpoint PSS averages are about 277 MiB Chrome plus 248 MiB harness for
JPEG; H.264 has 244 MiB Chrome, 31 MiB Xvfb, 36 MiB encoder and 227 MiB harness.
Kasm has 440 MiB Chrome, 90 MiB display/encoder and 335 MiB helpers; Tiger has
260 MiB Chrome, 34 MiB display/encoder and 170 MiB helpers. These snapshots are
not peaks and do not replace the cgroup totals. Neko's main-run component probe
could not read neko-owned smaps as root; its component breakdown is incomplete.
A separate three-trial `neko-parts.txt` diagnostic under the process owner reports
454 MiB Chrome, 315 MiB display/encoder and 22 MiB readable helpers. It is not a
substitute for the main run, and excludes root-owned helpers from that breakdown.
The full-container totals in the table remain valid.

## Method and limits

Each mode has four interleaved blocks of 25 trials per page. Mode order reverses
on alternate blocks. The busy page moves 160 labelled rectangles. The ordinary
page has paragraphs, links and an input; before each marker click the controller
scrolls and inserts text, then settles for 100 ms. The timing measures the next
marker change, not keystroke echo or scroll latency. All input uses CDP. Fresh
fixture profiles contain no member authentication.

The viewer timestamps mousePressed send and the draw that first contains the
changed 200x200 black/white marker, immediately before drawing. Pixel readback
follows that timestamp but can affect later scheduling. Neko adds a hidden
canvas on requestVideoFrameCallback; the native VNC instrumentation checks canvas
operations. In particular, repeated readback on a rectangle-based client may
have different overhead from a full-frame decoder. The result does not isolate
that cost, codec quality, browser-version effects or real-device presentation.
All paths use local connections on a shared host; WAN loss, constrained links,
long-session behavior and actual member-perceived improvement are unmeasured.

A JPEG failure triggers a capture reset **between** trials as instrument repair,
not shipped behavior. All four ordinary JPEG blocks have the same 25-trial
sequence, repeating `f f F S f S f S f S`: `S` is success, `f` is failure with
zero captured/received frames, and `F` is failure with one captured/received
frame that did not show the change. Its period ten matches the five-position
scroll cycle combined with the two marker states. Across all blocks, 52 failures
had captured=0/received=0 and 12 had captured=1/received=1. Every success follows
a failed trial's capture reset. These counts distinguish a missing frame from a
received frame without the required repaint; dispatching input or receiving any
frame is not sufficient proof of an update. A final-still fix must capture the
repainted state, rather than merely request a still at input dispatch.

The unrepaired `static-diagnostic-30.txt` and target/viewer PNG pair show
that the target changed while the viewer remained stale after 30 seconds.
[BrowserPool.humanInput](../server/browser-session.ts) dispatches input but does
not request a final still; capture seeds a still only on start. The office handler
calls that same input method. The every-frame variant is separately labelled so
its complete ordinary result cannot hide the shipped behavior.

The full sweep uses instrument commits c3403913 and ccbd863b; only the resume
runner and method document changed between them. The runner resumed completed
blocks after the local-RTP experiment failed before timing. It retained all
completed six-mode blocks rather than selecting samples by speed. Later commits
add post-timing dimension output and the corrected separate Neko component probe;
these do not rewrite the 100-trial results. Small resource probes are outside the
marker window but add work to the cgroup CPU window.

Versions and image digests are retained in `environment-*.txt`: host Chrome
151.0.7922.137, ffmpeg 7.0.2, TigerVNC 1.13.1 and noVNC 1.3.0; Kasm image 1.17.0
with Chrome 135.0.7049.52 and KasmVNC 1.3.4; pinned Neko image with Chrome
151.0.7922.75, GStreamer 1.26.2 and libvpx 1.15.0. Neko's binary reports dev@dev,
so its image digest is the version pin. The containers use their shipped desktop
stacks and Chrome launch defaults; these are isolated fixtures, not a proposed
production security configuration.

Headful Chrome gives external capture a normal display surface. It does not
prove a bot-detection bypass: [modern Chrome shares headless and headful code](https://developer.chrome.com/docs/automation-and-testing/headless).
No login, challenge or persistent member-profile workflow was tested here.

The following items are deferred by Nil's 2026-09-16 scope ruling.

Human takeover and return of control: deferred.

Selectable text overlay: deferred.

Phone codecs and interaction: deferred.

JPEG migration: deferred; keep the existing path until a replacement is proven.

## Round 1b: link-shaped measurements

Measured 2026-09-16. **The replacement decision is unchanged.** H.264 did not
reduce click latency under either shaped link. It did deliver ordinary-page
scrolling at about 30 painted fps, where shipped JPEG delivered about 10, and it
completed every ordinary-page click. These are useful findings for the next
candidate; they do not establish a general latency or resolution improvement.
The JPEG pressure controller never left level 0 in this geometry.

Evidence and the recompute script are on branch `browser-stream`, commit
`4f8097f0`, at `prototypes/stream/evidence/link-*` and
`prototypes/stream/link-report.py`. Run the latter from that checkout's root;
`link-summary.jsonl` contains the tables, raw counter totals, per-block link
checks, 250 ms rung traces and skipped source-index sets. `LINK-METHOD.md` in
`prototypes/stream/` gives the run method. These are unpublished retained commits,
resolved with `git show <commit>:<path>`, not public download links.

### Geometry, traffic and link verification

The viewer is 1320x920 at **DPR 1**, with a 650x500 panel throughout both profiles.
JPEG mounts the shipped panel, honours its page-resize and capture-bound messages,
and runs the shipped sender and pressure controller. There is no full-resolution
watch override. The geometry below applies to every page/profile cell. The one
extra H.264 source line makes YUV420 dimensions even; there is no letterboxing.

| Arm | Source viewport | Requested capture bound | Encoder input | Decoded pixels |
| --- | --- | --- | --- | --- |
| JPEG | 650x379 | 656x384, clipped to source | CDP JPEG | 650x379 |
| H.264 high | 650x380 | Fixed display | 650x380 | 650x380 |
| H.264 low | 650x380 | Fixed display | 650x380 | 650x380 |

The phone profile is a link model, not a phone device or phone viewport. A real
phone at DPR 2–3 sends a different capture bound and may settle on a different
rung; this round has no DPR 2 probe. These numbers are not comparable to round
one's 1280x800 source. The viewer uses software rendering and decoding on the
host, not mobile hardware. The binary frame-index observer also adds readback work.

Toxiproxy 2.12.0 runs in a bounded container, pinned to image digest
`sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e`.
Each direction applies bandwidth then 80 ms latency, with no random loss or
jitter. Phone rates are 8 Mbit/s down and 2 up; laptop rates are 25 down and 5 up.
The bandwidth rates are 1000/250 and 3125/625 decimal KB/s respectively.
Frames, clicks and scroll input share one shaped WebSocket, so click latency
includes the uplink. Static bundles and the measurement controller stay local.

The [latency toxic](https://github.com/Shopify/toxiproxy/blob/v2.12.0/toxics/latency.go)
has a 1024-chunk queue; the [default toxic buffer](https://raw.githubusercontent.com/Shopify/toxiproxy/v2.12.0/toxics/toxic.go)
is zero for bandwidth. The
[connection chain](https://github.com/Shopify/toxiproxy/blob/v2.12.0/link.go) and
Linux socket buffers also affect queued data. Every arm/profile uses the same
limits, including host `tcp_rmem=4096 131072 6291456` and
`tcp_wmem=4096 16384 4194304`. A deeper queue can delay pressure feedback and
increase stale-frame delay; this model does not establish a cellular radio's
queue behaviour. A chunk limit is not an exact byte limit.

Each block records five TCP/WebSocket echo round trips and saturated payloads in
each direction before browser startup, then before and after measurement while
the arm generates animation traffic. Three-second-equivalent transfers include
request overhead in their achieved rates. Toxiproxy limits connections separately:
the probe and browser each receive the configured cap. Thus the loaded probe
checks shaper operation under concurrent traffic, not competition for one shared
aggregate cap. The following ranges cover all three checks in all retained blocks.

| Profile | Measured RTT range ms | Down Mbit/s range | Up Mbit/s range |
| --- | --- | --- | --- |
| phone | 161.8–194.7 | 7.62–7.78 | 1.89–1.94 |
| laptop | 161.5–205.2 | 23.61–23.90 | 4.79–4.87 |

The shaper wrapper has its own 512 MiB systemd scope; its container is capped at
256 MiB. Shaper CPU below comes from the container cgroup. Target/encoder and
viewer have separate 2 GiB scopes. All encoder and shaper logs end with exit 0.

H.264 uses libx264 baseline, ultrafast, zerolatency, two threads, 30 fps and GOP 30,
with CBR filler, a half-second VBV buffer and next-AUD Annex B framing. High is
90% of the downlink cap: **7.2 / 22.5 Mbit/s** for phone/laptop. Low is one third:
**2.666667 / 8.333333 Mbit/s**. Delivered rates, including filler, are below.
These encoder settings hold dimensions fixed; they do not measure equal visual
quality. All JPEG cells held **level 0, quality 50, scale 1, 650x379 for 100%**
of the sampled active block. The raw 250 ms series, rather than an end reading,
is retained. The worst-rung grid probe decoded eight known patterns at quality
20 and scale 0.5; no low-contrast grid transition occurred in the measured windows.

### Clicks and resource use

Each cell has four adjacent three-arm groups of 25 trials per arm. Arm order
reverses on alternate blocks. Every measured scroll and animation window lasts
10 seconds after its own 60 seconds of continuous load. The scrolling controller
sends wheel input at 20 Hz. The ordinary animation window moves paragraph text;
it is not a quiet-page bandwidth measurement. Click trials follow these windows,
with scroll/type preparation on the ordinary page and a two-second deadline.

| Link | Page | Arm | Success/trials | Median/p95 ms | Target CPU % | Target peak MiB | Shaper CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| phone | busy | JPEG | 100/100 | 241.2/269.5 | 137.7 | 507 | 7.9 |
| phone | busy | H.264 high | 100/100 | 263.6/296.1 | 132.8 | 576 | 8.2 |
| phone | busy | H.264 low | 100/100 | 264.8/294.1 | 136.4 | 548 | 7.9 |
| phone | ordinary | JPEG | 51/100 | 205.3/230.6 | 90.9 | 488 | 4.4 |
| phone | ordinary | H.264 high | 100/100 | 240.2/297.6 | 125.1 | 609 | 7.6 |
| phone | ordinary | H.264 low | 100/100 | 247.9/285.3 | 131.7 | 557 | 8.0 |
| laptop | busy | JPEG | 100/100 | 237.8/266.7 | 135.8 | 495 | 8.1 |
| laptop | busy | H.264 high | 100/100 | 266.5/336.1 | 135.3 | 568 | 12.9 |
| laptop | busy | H.264 low | 100/100 | 278.5/300.6 | 132.6 | 571 | 9.2 |
| laptop | ordinary | JPEG | 32/100 | 216.2/238.6 | 93.7 | 487 | 4.8 |
| laptop | ordinary | H.264 high | 100/100 | 250.1/301.7 | 138.0 | 590 | 13.9 |
| laptop | ordinary | H.264 low | 100/100 | 250.0/286.0 | 135.0 | 588 | 10.1 |

CPU is percent of one core over the active block, including warm-up and loaded
link checks. Target CPU subtracts the Node controller; target peak memory still
includes it. Viewer and shaper CPU are separate. Raw records give shaper CPU per
block; the table pools CPU time over elapsed time. These are configuration costs,
not isolated codec costs.

Quantiles use successful trials only, sorted index `floor(n*p)` capped at `n-1`.
A failed JPEG trial restarts capture before the next trial as an instrument
repair, not shipped behaviour. Ordinary JPEG failed 49 phone trials (45 with no
capture, 4 with captures) and 68 laptop trials (58 with none, 10 with captures).
The round-one identical period-10 sequence did not recur. The raw sequences now
vary and include consecutive successes; nevertheless these success-only timings
are not a claim of reliable continuous ordinary interaction. H.264 completed
100/100 in each ordinary cell.

### Scroll, animation and missing frames

Each row pools four 10-second windows of the named workload. Rates count painted
frames; received counts are separately reported below. Bytes are received
WebSocket payloads, including JPEG application headers or H.264's keyframe byte
and CBR filler, excluding TCP/TLS/IP overhead. Gap statistics use painted frame
timestamps within each window. A long gap is greater than 66.67 ms, twice the
nominal 30 fps period; window-boundary gaps are excluded.

| Link | Page | Arm | Window | Painted fps | Mbit/s | Gap p50/p95/max ms | Long gaps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| phone | busy | JPEG | scroll | 28.8 | 3.57 | 33.1/60.7/164.0 | 41 |
| phone | busy | JPEG | animation | 29.9 | 3.59 | 33.1/47.0/100.4 | 12 |
| phone | busy | H.264 high | scroll | 29.9 | 7.20 | 33.4/47.0/82.5 | 5 |
| phone | busy | H.264 high | animation | 29.8 | 7.20 | 33.1/47.5/125.1 | 8 |
| phone | busy | H.264 low | scroll | 30.0 | 2.66 | 33.1/53.5/104.0 | 27 |
| phone | busy | H.264 low | animation | 30.0 | 2.68 | 33.2/48.3/113.6 | 8 |
| phone | ordinary | JPEG | scroll | 10.0 | 2.59 | 100.3/117.1/138.0 | 393 |
| phone | ordinary | JPEG | animation | 25.2 | 6.53 | 34.8/67.9/329.2 | 58 |
| phone | ordinary | H.264 high | scroll | 30.0 | 7.20 | 32.9/49.5/106.9 | 42 |
| phone | ordinary | H.264 high | animation | 30.0 | 7.20 | 32.4/57.6/288.1 | 45 |
| phone | ordinary | H.264 low | scroll | 29.9 | 2.67 | 33.1/46.8/128.5 | 10 |
| phone | ordinary | H.264 low | animation | 29.9 | 2.66 | 33.1/51.8/115.9 | 19 |
| laptop | busy | JPEG | scroll | 29.3 | 3.60 | 32.9/59.2/157.9 | 32 |
| laptop | busy | JPEG | animation | 29.8 | 3.67 | 32.9/50.5/87.8 | 6 |
| laptop | busy | H.264 high | scroll | 30.0 | 22.51 | 32.1/44.9/78.7 | 4 |
| laptop | busy | H.264 high | animation | 29.9 | 22.45 | 32.4/44.2/106.1 | 4 |
| laptop | busy | H.264 low | scroll | 30.0 | 8.35 | 33.1/47.4/110.0 | 11 |
| laptop | busy | H.264 low | animation | 30.0 | 8.34 | 33.1/45.1/93.4 | 5 |
| laptop | ordinary | JPEG | scroll | 10.0 | 2.60 | 99.8/122.9/313.1 | 387 |
| laptop | ordinary | JPEG | animation | 23.7 | 6.12 | 35.0/82.8/255.7 | 105 |
| laptop | ordinary | H.264 high | scroll | 30.0 | 22.55 | 31.7/51.2/154.3 | 16 |
| laptop | ordinary | H.264 high | animation | 30.0 | 22.48 | 31.9/51.3/120.7 | 18 |
| laptop | ordinary | H.264 low | scroll | 29.9 | 8.31 | 32.9/55.0/153.7 | 27 |
| laptop | ordinary | H.264 low | animation | 29.9 | 8.33 | 33.0/50.9/82.9 | 6 |

The JPEG counters come from separate observation points, not inferred
subtractions. For H.264, capture and send counters increment on adjacent lines
of the same access-unit loop; their equal totals are not independent evidence
of loss-free capture or delivery. C is CDP callbacks for JPEG or parsed encoded access units for
H.264; S is server socket sends; R is viewer receives; D is decoder outputs;
P is paints. Replace counts a pending JPEG frame replaced in the sender. FF is
ffmpeg's own duplicate/drop count during these windows. JPEG's intentional
`everyNthFrame=2` is separate; H.264 captures at a fixed 30 fps. Frames in transit
cross the window endpoints, so these totals need not balance. A decode can also
finish after the receive window begins. Ordinary fixture RAF activity is not a
count of changed pixels.

For busy pages the 16-bit grid identifies source frames. Skipped counts are IDs
between forward observations that were not painted anywhere in that window,
with sets retained per run. They include intentional capture cadence and cannot
be labelled network losses. Ordinary pages have no grid. Two laptop JPEG scroll
transitions went backwards with high contrast; they are retained separately and
excluded from skip inference. They are not unreadable cells or 65,534-frame gaps.

| Link | Page | Arm | Window | C/S/R/D/P | Replace | Every Nth | FF dup/drop | Unseen source IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| phone | busy | JPEG | scroll | 1191/1191/1170/1152/1152 | 0 | 2 | — | 1170 |
| phone | busy | JPEG | animation | 1213/1213/1199/1198/1198 | 0 | 2 | — | 1198 |
| phone | busy | H.264 high | scroll | 1210/1210/1195/1195/1195 | 0 | — | 0/7 | 1201 |
| phone | busy | H.264 high | animation | 1203/1203/1193/1193/1193 | 0 | — | 0/7 | 1200 |
| phone | busy | H.264 low | scroll | 1223/1223/1202/1202/1202 | 0 | — | 0/0 | 1164 |
| phone | busy | H.264 low | animation | 1218/1218/1200/1199/1199 | 0 | — | 0/0 | 1187 |
| phone | ordinary | JPEG | scroll | 401/401/400/400/400 | 0 | 2 | — | — |
| phone | ordinary | JPEG | animation | 1026/1026/1011/1008/1008 | 0 | 2 | — | — |
| phone | ordinary | H.264 high | scroll | 1215/1215/1200/1200/1200 | 0 | — | 0/0 | — |
| phone | ordinary | H.264 high | animation | 1219/1219/1201/1201/1201 | 0 | — | 2/1 | — |
| phone | ordinary | H.264 low | scroll | 1212/1212/1198/1198/1198 | 0 | — | 0/3 | — |
| phone | ordinary | H.264 low | animation | 1214/1214/1197/1196/1196 | 0 | — | 0/3 | — |
| laptop | busy | JPEG | scroll | 1205/1205/1183/1171/1171 | 0 | 2 | — | 1185 |
| laptop | busy | JPEG | animation | 1214/1214/1195/1194/1194 | 0 | 2 | — | 1194 |
| laptop | busy | H.264 high | scroll | 1217/1217/1200/1200/1200 | 0 | — | 0/1 | 1190 |
| laptop | busy | H.264 high | animation | 1218/1218/1197/1197/1197 | 0 | — | 0/1 | 1195 |
| laptop | busy | H.264 low | scroll | 1218/1218/1202/1202/1202 | 0 | — | 0/0 | 1190 |
| laptop | busy | H.264 low | animation | 1211/1211/1201/1202/1202 | 0 | — | 0/0 | 1196 |
| laptop | ordinary | JPEG | scroll | 402/402/401/401/401 | 0 | 2 | — | — |
| laptop | ordinary | JPEG | animation | 957/957/949/948/948 | 0 | 2 | — | — |
| laptop | ordinary | H.264 high | scroll | 1217/1217/1203/1202/1202 | 0 | — | 3/2 | — |
| laptop | ordinary | H.264 high | animation | 1216/1216/1199/1200/1200 | 0 | — | 0/0 | — |
| laptop | ordinary | H.264 low | scroll | 1213/1213/1198/1197/1197 | 0 | — | 1/3 | — |
| laptop | ordinary | H.264 low | animation | 1210/1210/1198/1198/1198 | 0 | — | 0/2 | — |

### Exclusion, repeat and drift

The initial `link-1-phone-busy-h264high` block reused an auxiliary encoder file.
A non-truncating write left stale trailing bytes that read as current counters.
Detection followed reading the **first-nine success and frame counters**, before
calculating **click median or p95**. The whole adjacent block-1 phone/busy triple
was excluded and repeated in its original JPEG/high/low order after the sweep.
No field-level salvage enters the final tables. The discarded originals remain
at `prototypes/stream/bulk/discarded-link-first-phone-busy/` in the retained
worktree; `evidence/link-discarded-clicks.jsonl` retains their click trials for
independent reproduction of the comparison below.

The other 45 blocks use instrument `458d52c9f3d53a2201ece2713d86a39aedf5e6e1`.
The repeat triple uses `012f433b9ca0b6bc5941c4a937de7dc734a6a297`. The latter
commit only changes auxiliary output creation: it refuses existing paths in
setup and opens files exclusively. It changes no timed input, capture, encoder,
shaper or window logic; no file open was added inside a measured window. This
setup repair cannot directly alter the measured timing path, but host conditions
can differ between runs. The diff is retained for inspection.

The evidence lists size, birth, ctime and mtime for all 150 auxiliary outputs in
the unaffected blocks and 10 in the repeat. Every birth timestamp was available
and after its block log was created. No ctime substitutes for an absent birth.
`link-pre-repeat-listing.txt` records the empty active output names immediately
before the repeat. All retained runs have a source hash and exit line.

| Arm | Discarded success/25 | Discarded median/p95 ms | Repeat success/25 | Repeat median/p95 ms |
| --- | --- | --- | --- | --- |
| JPEG | 25 | 244.5/267.4 | 25 | 228.9/251.2 |
| H.264 high | 25 | 252.2/276.1 | 25 | 275.0/304.9 |
| H.264 low | 25 | 272.7/287.6 | 25 | 274.5/283.6 |

The repeat moved JPEG's median down 15.6 ms, high H.264's up 22.8 ms and low
H.264's up 1.8 ms. These are not a common drift correction. The per-block results
below expose that variation; neither the discarded nor repeated triple shows a
H.264 click-latency win. Block 1 is the later repeat, not the first time interval.

| Phone/busy block | Arm | Measurement start UTC | Success/25 | Median/p95 ms |
| --- | --- | --- | --- | --- |
| 1 | JPEG | 10:29:44 | 25 | 228.9/251.2 |
| 1 | H.264 high | 10:32:59 | 25 | 275.0/304.9 |
| 1 | H.264 low | 10:36:16 | 25 | 274.5/283.6 |
| 2 | JPEG | 08:29:13 | 25 | 241.8/273.2 |
| 2 | H.264 high | 08:25:56 | 25 | 246.4/274.7 |
| 2 | H.264 low | 08:22:38 | 25 | 267.2/331.7 |
| 3 | JPEG | 09:03:49 | 25 | 241.7/253.3 |
| 3 | H.264 high | 09:07:04 | 25 | 248.6/267.5 |
| 3 | H.264 low | 09:10:21 | 25 | 248.6/269.1 |
| 4 | JPEG | 09:51:24 | 25 | 244.8/270.3 |
| 4 | H.264 high | 09:48:06 | 25 | 276.8/305.6 |
| 4 | H.264 low | 09:44:48 | 25 | 264.8/291.3 |

### Reading Nil's complaints

**Lag:** H.264 adds no click-latency gain on either link; successful JPEG clicks
are faster, subject to the ordinary-page failure caveat. **Low resolution:** JPEG
holds its full 650x379 source at quality 50 and H.264 holds 650x380, so this DPR-1
round does not reproduce a pressure-induced resolution loss or prove a visual
quality win. The shipped code supplies an unmeasured candidate cause: the panel
sends a CSS-pixel viewport and requests CSS×DPR capture bounds, but
`server/browser-session.ts` clamps capture to the viewport and no code in
`server/`, `ui/` or `shared/` sets `deviceScaleFactor`; a DPR-2 or DPR-3 viewer
therefore spreads at most viewport-sized pixels across more physical pixels,
an upscale independent of ladder pressure, link speed or codec that this DPR-1
round could not test. **Laggy scrolling:** ordinary JPEG paints about 10 fps on both links,
while both H.264 settings paint about 30; this measures cadence, not a separate
wheel-to-frame latency. **Missed animation frames:** the grid records unseen
source IDs for all busy arms, including intentional cadence; H.264 does not
eliminate misses. Its long-gap counts usually improve, but low-rate H.264 on the
phone busy-animation window still has a longer maximum gap than JPEG.
**Animation smoothness:** ordinary text animation improves from 23.7–25.2 fps
with JPEG to about 30 with video, while busy animation is already about 30 for
all arms. Low-rate H.264 uses less bandwidth than JPEG for phone busy-page and
text-animation traffic, but slightly more for ordinary scrolling; high-rate CBR, especially on the laptop profile, spends substantially more.

This supports external H.264 as a smoother ordinary-page candidate, while keeping
the architecture replacement decision unchanged. Real phone rendering, higher
DPR, quiet-page traffic, loss/jitter and subjective text quality remain unmeasured.
No product implementation, takeover or migration is authorized here.
