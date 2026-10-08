# Chrome extension bridge

## Scope and status

Desktop Chrome is the interactive browser. Server screenshot previews remain separate and accept public HTTP(S) sites and office-host pages.

## Member flow and state

The normal route table declares these self-scoped routes. All five require
`cap("user:self", authenticated)`, as personal preferences do. An agent token
cannot use them. Other identities need that actual capability; owning another
member's office does not select that member's browser.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/me/browser` | Read paired/online state, each paired browser, member label and package version |
| GET | `/api/me/browser/extension.zip` | Download the built extension with attachment/no-store headers |
| POST | `/api/me/browser/pair` | Create a pairing code for one more browser; optional `name` |
| DELETE | `/api/me/browser` | Revoke every browser and end control |
| DELETE | `/api/me/browser/browsers/:id` | Revoke one browser and end its control |

The server creates a 32-byte random base64url code, valid for five minutes and
one redemption. A new code replaces the member's pending code. Code hashes live
only in memory. The authenticated response contains the code and expiry.
Creating a code leaves live browsers alone. Redemption validates
protocol version, code, current member existence and exact extension Origin,
consumes the code, atomically adds a browser with the new credential hash and
Origin, then sends the new credential. Other browsers stay connected. A failed send does not restore
the code. The member pairs again after a lost paired response.

`browser-connections.json` holds a version-2 list of browsers per member (see "Several paired browsers"). Version-1 envelopes and legacy flat maps also load. Old headless choices become extension records; valid paired credentials remain usable. Missing or invalid state requires fresh pairing. Redemption preserves unreadable/corrupt source data under a unique `.unavailable-` filename before an atomic replacement, and restores it if the write fails. No raw credentials are saved server-side.

The removed PATCH `/api/me/browser` returns JSON 404 through the existing retired-route wall. Status no longer reports a backend or selectionRequired. Legacy experimental panel settings are ignored on load and update. The old panel WebSocket commands are ignored; no frames or input callbacks exist. Saved server profile files remain untouched and are never loaded or imported. Pairing never grants a tab automatically.

## Socket and recovery

The extension opens `/browser-extension/ws` on the office host. App host diversion
runs first. The socket has its own dispatch discriminator and cannot enter the
office event stream. The upgrade requires the canonical office Host and exact
`chrome-extension://[a-p]{32}` Origin. Remote configuration requires WSS and an
HTTPS office origin. Loopback HTTP/WS is accepted for isolated local fixtures.
URL credentials, query strings and fragments are refused.

The first frame, within five seconds and at most 4 KiB, is
`{kind: "hello", version: 4, code}` or the same shape with `credential`.
Pairing returns `{kind: "paired", version: 4, credential}` before
`{kind: "ready", version: 4, generation}`. Authentication binds the credential
hash to the saved extension Origin. Each credential has at most one live
connection; a duplicate is refused.

Later messages are limited to 8 MiB before JSON parsing. Each command has a
30-second deadline. The server sends a ping every 15 seconds and closes control
when a pong is absent for 45 seconds. The extension has a matching watchdog.
Transient loss reconnects with 1/2/4/8/16/30-second backoff plus small jitter.
A Chrome alarm wakes a suspended extension worker to retry; startup also reads
its saved connection. Chrome may delay alarms; this is recovery, not a timing
guarantee. See the [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms).
Authentication or revocation refusal persists a blocked configuration until the
member pairs again. Deliberate disconnect is a separate persisted disabled flag;
Reconnect cannot clear blocked or unknown-revocation state. No command queue survives disconnection or either restart.
A new connection gets a fresh generation, Playwright object and task assignment.
Every tab offer is released. Members must offer a tab again; previously opened pages remain open.

## Public Playwright seam and ownership

Pinned Playwright 1.62.1 runs inside the Bun office process. The public
`chromium.connectOverCDP(transport, { noDefaults: true })` overload connects
directly to an authorized assignment through `browser-extension-transport.ts`.
There is no agent CDP HTTP/WS endpoint, private Playwright patch or Node child.
The public seam avoids the bundled WebSocket client's rejection of Bun's HTTP
101 upgrade observed on 2026-09-19. The real extension uses outbound WebSocket.

Each action reads the current manager id from the agent record. Assignments,
commands, results and events require that exact member, current member existence,
and access to the agent's current room. Mutation hooks actively revalidate;
heartbeat is a backstop. The latest chat speaker never supplies browser identity.

Each individual agent has at most one exclusive offer; All offers share access among currently eligible agents of the paired owner. Root discovery exposes only that assignment's
main tab and related popups. Profile-level cookie, storage, context and arbitrary
root CDP commands fail. Synthetic browser sessions retain the same restricted
view. `noDefaults` preserves the desktop profile's settings. Page commands use
an explicit allowlist; iframe child sessions must come from an owned debugger
attachment. Same-origin frames use their page session; cross-origin frames use
flattened child sessions.

Popup ownership comes only from
`webNavigation.onCreatedNavigationTarget.sourceTabId -> tabId`. The extension
rejects unrelated source tabs before retaining or transmitting event data. Only
the current leaf of an owned chain can acquire the next popup. The extension
stores explicit parent links and rechecks ownership after each async attach step.
On 2026-09-19, the local Chrome fixture showed `tabs.onCreated.openerTabId`
pointing to the active setup tab even though CDP identified the assigned main
page as the true opener. Parent-scoped CDP page auto-attach emitted no target.
PM approved `webNavigation` for the exact source/target event. Chrome documents
its permission warning as `Read your browsing history`. The extension does not
request `history`, collect history, or correlate tabs by focus, time or URL.
See [the event API](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
and [Chrome permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list).
 Siblings and
foreign openers cannot acquire control. The chain has a sanity ceiling of eight
popups. Each popup has a separate debugger attachment and synthetic CDP session;
the server checks its opener again before exposing it to Playwright. Actions use
the leaf popup, then return to its retained opener when it closes. Main pages stay
open for OAuth return. Ending one assignment detaches its whole chain without
closing any page or releasing an unrelated grant.

## Action contract and errors

`POST /api/agents/:id/browser` keeps its existing actions and screenshot-card
shape. `preview-url` is unchanged. The extension uses the actual desktop viewport;
it does not apply the headless viewport or download policy. Desktop localhost
means the member's computer. Upload uses the byte-payload workflow below.
`close` means detach and leave the page open. Extension control
uses the fixed per-offer expiry selected in the popup, defaulting to Never.
Expiry detaches control and leaves the real page open; actions do not extend it.

Stable extension errors are `browser_not_paired`, `browser_offline`,
`browser_control_ended`, `action_timeout`, and `action_failed`. Control loss, an action timeout or revocation
can leave a side effect with an unknown outcome. The server never retries it.
Invalid requests return `invalid_request`; missing offers return `browser_control_ended`.

## Evidence and checks

Slice 1 proved real Chrome attachment and form/text/snapshot/click/screenshot
through the public seam, assigned-only discovery, no replay after connection
loss, and detach leaving pages open. The slice-2 opt-in real-extension test uses
the actual office routes and isolated member/profile state, two task agents,
frames, popup return, screenshot action, revocation, and a short injected action
deadline. The fixture asserts the unchanged 30-second production default. Unit and route tests
cover code expiry/reuse/hash persistence, restart, Origin and app-host exclusion,
credential separation, active access loss, popup ownership and stale generations.
Gate logs identify the committed hash and results; no Windows or real-site
acceptance is inferred from Linux fixtures. No account mutation is a test step.

Build: `bun run build:extension`; output: `browser-extension/dist/` and
`browser-extension/dist.zip` (ignored). `scripts/build.sh` invokes the builder,
so normal install/update builds produce the package. The builder removes its
staging directory, bundles the background and popup scripts, copies a fixed
allowlist, writes a deterministic stored-entry ZIP and atomically replaces the
archive. No customer-side archive tool or new dependency is needed. The route
fails closed when the archive is missing. It uses existing self authentication,
app-host diversion and the ordinary safe-GET/no-CORS boundary.

`connection.html` is both the options page and actual toolbar action popup.
Only that exact extension URL and runtime id can call the background UI API.
The UI API never returns raw credentials/codes. It accepts an HTTPS office
origin (loopback HTTP for isolated fixtures), derives the socket path and rejects
credentials, paths, query and fragment. State polls only while the popup or
settings pane is open. The Agent control switch applies to the current tab and selected scope;
Off names its current assignment and generation. Off cancels local ownership, detaches and sends the existing
`detached` event; the server revalidates ownership before release. No audio or
media command is sent. The badge shows ON only on owned tabs. Other tabs have no badge; connection state appears in the popup.

Generation-bound `metadata` frames contain the current member id/name and
eligible and assigned agent ids/names, never page URLs/titles. Server display sanitization is
centralized in `browser-extension-display.ts`. Record mutation/heartbeat refreshes
metadata; assignment/connection end clears the extension display. Names render
as text. The authenticated generation-bound `unpair` frame revokes only the
current socket member's credential hash and Origin, acknowledges with `unpaired`,
then closes. Lost acknowledgements show an unknown result; office settings are
authoritative. Offline revocation is done in office settings.
Run the opt-in office check with:

```
systemd-run --user --scope -p MemoryMax=2G timeout 75s xvfb-run -a env ISOMUX_TEST_BROWSER_EXTENSION=1 bun test server/browser-extension-office.live.test.ts
```

## Slice 3 review artifacts

The handoff copy inventory records all new/replaced English catalog strings,
rare errors, manifest/badge labels, documentation and browser system-prompt text
verbatim for Nil. The live fixture loads the downloaded ZIP rather than a source
directory and preserves settings/action-popup screenshots with sanitized
functional evidence. It uses the existing isolated production office fixture,
not a second server implementation. Packaged bytes, route boundaries, member
eligibility, exact extension sender, generation checks, deliberate disconnect,
terminal refusal and unknown unpair outcomes have focused tests. Runtime gates
are recorded on the committed handoff hash; no full CI is run between slices.

Chrome's `Read your browsing history` warning is documented in the installation
flow. Unpacked extension updates need download/extract/Reload in Chrome; office
updates produce the package automatically. Windows lag and site/account behavior
are not established by local Linux tests.

## Prior art

The pinned Playwright BrowserModel, ExtensionProtocolV2 and CDPRelayServer
informed the restricted adapter. References:
[Playwright relay](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts),
[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[CDP extension loader](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/).


### Background interaction correction (2026-09-19)

A raw Chrome reproduction showed that a hidden task tab could navigate and
fill, but a normal Playwright locator click waited indefinitely for animation
frames during its stability check. The previous launch-based fixture supplied
Playwright focus emulation and masked this difference. With `noDefaults: true`,
our public CDP connection omits that default override.

The extension now enables `Emulation.setFocusEmulationEnabled` on the exact
owned root/popup attachment and rechecks ownership after the await. Release
explicitly disables it before debugger detach. The real active tab and window
stay unchanged; released pages remain open. Native CDP input itself can leave
`document.hasFocus()` true on a hidden tab, so release does not promise that
property becomes false. The regression checks hidden visibility, debugger
detachment, retained pages and unchanged active tab/window instead.

Approved focus fix: `5f3d20a767e9f29e9f33e304e3ec409e8feaeeee`.
`server/browser-extension-background.live.test.ts` is the opt-in raw-Chrome
regression. Final evidence: `/tmp/isomux-background-proof-5bOWKQ/evidence.json`;
one live pass with 42 assertions. This proves background locator clicks on the
fixture, not YouTube audio playback. The separate legacy-panel fix at
`28e85f81` derives panel availability from the manager's current backend and
blocks headless watch/input for Desktop Chrome, including stale deliveries.


## Explicit tab offers (2026-09-19)

Protocol 4 and extension 0.4.0 require an explicit scope and per-offer expiry choice. Older protocol
versions fail before pairing or control. Update and reload the unpacked extension;
all tab offers must then be made again.

The popup captures the active tab in its current window using `activeTab`.
On Allow, the popup checks that anchor again. The worker fetches the exact tab id
and requires an active HTTP(S) tab in that window. It reserves
the tab and, for an individual offer, the agent locally, then sends a generation-bound `offer` with a random
assignment id and explicit scope. The server checks the current paired owner and individual agent access,
reserves the assignment, and sends `attach` for that id. The worker attaches only the
locally reserved tab and returns its target. The server validates the target and
access again before returning `offered`. No unrelated URL or title is sent.

Pending offers reserve the same identities as active offers. Off makes the local
assignment unusable before waiting for debugger cleanup and sends `detached` to
reject server work. Late attach results cannot restore the offer. Cleanup includes
focus emulation and the exact popup chain. The popup shows offering/revoking states.
The server publishes sanitized current eligible agent names over the same socket.
There is no new HTTP route. The Playwright transport consumes an existing offered
target; Target.createTarget is refused and the session never calls newPage.


## Server-file attachments

The browser action `{action: "upload", selector: "input#attachment", path: "/absolute/server/file.png"}` selects one regular server file, up to 4 MiB, in one matching file input. Chrome uploads use the same bounded file reader and public Playwright locator `setInputFiles` byte payload. The reader checks requested and resolved paths with the shared sensitive-file policy, opens the resolved file once, checks the descriptor type/size, and bounds its read. The payload contains a sanitized basename, MIME type and bytes; it never contains the server path. Unknown MIME types use `application/octet-stream`.

Playwright serializes this payload as base64 in Runtime commands through the existing in-process transport and owned-page bridge. The 4 MiB cap leaves room below the 8 MiB extension frame limit. No desktop-path `DOM.setFileInputFiles` command or new permission is needed. Missing/offline/unoffered ownership is checked before file loading; the extension action checks its original grant again after reading. Release/disconnect keeps the existing unknown-outcome and no-replay behavior.

Success adds `uploaded: {name, mimeType, size}` to url/title. Invalid paths, non-regular/unreadable/oversized/sensitive files return `invalid_request`; selector/input failures use the existing action error behavior. The action replaces one input’s selection and does not press a submit button. The site can start an upload on its input/change event. Directory and multiple-file selection are not supported by this action.


## Per-offer expiry

The popup offers Never, 15 minutes, 1 hour and 4 hours. Each new offer defaults to Never. The picker stays disabled while an offer is pending, ON or revoking; it resets only after ownership is gone. Established grants show Never or the authoritative deadline formatted in Chrome’s local time.

Protocol 4 requires `durationMinutes` to be exactly 0, 15, 60 or 240. The server starts the deadline after attachment succeeds, installs one identity-bound assignment timer, then sends `offered` with `durationMinutes` and `expiresAt`. Never uses null and no timer; timed grants use an absolute epoch-millisecond deadline. Metadata and popup state carry that same pair. Missing or inconsistent pairs fail closed. Metadata lists established targets only, so a pending offer is never cancelled by an earlier empty list.

The bridge releases expired ownership through the normal detach path, including before the first browser action and while work is pending. Ownership checks also enforce the deadline if timer delivery is delayed. Release cancels the timer; a late callback cannot revoke a replacement grant. Actions never reset the deadline. There is no hidden idle timer. Off, close, access loss, disconnect and reload still release grants and never replay work.

Protocol 3 and older extensions are refused before offer handling. Update/reload the extension and offer tabs again after deployment; an old extension that stored terminal refusal may require pairing again. Never does not restore grants after connection loss.


## Action timeout and command settlement

Desktop Chrome action timeouts preserve the offered assignment, its deadline and ON badge. Playwright receives the operation deadline; a separate watchdog runs one second later so normal TimeoutError cancellation can settle first. Both return action_timeout with unknown-outcome guidance. A timeout never proves that an already-dispatched Chrome command stopped.

The per-grant caller queue checks a separate recovery barrier before dispatch. A timed-out operation and its pending CDP commands must settle before a different action runs. A one-second cleanup wait bounds the response; if work remains, subsequent calls return action_timeout with a still-settling message and dispatch nothing. There is no retry or replay. Off, expiry and actual connection loss still release the grant. Individual access loss releases an individual grant; on All it rejects that caller while preserving other eligible callers.

For goto only, the bridge sends Page.stopLoading to the assignment’s owned root or active popup, then drains the original navigation command. Fill uses Runtime checks and Input.insertText; click uses Runtime/DOM checks and Input.dispatchMouseEvent; press uses Input.dispatchKeyEvent; payload upload uses Runtime.callFunctionOn. These commands have no generic cancellation claim: they remain fenced until their actual result or ownership loss. A command whose response deadline expires remains a tombstone; its late response resolves the barrier and is not delivered twice to Playwright. A retained client disconnect does not revoke the user offer, and replacement clients cannot attach over pending commands.

Page.stopLoading, introduced in extension 0.3.1, remains on the owned-page allowlist in protocol 4. Update the extension with the server for navigation cleanup. Logs contain action kind, deadline winner, elapsed time, assignment/generation, pending count and settlement/release state, never selectors, text, URLs, file contents or CDP payloads.

The extension popup masks pairing codes by default. Show/Hide explicitly reveals or masks the field; opening the pairing form, submitting it or closing the popup masks it again. The same behavior applies to initial and replacement pairing.

The popup keeps what the member types into the pairing form (office and code) in `chrome.storage.session`, in memory only, and fills it back in when the popup opens again; `browser-extension/pairing-draft.ts` holds it. The popup is its only writer. Submitting does not clear it or the code field. On the office's `paired` acknowledgement the worker records the confirmed code under its own session key; a draft or field holding that code then reads as empty, and a code typed since stays. A browser restart drops both.

## All grants and explicit targets (protocol 4 / extension 0.4.0)

Offers carry `scope:{kind:"all"}` or `scope:{kind:"agent",agentId}`. Popup default is All, with Office connection and Agent control sections. Metadata and acknowledgement validate the exact scope and expiry. Older peers fail closed. Reload requires re-offer; pairing data is preserved.

`tabs` returns accessible established grants with an opaque random target handle, scope and cached title/URL hints from owned target admission. It sends no page commands, so a busy grant does not block discovery or another grant. Handles never reuse Chrome IDs and die with the assignment or connection. Explicit target selection rechecks current access at queue entry and dispatch. Unqualified routing prefers an individual offer, then a sole All offer; multiple All grants return `browser_target_required` with no page metadata or dispatch.

Queues and timeout recovery belong to the generation/assignment, not an agent. A Playwright peer has one immutable actor. At an actor change, the prior operation and pending commands must settle before its retained client closes and a new client attaches to the same grant. Delayed retired peer commands/results/close cannot affect the replacement. Access loss rejects that caller without revoking an All grant for other eligible callers. Off, expiry, close and connection loss release the grant and its popup chain once for everyone. No automatic replay or transfer API exists.

Navigation status events refresh badges only for locally tracked roots and admitted popups. Every badge write rechecks current ON ownership after earlier awaits; Off and cleanup cannot leave a stale ON badge. Untracked tab updates are ignored without reading URL/title.

## Frame reads and clicks (extension 0.4.1)

The isolated 2026-09-21 probe showed two independent defects: main-body text/ARIA omits child documents, and denying `DOM.getFrameOwner` makes Playwright frame clicks time out during hit testing. Allowing that one command fixed same-origin and cross-origin clicks. The matching AWS production cause remains an inference until member acceptance. Existing frame fills did not exercise click hit testing.

`DOM.getFrameOwner` uses the existing exact grant/session authorization and Chrome page-session frame scope. It cannot select another target. No protocol, permission or arbitrary target-discovery expansion. Package 0.4.1 must accompany the server fix.

`browser-frames.ts` reads public `Frame` objects, root first and depth-first children, with labeled numeric `framePath` sections, one existing character budget, 64 documents and eight child levels. Child failures produce a content-free unavailable marker. Optional `framePath` on element actions resolves current `childFrames()` indices, then a strict public `Frame.locator`; missing paths fail before mutation. Paths are transient hints. No frame registry or internal selector contract. All calls retain the grant-level queue, actor access and recovery fence.

### Scoped reads and composer text (2026-09-22)

`text` and `snapshot` accept `selector` and/or `framePath`. Either field selects
one strict locator in one frame (defaults: `body`, main frame); neither field
keeps aggregate reads. Scoped reads do not traverse children. The existing
20,000-character budget also covers the snapshot's editable-text supplement.
`browser-frames.ts` selects visible, accessibility-present textboxes and reads
rendered text only from contenteditables. It omits empty values and values
already in the ARIA snapshot. It never changes the page to expose the text.

`browser-selector-errors.ts` maps known Playwright parser diagnostics to fixed
`invalid_request` guidance. It returns no exception fragment. Timeouts,
strictness failures, missing frames and unknown failures keep their existing
codes. Semantic selector example: `role=dialog >> role=button[name=/^Post$/]`;
`[exact=true]` is not a supported role attribute. CSS `[role="button"]` checks
an explicit HTML attribute rather than the computed accessibility role.

The real office/extension Chrome reading scenario in
`server/browser-extension-office.live.test.ts` reproduces a labeled
contenteditable textbox with nested spans, hidden controls, a long feed,
nested frame scopes and selector syntax errors. All page content is fake.
The pre-fix HTTP snapshot omitted the nested draft while `text` returned it.

## Several paired browsers (task e9f8d0b8, 2026-10-02)

A member pairs Chrome on several computers (or several Chrome profiles). Each
pairing is a separate **browser** with its own credential. All of them stay
paired, and agents use tabs offered from any of them.

**Stored shape.** `browser-connections.json` becomes version 2:
`{version: 2, members: {<memberId>: {browsers: [{id, name, hash, origin, pairedAt}]}}}`.
`id` is a random, non-secret handle; `pairedAt` is epoch ms or null. Load still
reads version 1 and the legacy flat map. A version-1 record with a valid
hash/Origin (from version 1 or the legacy flat map) becomes one browser named
`Browser 1` with `pairedAt: null`; a record without a valid credential becomes
no browser. The file is rewritten as
version 2 at the next pair or revoke, with the existing unavailable-file
preservation. A rollback restores the pre-update state snapshot, so no
downgrade reader is needed.

**Naming.** The member types an optional name next to Create pairing code
(sanitized like other display labels, at most 40 characters). An empty name
gets `Browser N`, the smallest unused N for that member. Duplicate names are
allowed. The code carries the name; the browser exists only after redemption.
There is no rename; Unpair and pair again.

**Pairing and replace.** `POST /api/me/browser/pair` takes `{name?}` and always
adds a browser. `browser_already_paired` (409) is gone. `replace` is retired:
a boolean `replace` is still accepted and ignored. This changes its meaning: an
old client that sends `replace: true` adds a browser, and the former browser's
credential stays valid until the member unpairs it. One pending code per member
remains; a new code voids the previous code.

**Re-pairing the same Chrome.** The protocol does not change. A Chrome that
pairs again with a new code is a new browser; its old row shows Offline until
the member unpairs it.

**Settings.** `GET /api/me/browser` keeps `paired` (any browser) and `online`
(any connected) and adds `browsers: [{id, name, pairedAt, online}]`. The
Connection card lists one row per browser: name, Connected/Offline, paired
date, and Unpair. The new route `DELETE /api/me/browser/browsers/:id` uses
`cap("user:self", authenticated)` like its siblings. It looks the id up only
among the caller's browsers; a missing id and another member's id both return
the same 404 `browser_not_found`. It revokes that browser, sends terminal
refusal to its socket only, and leaves a pending code alone. `DELETE
/api/me/browser` still revokes all browsers and clears the pending code. The
popup's Unpair revokes only its own browser.

**Connections.** The bridge keys live connections by credential hash, so each
browser has at most one live socket and pairing one browser never disconnects
another. Generations, queues (`generation:assignment`) and timeout recovery are
already per connection and stay unchanged.

**Agent tab selection.** The bridge resolves an agent's offers across all live
connections of its manager as one set:
- An agent has at most one individual offer across all browsers. The check
  covers offers still being created on every connection and runs before the
  async attach, so two browsers cannot race. An individual offer from a second
  browser is refused. That popup only knows its own tabs, so it shows the
  generic refusal, not the "This agent already has a tab" conflict; a specific
  message would need an extension change.
- Unqualified actions use the individual offer, otherwise a sole All offer
  from any browser. Several All offers, on one browser or several, return
  `browser_target_required`.
- `tabs` lists offers from every connected browser and adds `browser` (its
  name) to each entry. Target handles are random and unique across browsers.
- An action resolves its connection and grant together when it is queued. Before
  it runs, the session checks that exact pair again and returns
  `browser_control_ended` if it changed. A queued action never moves to another
  browser because an offer disappeared or a new one took precedence. Recovery
  and close stay scoped to that pair.
- `browser_not_paired`: no browser is paired. `browser_offline`: no paired
  browser is connected; its message becomes "No paired Chrome browser is
  online". An offline browser contributes no tabs.

**Prompt copy (server/system-prompt.ts).** The pairing sentence stays. "Use
{"action":"tabs"} to list accessible offered tabs as {target,scope,title,url};
... An individual offer takes precedence, otherwise a sole All offer is used."
becomes "...as {target,scope,browser,title,url}; ... Offers from all paired
browsers count together: an individual offer takes precedence, otherwise a sole
All offer is used."

**Not included.** Re-pairing in place, rename, a per-member browser cap, showing the browser name in
the extension popup.

## Clicks, select and dialogs (task 19b61d94, 2026-10-08)

Seen 2026-10-05 on the Namecheap Advanced DNS page: clicks on
`javascript:void(0)` links and on custom dropdown options returned
`action_timeout` after they took effect, there was no select action, and the
first click on Remove "did nothing". The opt-in regression is
`server/browser-extension-interactions.live.test.ts` (raw Chrome, packaged
extension, fixture bridge, the real session code; fake page that copies the
Namecheap patterns):

```
systemd-run --user --scope -p MemoryMax=2G timeout 120s xvfb-run -a env ISOMUX_TEST_BROWSER_EXTENSION=1 bun test server/browser-extension-interactions.live.test.ts
```

**Findings.** A listbox that picks its option in a window-capture pointerdown
listener reproduces the dropdown timeout: the page applies the value before
Playwright's hit-target listener runs, that listener then sees the page change
under the pointer, blocks the rest of the click and retries until the deadline.
The production journal for 2026-10-05 has the same shape: Playwright-internal
30 s waits with at most two of our commands pending. A plain
`javascript:void(0)` link and twelve navigation variants (hash, pushState, 204,
cancelled, download, hidden-frame form, and others) did not reproduce; an open
custom listbox already showed in snapshots. A native `confirm()` was
auto-dismissed without a trace. If that auto-dismiss failed (another CDP
client answered first), Playwright's server-side `dialog._close()` rejection
was unhandled and Bun ended the office process.

Playwright 1.62's `click({trial: true})` is not input-free: it dispatches the
mouse events and only blocks them in its own window listener, so earlier page
listeners still see them. The design does not use trial runs.

**Click.** One Playwright click with `noWaitAfter: true`: actionability, the
pre-dispatch hit-target check, then one dispatch, with no retry after the
dispatch and no navigation barrier. Ok means that Chrome dispatched the click
at the target's position after the target passed actionability; it does not
prove that the page applied it. The transport counts every `Input.*` command
it sends. A click that times out with no `Input` command sent during that
action dispatched no input: it returns `action_failed` with a fixed reason
(`browser-input.ts` picks it from the call log, which never leaves the module)
and no settling fence. Scrolling or page scripts can still have changed the
page. A timeout after an `Input` command keeps the unknown outcome and the
fence. Playwright colors its call log when the process allows color, so the
reason parser strips ANSI escapes first.

**Settle.** Listeners on the main frame and the action's frame start before
the dispatch. After a 300 ms window, the settle waits until each navigation
request ended or its frame committed after that request started, and for each
committed frame's load. It then waits one more 300 ms window and repeats if a
load handler started another navigation. All of this ends 500 ms before the
action deadline. A settle that runs out adds `loading: true` to an
ok result; it never turns a dispatched input into a failure.

**Select.** `{action:"select", selector, value}` or `label`. Read-only checks
run first: the element (first match on the main frame, strict in a frame),
`isEnabled` (includes disabled fieldsets), then the option that `selectOption`
picks, which is the first match in document order. Public utility-world reads
find it: a candidate locator that holds every match in document order, then
`getAttribute` and `textContent` per candidate, matched as Playwright 1.62
matches (value equal to `option.value`; label equal to `option.label` or equal
after `normalizeWhiteSpace`; Chrome's `option.text` strips and collapses ASCII
whitespace, and a `label=""` attribute gives an empty label). `isEnabled` on
that option decides; `selectOption` would wait on a disabled first match.
Chrome's `option.text` leaves out script descendants, which `textContent`
keeps. When the first candidate that needs its text has a script descendant,
the check is inconclusive and `selectOption` decides; a timeout there keeps the
unknown outcome and the fence (Isomux PM ruling, 2026-10-08). No
main-world evaluation: its context may not be announced after an All grant
changes clients. A failed check returns `action_failed` and changes nothing. The disabled check is one round trip
before the change, not atomic. `selectOption` then runs with `force: true`, so
a native select hidden under a styled control works, and the result adds
`selected`.

**Dialogs.** Each session page and popup has a `dialog` listener, so
Playwright's uncaught auto-close never runs. The listener answers at once:
dismiss, or accept for the first non-`beforeunload` dialog of an action that
sent `dialog: "accept"`; `beforeunload` is always accepted. A failed answer is
caught. The action's result lists `dialogs: [{type, message, accepted}]`, and a
failure carries the same list as `error.dialogs` (the route passes it as error
detail);
`accepted` is true only after Chrome confirmed the accept. The policy is
cleared on every exit, so a later dialog is dismissed and reported nowhere.

**Out of scope.** A click on a custom-protocol link (`x-proto://`) ends control
(the grant is released); reported to Isomux PM separately.
