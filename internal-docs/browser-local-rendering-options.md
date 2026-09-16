# Browser rendering options for a web client

Research date: 2026-09-15. Sources were checked during the September 14–15 discussion with Nil. External links to `main` describe moving code, not pinned dependencies. Issue reports below were read but not independently reproduced. No prototype or comparative performance test was run.

## Goal and constraints

The agent runs on the office server and acts on a browser. A member sees and uses that browser inside the Isomux web client, beside the agent chat. Scrolling, typing, and text selection should feel local. Multiple viewers and multiple possible drivers are desirable.

Nil does not plan a desktop app and considers a required browser extension unacceptable. Leaving Isomux to use another tab defeats the desired workflow. Multiple viewers are desirable for remote browsers; local-browser prototypes may serve one client only.

## Current plan and task ownership

Updated 2026-09-16 after comparison task c7ad3542: Nil chose a server-side browser with a good stream as the main road for general browsing. The earlier last-resort ordering below is historical and no longer governs this work.

Task 5add7b5d, “Browser stream for general browsing,” owns the [stream design](browser-stream-design.md) and measurements. This is a design round; implementation needs Nil's separate go. The existing JPEG path stays available until a replacement beats it by a visible margin. A second viewer, handoff between humans, DOM mirroring, rewriting proxies, extensions, and desktop clients are outside this round.

Task 03b5be5e, “Open hosted apps live beside agent chat,” still owns hosted-app preview independently. The [office task board](https://office.nilmamano.com/tasks) owns assignment and progress.

The c7ad3542 findings below were measured on 2026-09-16. The findings documents and their evidence live only on their named branches; they were not merged. Retain these branches deliberately: this document in main depends on them.

**Iframe:** one of the five entry pages embeds (Wikipedia), and its login destination refuses. The other four sites refuse embedding. Source: branch `browser-iframe`, commit `2b1781a2`, path `internal-docs/browser-proto-iframe.md`.

**Scramjet:** all five entry pages render, but only Wikipedia completes its workflow. Site challenges stop search and video, and rewriting breaks navigation, including the demo office. Source: branch `browser-scramjet`, commit `ba73e668`, path `internal-docs/browser-proto-scramjet.md`.

**rrweb:** incoming server updates corrupt local typing in the unreconciled prototype, even without the memory cap; the Wikipedia trial changes all three entered strings. This result does not rule out a future adapter with input reconciliation. Source: branch `browser-rrweb`, commit `bbad7e25`, path `internal-docs/browser-proto-rrweb.md`.

### Browser comparison

Try rrweb and Scramjet first. Build runnable, usable prototypes in this order of priority:

1. Server Chromium with rrweb DOM mirroring, and client-side Scramjet browsing.
2. Client-side iframe browsing with controlled embedding/header support where feasible.
3. Server Chromium with an improved pixel/video stream, only as a last resort if the other approaches do not meet the product needs.

The separate hosted-app preview can proceed independently of this order.

Use representative real workflows inside an Isomux-style panel beside chat, with agent inspection/control where applicable. A static demo or basic page load is insufficient. Deliver the prototypes and a source-backed comparison of successes, failures, limitations, and work needed for production so Nil can choose what to integrate. Follow the [validation requirements](#validation-requirements).

For remote prototypes, support shared viewing and server-enforced command authorization, including human/agent contention and driver handoff. For local prototypes, accept one-client-only operation; shared viewing/control, mirroring to other clients, and host-client failover are outside scope.

Nil judged the current JPEG stream inadequate on 2026-09-16 and cancelled further investment in that panel under task 3a2766a4, “Browser panel: text on the page cannot be selected by the manager”. The improved pixel/video stream is a last resort, not part of the first prototype round. If needed, it must beat the current experience by a visible margin. Matching today's stream is a negative result.

Keep the current stream available while testing alternatives. Do not rebuild a general website-rewriting proxy in-house. The main unresolved rrweb question is whether local scrolling, selection, and typing can coexist with incoming server updates without visible resets or incorrect actions.

### Hosted-app preview

Add an “Open beside chat” action for Isomux-hosted apps. Show the live app in an iframe with refresh and open-full-page controls. The app runs on the member's device for native scrolling, typing, and text selection. Verify authentication, embedding, and isolation from the office.

This task covers apps we control. Agent inspection/control of the exact client page is a possible follow-up. Decide and validate the mobile flow explicitly: the desktop side-panel layout does not establish a useful phone experience. The hosted-app task can proceed independently of the browser comparison.

## Current Isomux browser

In [server/browser-session.ts](../server/browser-session.ts), Isomux launches Chromium through Playwright with `headless: true`. The visible panel receives CDP screencast JPEGs. Human mouse and keyboard input goes back through CDP. [BrowserPanel.tsx](../ui/log-view/BrowserPanel.tsx) decodes and paints the received images.

A locally hosted office uses the same design. If the member opens the office on the computer that runs it, the traffic stays local. If the member opens it on a phone, Chromium still runs on the office computer.

Low resolution is a capture/bandwidth tradeoff, not an inherent limit of remote browsing. A video codec could reduce repeated image data, but does not remove the input round trip or turn displayed pixels into locally selectable text. We have not benchmarked a video replacement.

Earlier measurements and implementation details remain in [binary JPEG and pressure control](browser-panel-bandwidth.md), [scroll and viewport work](browser-panel-scroll-and-fill.md), and [browser-use exploration](browser-use-exploration.md). Do not treat historical fixture measurements as results for the proposals here.

## Comparison

| Approach | Where the website executes | What the client displays | Main limitation |
| --- | --- | --- | --- |
| Current pixel stream | Server Chromium | Images | Remote input and no native text surface |
| rrweb mirror | Server Chromium | A reconstructed DOM | Synchronization and incomplete visual/interaction fidelity |
| Direct iframe | Client browser | The actual website | Embedding and cross-origin rules for arbitrary sites |
| Scramjet | Client browser | The rewritten website | Website compatibility and licensing |
| Extension-controlled tab | Client browser | A normal browser tab | Installation requirement and separate browsing surface |
| Electron guest browser | Desktop client | Native Chromium content | Requires a desktop application |

## Direct iframes for our apps

An iframe runs and renders the app locally. The app can allow embedding by the office. Authentication redirects, frame policies, cookies, WebSockets, and mobile layout still need verification against the actual app-host routing.

The app should retain its separate origin. Isomux's [app proxy](../server/app-proxy.ts) already relays traffic behind app hostnames; this does not by itself prove that all authentication flows work in an iframe.

Displaying an app does not require a command bridge. If the agent must inspect or control the exact page the member sees, we can add cooperative app instrumentation and an authenticated bridge, with strict message-origin checks. The parent cannot directly inspect a cross-origin iframe just because both servers belong to us.

rrweb does not make direct iframes unnecessary. Mirroring our apps would add server Chromium, remote state changes, and replay work where direct execution is available. Both surfaces could use the same Isomux panel controls.

For arbitrary websites, removing `X-Frame-Options` or changing CSP alone is insufficient. Cross-origin access and embedded login/cookie behavior remain. A normal web page cannot modify the response headers of another website; doing so needs a proxy or extension. Relaying a site under a different origin also changes URL, storage, and script assumptions, which leads toward a rewriting proxy.

Sources: [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy), [iframe behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

## rrweb DOM mirroring

The server browser runs the original site and its JavaScript. A recorder sends an initial DOM snapshot and later mutations, input state, and scroll changes. The client reconstructs the page without executing the original application's JavaScript. Styles and assets must also be available to the client.

[rrweb live mode](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/live-mode.md) accepts events as they arrive. The library does not supply Isomux's transport, authorization, remote command interface, or conflict resolution. Its [interaction API](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/interaction.md) permits interaction with the replay; that alone does not send actions to the original page.

### Scrolling and selection

We could scroll the local copy immediately and send the scroll position to the server asynchronously. Ordinary loaded content could then scroll without waiting for a network round trip. Local text selection is also possible in principle.

This is a design proposal, not a measured property of an unmodified rrweb player. Incoming scroll events and DOM mutations must not overwrite local interaction. Virtualized lists may contain only the visible rows, while infinite feeds and lazy content require the server to generate more DOM. Those areas can still expose network delay. Clicks and application state changes still depend on server execution.

Typing needs explicit reconciliation for focus, caret position, composition/IME, selection, and edits that the server application rejects or reformats. DOM node identity must remain correct across navigation and replacement. Resizes and different client fonts or viewport dimensions can make coordinate-based control inaccurate.

Canvas, WebGL, video, cross-origin frames, protected assets, and browser-native UI need separate evaluation. rrweb provides canvas-related facilities, including a WebRTC plugin, but these are not equivalent to complete DOM capture. Cross-origin iframe recording requires recorder injection into each frame. See the [rrweb guide](https://rrweb.com/docs/guide) and [canvas recipe](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/canvas.md).

Replay content must remain isolated from the office. We must check what the recorder exposes, including hidden DOM or form data that a screenshot would not show. Enabling active replay features must not cause the original site's scripts to execute with office privileges.

### Shared viewing and control

One server page can produce a stream for several authorized viewers. Isomux would send updates to clients that subscribe to that page, not every connected client. A new viewer needs a consistent snapshot and the subsequent ordered updates. Additional viewers require client replay work and network traffic, not another server page.

Isomux must authorize viewing separately from driving, and validate every command on the server. Disabled buttons in a viewer are not an authorization boundary. Navigation generations and access changes must invalidate stale actions and subscriptions.

Recommendation, not an approved access-policy change: permit one active driver at a time, with an explicit takeover mechanism. Human and agent commands need coordination. Viewers could either follow the driver's viewport or explore a local copy independently; independent exploration cannot always load server-dependent content without affecting the shared page.

### Other existing software

[OpenReplay Assist](https://github.com/openreplay/openreplay/wiki/How-Co%E2%80%90browsing-works-in-Session-Replay) implements co-browsing and remote input for instrumented sites. It is a broader product than rrweb, and adapting it to arbitrary pages in server Chromium needs evaluation. Its licensing is mixed; see below. Session-replay libraries are useful components, not complete general remote browsers.

## Scramjet rewriting proxy

With Scramjet, the member's browser executes the rewritten site's JavaScript and renders it in the panel. The server relays network traffic; it does not need to run Chromium for that page. Scramjet rewrites HTML, CSS, JavaScript, URLs, and browser interactions so the site can operate through the proxy. See [the repository](https://github.com/MercuryWorkshop/scramjet) and [rewriter documentation](https://mercuryworkshop-scramjet.mintlify.app/advanced/rewriters).

This allows local application interaction, but makes compatibility depend on rewriting. It is materially different from displaying a copy of a server-run app.

### Evidence from users and maintainers

On 2026-09-14, the GitHub API reported 1,028 forks and 540 stars. Downstream projects such as [DoxyEdu](https://github.com/Arandomdude222/DoxyEdu-web-proxy) describe customized proxy deployments. This establishes use, not the number of active deployments or why all forks exist.

The following status was observed during this research:

| Report | What the source supports |
| --- | --- |
| [Reddit login, issue 203](https://github.com/MercuryWorkshop/scramjet/issues/203) | An August user report says login fails on a private instance and the demo. Open without a maintainer reply when checked. |
| [CAPTCHA discussion, issue 70](https://github.com/MercuryWorkshop/scramjet/issues/70) | The original reporter resolved general failures by changing hosting. A maintainer separately says Cloudflare challenges detect proxies and are unsupported by the normal mechanism. Do not merge these into one diagnosis. |
| [Safari, issue 192](https://github.com/MercuryWorkshop/scramjet/issues/192) | A contributor reports response-stream transfer failures that prevent loading. [PR 193](https://github.com/MercuryWorkshop/scramjet/pull/193) proposes a fallback; it was still open. |
| [BroadcastChannel isolation, issue 200](https://github.com/MercuryWorkshop/scramjet/issues/200) | An open report describes communication across proxied site boundaries. Not independently verified. |
| [Navigation 404s, issue 205](https://github.com/MercuryWorkshop/scramjet/issues/205) | A maintainer attributes the failure to configuration and asks about a link-handling plugin. The reporter says the demo is affected. Diagnosis remained unsettled. |

We found no credible comparative benchmark establishing a gain over Isomux's stream. “Experimental” is the project's description; the concrete reports above are more useful for a decision.

### Dependencies and maintenance

If adopted, use pinned, tested versions and a small adapter. The checked architecture separates core, controller, utilities, and transport packages and includes a Rust/WASM rewriter. Pinning prevents unexpected dependency changes but cannot prevent a target website from changing. A fork gives us patch control and also creates an obligation to maintain our changes. Rebuilding the proxy in-house recreates the compatibility problem.

The [release list](https://github.com/MercuryWorkshop/scramjet/releases) included `2.0.67-alpha.2` and a continuous build. Package and source versions must be recorded for any future test; a report against one release does not prove another release has the same behavior.

### Multiple clients

Each Scramjet client normally runs a separate app instance. Opening the same URL, or even sharing login state, does not synchronize DOM, focus, navigation, and application memory.

Shared Scramjet browsing is outside the current prototype scope. A future design to share one instance would select one client as the host, mirror that client's page to other viewers, and forward authorized commands to it. That adds a co-browsing system on top of Scramjet and requires the host client to stay connected. Isomux would validate commands on the server and bind them to the selected host and session. This is more work than distributing a single server browser's rrweb stream.

## Extensions, native clients, and Orca

An “invisible connection” extension means no separate assistant chat: the member keeps using Isomux, while an installed extension reads an authorized tab, executes commands, and returns observations. The connection would still need permissions, visible status, and a disconnect action. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) provide page access.

The extension does not move a native browser tab inside Isomux. An extension could assist iframe embedding, but login and frame behavior remain compatibility concerns. A [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) could put Isomux chat beside a normal tab; that changes the intended layout and still requires installation. Neither meets Nil's current constraints.

Headless Chrome is an operating-system process. Browser-side Puppeteer can [connect to an existing browser but cannot launch one](https://pptr.dev/guides/running-puppeteer-in-the-browser). Running Chrome locally would require a local helper. We found no ready-to-use modern Chrome-in-WebAssembly package. Emulation is a research direction, not a verified practical option here.

Orca's code was inspected directly:

- Its [desktop panel](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts) creates an Electron `webview` with a browser-session partition.
- Its [browser documentation](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/browser/overview.mdx) describes local execution with network traffic routed through a remote workspace. Human input remains native while agents control the same browser.
- Its [web-client API](https://github.com/stablyai/orca/blob/main/src/renderer/src/web/preload-api/web-browser-api.ts) disables local page hosting.
- Its [stream format](https://github.com/stablyai/orca/blob/main/src/shared/browser-screencast-protocol.ts) supports JPEG and PNG; its [CDP handler](https://github.com/stablyai/orca/blob/main/src/main/browser/browser-screencast-cdp-events.ts) receives screencast images.

Orca therefore validates the native-client architecture, not a general embedding technique available to the Isomux web client.

## Licensing

Checked 2026-09-15. These are source findings, not a determination of legal compatibility with a future integration.

| Component | Finding |
| --- | --- |
| rrweb | [MIT](https://github.com/rrweb-io/rrweb/blob/main/LICENSE). Permissive; retain required notices. |
| Scramjet current core/controller | Manifests declare [AGPL-3.0-only](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/package.json). An older npm page reported MIT; do not apply that statement to current code. |
| OpenReplay tracker and Assist client | Component [MIT license](https://github.com/openreplay/openreplay/blob/main/tracker/tracker-assist/LICENSE). |
| OpenReplay platform | [Root license](https://github.com/openreplay/openreplay/blob/main/LICENSE) defaults to AGPL with exceptions. The [Assist server manifest](https://github.com/openreplay/openreplay/blob/main/assist/package.json) declares Elastic License 2.0; [enterprise code](https://github.com/openreplay/openreplay/blob/main/ee/LICENSE.md) has separate terms. The full product cannot be described as uniformly permissive or uniformly OSS. Resolve component declarations before reuse. |

Copyleft licenses permit modification and redistribution but attach source-sharing obligations to covered uses. AGPL also addresses users interacting with modified software over a network. The scope for a combined application depends on the actual integration; it is not accurate to say that merely contacting an AGPL service automatically relicenses all callers. MIT does not require publishing application modifications. Copying or forking code does not remove its license obligations.

## Memory and performance on an 8 GB office

An 8 GB host is a plausible experimental target, not a verified capacity claim. rrweb would retain server Chromium and add recorder and event-buffer overhead. Each viewer reconstructs the DOM on its own device. Removing JPEG capture may save work, while DOM serialization adds work; the net result is unmeasured.

A live implementation should keep bounded state: a usable snapshot and subsequent updates, with periodic replacement or resynchronization. It should not retain an unlimited session recording on either server or client. Slow viewers need bounded queues and resynchronization rather than unchecked accumulation.

Measure the complete office workload, including Chromium processes, recorder overhead, snapshots, transport buffers, and existing agents/apps. Also measure replay memory and responsiveness on a phone. More viewers multiply transport and client work; more independent browser pages multiply server page work.

## Validation requirements

Apply these checks to the browser comparison before any implementation commitment:

1. Compare the prototypes in the priority order above on representative pages with the same viewport and network conditions. Start with rrweb and Scramjet; test an improved pixel/video stream only if the other approaches do not meet the product needs. Use the current pixel stream as the baseline.
2. Test navigation, login, forms, typing/IME, caret movement, text selection, scrolling, virtualized lists, lazy content, and server validation. Test agent inspection/control where applicable.
3. Test protected assets, popups, nested frames, canvas/video, resize, reconnect, and clear failure behavior. Record where a remote prototype requires pixel fallback.
4. For remote prototypes, join a second viewer mid-session. Test driver handoff, human/agent contention, stale commands, revoked access, and a slow viewer. Local prototypes remain single-client.
5. Test desktop and mobile. Measure interaction delay, bandwidth, CPU, and peak/steady memory under a complete 8 GB office workload. Measure replay memory and responsiveness on a phone. Run long sessions to detect growing history or queues.
6. Assess integration effort, dependencies, isolation, and licensing. Report failures and limitations alongside successes, with sources and dated measurements. Do not select an approach based only on a static-page demo.

For the hosted-app task, validate its [preview requirements](#hosted-app-preview), including local input, refresh, open-full-page, and the chosen mobile flow. Reuse those results in the comparison.
