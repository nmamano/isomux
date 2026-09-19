# Chrome extension bridge

## Scope and status

Slice 3 adds member settings, the extension action popup and a downloadable
package to the production bridge. Headless remains the legacy default; selecting
Chrome is explicit. Preview capture stays on the server. Windows and real-site
acceptance remain with Nil. No production restart is authorized.

## Member flow and state

The normal route table declares these self-scoped routes. All five require
`cap("user:self", authenticated)`, as personal preferences do. An agent token
cannot use them. Other identities need that actual capability; owning another
member's office does not select that member's browser.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/me/browser` | Read backend, paired/online state, member label and package version |
| GET | `/api/me/browser/extension.zip` | Download the built extension with attachment/no-store headers |
| PATCH | `/api/me/browser` | Select `headless` or `extension` |
| POST | `/api/me/browser/pair` | Create a pairing code; `replace: true` permits replacement |
| DELETE | `/api/me/browser` | Revoke the credential and end control |

The server creates a 32-byte random base64url code, valid for five minutes and
one redemption. A new code replaces the member's pending code. Code hashes live
only in memory. The authenticated response contains the code and expiry.
Creating a replacement code leaves the live browser alone. Redemption validates
protocol version, code, current member existence and exact extension Origin,
consumes the code, atomically writes the new credential hash and Origin, closes
the old connection, then sends the new credential. A failed send does not restore
the code. The member pairs again after a lost paired response.

`browser-connections.json` is an atomic 0600 file keyed by member id. Records
contain the selected backend, credential SHA-256 hash and extension Origin.
A genuinely absent file uses the headless migration default. Corrupt or unreadable
state leaves browser selection unavailable, without preventing office startup.
An invalid stored backend blocks that member. Actions return
`browser_selection_required` and never call the headless pool until an explicit
member selection. Status reports `backend: null` and `selectionRequired: true`.
The server preserves the source inode under a unique `.unavailable-` filename
by same-directory rename before atomic replacement, including an unreadable
directory at the state path. If the write fails, the server restores the source
path so a restart still requires selection. The version-1 file envelope retains the unavailable
default for other members after one member repairs their selection; legacy member
maps still load. No source content is logged or returned. PM confirmed this rule
on 2026-09-19. No raw credential or pairing code is
stored server-side. Raw credentials travel only in the paired WebSocket frame
and trusted extension-local storage. They are not office authentication tokens.

Selection is explicit. Pairing does not select extension mode. A backend switch
ends that member's old sessions across agents. Extension mode never falls back
to headless while offline. No website cookies or profile state are exported,
reset or imported by the extension path.

## Socket and recovery

The extension opens `/browser-extension/ws` on the office host. App host diversion
runs first. The socket has its own dispatch discriminator and cannot enter the
office event stream. The upgrade requires the canonical office Host and exact
`chrome-extension://[a-p]{32}` Origin. Remote configuration requires WSS and an
HTTPS office origin. Loopback HTTP/WS is accepted for isolated local fixtures.
URL credentials, query strings and fragments are refused.

The first frame, within five seconds and at most 4 KiB, is
`{kind: "hello", version: 3, code}` or the same shape with `credential`.
Pairing returns `{kind: "paired", version: 3, credential}` before
`{kind: "ready", version: 3, generation}`. Authentication binds the credential
hash to the saved extension Origin. Duplicate live connections are refused;
only explicit replacement displaces the current connection.

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

Each agent has one explicitly offered main tab. Root discovery exposes only that assignment's
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
closing any page or stopping another agent's task tab.

## Action contract and errors

`POST /api/agents/:id/browser` keeps its existing actions and screenshot-card
shape. `preview-url` is unchanged. The extension uses the actual desktop viewport;
it does not apply the headless viewport or download policy. Desktop localhost
means the member's computer. Upload/download behavior is not promised.
`close` means detach and leave the page open. The old headless path still closes
its page and retains its existing profile and idle behavior. Extension control
uses the fixed per-offer expiry selected in the popup, defaulting to Never.
Expiry detaches control and leaves the real page open; actions do not extend it.

Stable extension errors are `browser_selection_required`, `browser_not_paired`, `browser_offline`,
`browser_control_ended`, `action_timeout`, and `action_failed`. Control loss, an action timeout or revocation
can leave a side effect with an unknown outcome. The server never retries it.
Invalid requests and missing task pages retain the existing validation errors.

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
settings pane is open. The Allow toggle names the current tab and selected agent;
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

Protocol 3 and extension 0.3.0 require an explicit per-offer expiry choice. Older protocol
versions fail before pairing or control. Update and reload the unpacked extension;
all tab offers must then be made again.

The popup captures the active tab in its current window using `activeTab`.
On Allow, the popup checks that anchor again. The worker fetches the exact tab id
and requires an active HTTP(S) tab in that window. It reserves
both tab and agent locally, then sends a generation-bound `offer` with a random
assignment id and agent id. The server checks the current manager and room access,
reserves the agent, and sends `attach` for that id. The worker attaches only the
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

The browser action `{action: "upload", selector: "input#attachment", path: "/absolute/server/file.png"}` selects one regular server file, up to 4 MiB, in one matching file input. Both backends use the same bounded file reader and public Playwright locator `setInputFiles` byte payload. The reader checks requested and resolved paths with the shared sensitive-file policy, opens the resolved file once, checks the descriptor type/size, and bounds its read. The payload contains a sanitized basename, MIME type and bytes; it never contains the server path. Unknown MIME types use `application/octet-stream`.

Playwright serializes this payload as base64 in Runtime commands through the existing in-process transport and owned-page bridge. The 4 MiB cap leaves room below the 8 MiB extension frame limit. No desktop-path `DOM.setFileInputFiles` command or new permission is needed. Missing/offline/unoffered ownership is checked before file loading; the extension action checks its original grant again after reading. Release/disconnect keeps the existing unknown-outcome and no-replay behavior.

Success adds `uploaded: {name, mimeType, size}` to url/title. Invalid paths, non-regular/unreadable/oversized/sensitive files return `invalid_request`; selector/input failures use the existing action error behavior. The action replaces one input’s selection and does not press a submit button. The site can start an upload on its input/change event. Directory and multiple-file selection are not supported by this action.


## Per-offer expiry

The popup offers Never, 15 minutes, 1 hour and 4 hours. Each new offer defaults to Never. The picker stays disabled while an offer is pending, ON or revoking; it resets only after ownership is gone. Established grants show Never or the authoritative deadline formatted in Chrome’s local time.

Protocol 3 requires `durationMinutes` to be exactly 0, 15, 60 or 240. The server starts the deadline after attachment succeeds, installs one identity-bound assignment timer, then sends `offered` with `durationMinutes` and `expiresAt`. Never uses null and no timer; timed grants use an absolute epoch-millisecond deadline. Metadata and popup state carry that same pair. Missing or inconsistent pairs fail closed. Metadata lists established targets only, so a pending offer is never cancelled by an earlier empty list.

The bridge releases expired ownership through the normal detach path, including before the first browser action and while work is pending. Ownership checks also enforce the deadline if timer delivery is delayed. Release cancels the timer; a late callback cannot revoke a replacement grant. Actions never reset the deadline. The old Desktop Chrome session idle timer is removed; Server browser idle behavior is unchanged. Off, close, access loss, disconnect and reload still release grants and never replay work.

Protocol 2 extensions are refused before offer handling. Update/reload the extension and offer tabs again after deployment; an old extension that stored terminal refusal may require pairing again. Never does not restore grants after connection loss.


## Action timeout and command settlement

Desktop Chrome action timeouts preserve the offered assignment, its deadline and ON badge. Playwright receives the operation deadline; a separate watchdog runs one second later so normal TimeoutError cancellation can settle first. Both return action_timeout with unknown-outcome guidance. A timeout never proves that an already-dispatched Chrome command stopped.

The per-agent caller queue checks a separate recovery barrier before dispatch. A timed-out operation and its pending CDP commands must settle before a different action runs. A one-second cleanup wait bounds the response; if work remains, subsequent calls return action_timeout with a still-settling message and dispatch nothing. There is no retry or replay. Off, expiry, access loss and actual connection loss still release the grant.

For goto only, the bridge sends Page.stopLoading to the assignment’s owned root or active popup, then drains the original navigation command. Fill uses Runtime checks and Input.insertText; click uses Runtime/DOM checks and Input.dispatchMouseEvent; press uses Input.dispatchKeyEvent; payload upload uses Runtime.callFunctionOn. These commands have no generic cancellation claim: they remain fenced until their actual result or ownership loss. A command whose response deadline expires remains a tombstone; its late response resolves the barrier and is not delivered twice to Playwright. A retained client disconnect does not revoke the user offer, and replacement clients cannot attach over pending commands.

Extension 0.3.1 adds Page.stopLoading to the owned-page allowlist; wire protocol remains 3. Update the extension with the server for navigation cleanup. Logs contain action kind, deadline winner, elapsed time, assignment/generation, pending count and settlement/release state, never selectors, text, URLs, file contents or CDP payloads.
