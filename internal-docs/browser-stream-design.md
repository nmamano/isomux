# Browser stream architecture decision

Measured 2026-09-16. Design only; no product change.

## Decision

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
