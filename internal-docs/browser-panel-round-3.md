# Browser panel round 3

Review report, 2026-09-12. Task 4d9138d8. The running office has not been restarted.

## Decisions

The PM approved these rules on 2026-09-12:

- A room member may watch. Only the agent's manager may create, navigate, or
  close a page, or send pointer and keyboard input.
- Only manager watchers suspend the idle timer.
- Auto-open fires for an agent goto that creates a fresh page, for the manager
  viewing that chat. A later action does not undo a manual panel dismissal.
- Manager status contains the full URL. Other viewers receive origin and path.
- A capture-consent bypass flag cannot ship on the shared browser. If no safe
  video capture mechanism yields measurements, ship tuned JPEG and report the
  isolated H.264 prototype as evidence.

## Measurement method and results

Scripts and raw logs are in `/tmp/browser-3/`. The comparison uses a local page
at 1280x800 with 160 moving labelled rectangles and a 200x200 black/white click
marker. The receiver samples mean luma in the 100x100 marker region starting at page coordinates (30, 30).
Both timestamps use the receiver's `performance.now()`: before the panel sends
mousePressed, and immediately before drawing the first changed frame. Pixel
readback follows that timestamp. JPEG also records the matching WebSocket
message arrival, which separates send-to-receive from receive-to-draw cost.

The fixture uses the real BrowserPool and BrowserPanel over a local WebSocket.
It answers heartbeats and reconnects. The bundle uses production React, matching
`build:ui`. Baseline mode reads the pool, panel, and English catalog from
`c85e1f8281032e5309c42373ca4f3e13ccd7a1f0`; it does not modify the checkout.
The fixture has a separate Chrome instance and no office profile. Resource
samples use cgroup CPU/current/peak counters, with the receiver Chrome
reported separately. The server CPU figure subtracts the Node measurement
controller's `/proc` CPU ticks from the Bun-plus-target scope. The script records ordered click samples, not just totals. Bun and the target
Chrome share a 2 GiB scope; the viewer Chrome has a separate 2 GiB scope.
A Node helper drives only the measurement viewer because Bun 1.3.11 timed
out connecting Playwright to its CDP WebSocket. This helper is not shipped.
Each run records cgroup CPU, peak memory, and box load at both ends.
The viewer runs the click/settle loop and freezes its own frame and byte counters
at the end. This adds a small amount of viewer work. Chrome frame timestamps
are epoch seconds; the separate capture-age diagnostic compares them with
same-host `Date.now()`, not with the viewer clock. The log records wall and
monotonic clocks at both ends so clock steps can invalidate that diagnostic.

This is a loopback test. It does not establish latency over the member's network.
A TCP-only SSH tunnel carries the existing WebSocket, but does not carry a
WebRTC UDP path. WebRTC would need reachable candidates or a relay. Network
loss, TURN deployment, and real-device decode costs remain unmeasured.

Earlier exploratory runs used a weaker marker instrument and development React.
A later combined-scope run also hit memory pressure. Those runs are not the
final baseline and must not be used to claim a speedup. Controller polling also
timed out after the viewer had already recorded the requested marker sample
(`/tmp/browser-3/comparison-2-baseline.log`). The later `final-*` runs still
scanned process-tree memory after stopping the timing window while frames kept
arriving; their throughput/resource totals are not used. Only the `measured-*`
runs use the final counter windows and resource instrument.

Measured 2026-09-12 on commit `fe6ab018e2e7431681a5b099c208436c4f5a61df`, with four interleaved blocks of 25 samples per configuration (100 each). The baseline source hash is given above.

| Path | Decoded pixels | Latency median / p95 ms | Delivered / painted fps | Bytes/frame | Mbit/s | Server CPU % | Target / viewer peak MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1280x800 | 644.2 / 3150.0 | 16.68 / 12.95 | 96,245 | 17.14 | 113.4 | 640 / 686 |
| video | 1280x800 | 525.1 / 896.6 | 13.47 / 7.98 | 11,770 | 1.27 | 172.7 | 568 / 407 |
| tuned | 1229x768 | 279.3 / 980.3 | 10.78 / 10.65 | 64,213 | 7.39 | 123.1 | 543 / 487 |
| sized | 640x400 | 195.2 / 448.0 | 15.80 / 15.67 | 27,251 | 4.61 | 143.3 | 520 / 428 |

JPEG bytes/frame are compressed image bytes; JPEG bandwidth counts the viewer’s received JSON including base64. Video bytes/frame divide received RTP payload bytes by decoded frames; video bandwidth is RTP payload and excludes ICE/DTLS/UDP overhead. Video delivered fps uses receiver RTC stats; painted fps counts canvas paints. The prototype did not achieve the requested 30–60 fps.

CPU is percent of one core. Target peak includes the temporary Node controller, while its CPU ticks are subtracted. The target peak stayed below 640 MiB against a 2048 MiB limit. Viewer CPU was baseline 82.8%, video 93.0%, wide 80.2%, and sized 82.7%. These are separate headless viewer costs, not production server costs.

The box has eight available cores. Every run started and ended with one-minute load above eight. Absolute latency is a loaded-box measurement, not an idle-host or WAN prediction; the interleaved relative comparison supports this fixture’s decision. The headless viewer also shares this loaded box and can be slower than the member’s laptop. Start/end one-minute loads by block follow; raw logs retain all three load averages and cgroup CPU counters.

| Path | Block 1 | Block 2 | Block 3 | Block 4 |
| --- | --- | --- | --- | --- |
| baseline | 10.17 → 13.76 | 13.49 → 16.95 | 15.41 → 15.58 | 14.33 → 14.22 |
| video | 12.77 → 11.72 | 14.52 → 12.76 | 16.21 → 16.21 | 13.55 → 12.25 |
| tuned | 13.67 → 13.55 | 12.36 → 13.79 | 15.95 → 15.98 | 11.74 → 11.93 |
| sized | 13.46 → 12.91 | 13.25 → 14.92 | 15.65 → 14.80 | 13.96 → 14.14 |

Sample-index regression slopes (ms/sample), in block order:
- baseline: -10.2, -197.5, -94.7, -11.5.
- video: -9.0, -2.4, 11.8, 2.4.
- tuned: 3.2, -6.5, 7.1, -13.1.
- sized: -1.9, 2.7, 3.2, 4.1.

The baseline does not show a steadily growing viewer backlog: its largest stalls occur early and then recover. The bundle cannot attribute its improvement to decode dropping alone. The sized row paints 15.67 fps versus 10.65 wide; higher throughput is consistent with its higher aggregate CPU (143.3% versus 123.1%). This is an interpretation, not an isolated encode-cost experiment.

Input receipt to CDP dispatch resolution median/p95 was baseline 49.3/237.7 ms, video 19.3/97.1, wide 24.8/155.3, sized 35.1/189.0. Server event-loop p95 ranged 62.8–97.5 ms baseline, 28.2–71.3 video, 51.9–77.7 wide, and 26.6–67.6 sized. These show scheduling stalls but do not explain the full click delay. Marker-frame capture-swap to server receipt medians were 69.8, 44.6, and 17.5 ms for baseline/wide/sized; server receipt to fan-out medians were 0.46/0.48/0.44 ms. The remaining latency is unattributed. Medians of different sample populations must not be subtracted as an exact partition. Wall-versus-monotonic delta error stayed below 0.7 ms in all runs.

Ship tuned JPEG under the PM fallback ruling. The isolated video path is slower and uses more server CPU than tuned-650, although its 1.27 Mbit/s is lower than JPEG’s 4.61 Mbit/s. A remote connection must sustain at least that measured JPEG traffic with burst headroom; no actual member uplink was tested. Video p95/median is 1.71 versus sized 2.30, wide 3.51, and baseline 4.89. Those ratios describe this loopback fixture, not proof of performance under loss or jitter. A WAN comparison remains unmeasured. Video also needs a consent-safe capture mechanism before it can ship.

The tuned configuration has five changes: JPEG quality 50, every second frame,
watcher-sized capture, one active decode plus one replaceable pending frame,
and pointer-move coalescing. At a 1300 CSS-pixel panel the navigation bar limits capture to 1229x768, about 8% fewer pixels than baseline. The 650-pixel panel produces 640x400 and exercises the substantial sizing reduction.
A one-shot snapshot now seeds a static page if screencast supplies no initial frame. It uses a viewport clip scaled to the same bounds and quality, and a newer live frame supersedes the seed. One cached frame serves later viewers of a quiet page through the same access-checked callback. This startup repair followed the comparison measurements. The click-only fixture does not exercise pointer-move coalescing. The results
measure a bundle; they do not assign a causal speedup to each change.

Transport update, 2026-09-12: the bandwidth follow-up adds opt-in binary JPEG
messages and shared capture adaptation. Legacy watches keep JSON. The dated
round-3 measurements above still describe the JSON path. See
[browser-panel-bandwidth.md](browser-panel-bandwidth.md) for the framing,
pressure controller, fresh comparison and its limits.

The round-3 baseline buffer was intermittent: block 1 had zero buffered bytes,
while block 2 had 350 nonzero fan-outs out of 787 and peaked at 3,962,596 bytes.
Tuned-wide and sized blocks had zero. The sender retains one latest pending
frame per socket/watch when its Bun buffer exceeds one frame; drain delivers
that final frame even if capture stops changing. Delivery rechecks room access.
This limits additional browser-frame queue growth without slowing other viewers.
It does not bound other office messages or kernel buffers. ACK throttling was
not added because it can stall capture.


### Congestion guard and follow-up

The 2026-09-12 on/off diagnostic used two alternating blocks of 50 clicks each at the 650 CSS-pixel panel size (100 samples per mode). With the guard off, median/p95 was 180.0/582.2 ms; with it on, 187.5/486.6 ms. Every sampled Bun buffer was zero in both modes. Thus the p95 difference is not evidence that the guard improved latency. Those runs used the new helper before its commit, with the old HEAD recorded; they are development diagnostics, not final-commit reproduction. Raw logs are `/tmp/browser-3/protection-{1,2}-{off,on}.log`.

The guard retains one latest frame per watch while the socket is congested. It
sends that frame on drain after checking current access. The bandwidth follow-up
now lowers JPEG quality, then capture size under sustained buffer pressure, and
recovers after the buffer clears. Capture remains shared: a fast watcher keeps
its demand while a slow watcher drops delivered frame rate. The follow-up note
records the thresholds, image cost and an actual paused-reader measurement.

Video's historical round-3 1.27 Mbit/s is about 3.6 times lower than tuned-650's
4.61 Mbit/s. That remains a reason to revisit video if consent-safe capture
becomes available or a remote member reports lag the loopback fixture cannot
reproduce. Binary's earlier 25% saving was an estimate, not a round-3 result;
the follow-up reports a fresh measurement separately.

## Video mechanisms

**Helper tab and WebRTC.** A separate test-only Chrome captured the local fixture
with `getDisplayMedia`, `--auto-select-tab-capture-source-by-title`, and
`--enable-usermedia-screen-capturing`. It negotiated H.264; sender statistics
reported OpenH264. Chrome 151.0.7922.137 reported software video encoding, an
empty hardware encoder list, and SwiftShader on 2026-09-12. Raw evidence:
`/tmp/browser-3/capabilities.log` and `/tmp/browser-3/video-smoke.log`.
This prototype adds no npm package, native module, or system binary, but its
capture flags bypass consent. It is not a safe production capture mechanism.
The [Chromium switch definitions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/chrome_switches.h)
describe automatic selection. A title also does not provide an isolated,
stable identifier for one agent's page.

**Extension capture in server Chrome.** The
[tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
requires an extension invocation to start capture. A stream id can feed an
offscreen document on supported Chrome versions. This would add an extension
and a capture lifecycle. A safe unattended grant for an arbitrary server tab
has not been verified. No extension was built.

**CDP frames encoded in a helper.** A helper could decode CDP JPEGs into a canvas,
use `captureStream`, and send that track through WebRTC. This avoids granting
untrusted pages capture permission, but retains JPEG encode/decode work before
video encoding. Performance and safe session revocation have not been measured.
It adds helper-page code and signalling, with no required external encoder.
This is an unverified candidate, not the measured prototype.

**External encoder.** CDP frames could instead feed ffmpeg or a native WebRTC
module and a server relay. That adds a system binary or native module. Neither
is added by this lane; the PM must approve such a dependency before it ships.
Performance is unverified.

**Native CDP/Playwright video.** Installed Chrome rejected
`Page.startScreenRecording` as unknown. The experimental
[CDP Page API](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
now lists a stream handle, but that does not make it available on Chrome 151.
Playwright's [video API](https://playwright.dev/docs/videos) describes recordings
saved to files. No supported live WebRTC track was found in that API.

## Extension option A: a tab in the member's desktop Chrome

This is a report-only option. It would be a separate, explicit desktop mode;
the server browser remains the agents' default browser.

A first version would pair one desktop extension with one office member and
let the member choose a tab. The extension would receive actions over an
outbound authenticated connection and use
[`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
to target that tab. Chrome exposes DOM, Runtime, Input, and other CDP domains
through that API, with the debugger permission. The member would see the actual
tab. Remote viewing would be a separate tabCapture feature.

The server would need pairing and revocation, device presence, bounded action
requests with replies, and an explicit target selector. Those are design
estimates, not implemented interfaces. The member's desktop and Chrome must
remain online. This first version supports one chosen desktop, not phone Chrome.
It needs an extension store release or developer-mode sideload. Chrome's
[distribution guidance](https://developer.chrome.com/docs/extensions/how-to/distribute)
describes distribution options; enterprise policy can also constrain installs.

Anthropic provides prior art:
[Claude Code with Chrome](https://code.claude.com/docs/en/chrome) uses the Claude
in Chrome extension and a local native-messaging bridge, works with browser
logins, and lists desktop prerequisites. Its
[extension guide](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
describes tab interaction and permissions. These are product integrations;
no supported general-purpose bridge for Isomux was verified.

[Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
would require an installed local executable and host manifest. An extension
connecting directly to the office could avoid that executable, at the cost of
its own authenticated protocol (proposed design). Playwright
[`connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
connects to Chromium with lower fidelity than its native protocol. It is not a
transparent extension transport. Chrome's
[remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port)
requires a non-default user-data directory for remote debugging from Chrome 136,
so attaching a port to the normal logged-in desktop profile is not a simple
substitute.

A local 2026-09-12 probe found that Bun 1.3.11 acting as a Playwright CDP client
timed out while Node connected to the same Chrome endpoint. Raw reproduction is `/tmp/browser-3/cdp-client-probe.log`. The cause is not
established. This constrains the direct desktop-CDP alternative. The proposed
extension calling `chrome.debugger` and opening its own office connection does
not call `connectOverCDP`; the client finding does not establish that it needs
a Node sidecar. The temporary measurement bridge is not production code.

Security consequence: a paired office can act with that tab's existing login.
The extension and the office connection become access paths to the desktop
session. The member needs an explicit tab choice and a visible disconnect.
A first implementation is estimated at 1–2 engineer-weeks plus store review;
this is an unverified planning estimate, excluding mobile, multi-device routing,
and a full Playwright protocol adapter.

## Extension option B: copy selected logins to the office profile

A smaller first version would let a member pick a site and upload its cookies
to their office profile. The server would need a manager-authenticated import,
validation, merging under the existing profile write queue, and defined behavior
for contexts already open. No import route or extension was built.

The [cookies API](https://developer.chrome.com/docs/extensions/reference/api/cookies)
requires cookies permission plus access to the relevant hosts. It exposes cookie
values and attributes, including HttpOnly, SameSite, expiry, and partition keys.
HttpOnly blocks page JavaScript; it does not prevent the extension cookies API
from reading the cookie. SameSite governs cross-site requests and must survive
import; it is not a device binding. A copier must preserve secure, host-only,
path, and partition semantics rather than flattening cookies by name.

Cookies alone do not cover every login. Chrome's
[storage guidance](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
says content scripts access the host page's web storage. Local storage could be
collected for the chosen origin. IndexedDB, sessionStorage, and site-specific
state need more work and a clear import contract; universal transfer is
unverified. Device-bound keys cannot be copied this way. Chrome's
[DBSC description](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials)
requires proof of a device private key to refresh protected cookies. A copied
cookie cannot provide that key. Sites may also challenge a changed IP or device;
which sites do so is unverified and must be tested per site.

The desktop must be online during export, and later refreshes may be necessary
when a site invalidates a session. The office browser can work after the desktop
goes offline if the imported login remains valid. Distribution still needs a
store release or sideload. No local executable is required for this proposed
cookie-only version.

Security consequence: exporting duplicates bearer session credentials onto the
office box and gives the member's agents their use. Disconnecting the extension
does not revoke a cookie already copied; revocation must also clear the office
profile or end the site's session. The narrower cookie-only first version is
estimated at 3–5 engineer-days plus store review. That is an unverified planning
estimate; general storage transfer and per-site compatibility are excluded.
