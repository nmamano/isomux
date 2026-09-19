# Chrome extension bridge

## Scope and status

Slice 2 connects the Chrome extension to the production browser action route.
The member API is ready for the slice-3 settings and extension UI. Headless
browser use remains the default, and preview capture stays on the office server.
No production restart has been authorized. Windows and real-site acceptance
belong to Nil. This is the maintained protocol and ownership reference.

## Member flow and state

The normal route table declares these self-scoped routes. All four require
`cap("user:self", authenticated)`, as personal preferences do. An agent token
cannot use them. Other identities need that actual capability; owning another
member's office does not select that member's browser.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/me/browser` | Read backend, paired and online state |
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
Missing backend values read as headless. Malformed or unreadable browser state
starts unpaired with headless defaults and does not prevent office startup. The
server preserves the unreadable file until an explicit member write replaces it.
No raw credential or pairing code is
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
`{kind: "hello", version: 1, code}` or the same shape with `credential`.
Pairing returns `{kind: "paired", version: 1, credential}` before
`{kind: "ready", version: 1, generation}`. Authentication binds the credential
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
member changes it. No command queue survives disconnection or either restart.
A new connection gets a fresh generation, Playwright object and task assignment.
The new assignment may open a new tab. Previously opened pages remain open.

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

Each agent has one main task tab. Root discovery exposes only that assignment's
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
also ends after 15 minutes without an action, leaving the real page open.

Stable extension errors are `browser_not_paired`, `browser_offline`,
`browser_control_ended`, and `action_failed`. Control loss, deadline or revocation
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

Build: `bun run build:extension`; output: `browser-extension/dist/` (ignored).
Run the opt-in office check with:

```
systemd-run --user --scope -p MemoryMax=2G timeout 75s xvfb-run -a env ISOMUX_TEST_BROWSER_EXTENSION=1 bun test server/browser-extension-office.live.test.ts
```

## Copy inventory and slice 3

Existing manifest/title: `Isomux Browser`.
Manifest description: `Connect Chrome task tabs to an Isomux office.`
Setup placeholder: `Browser connection setup is not available in this build.`

New route/action messages, verbatim:

- `backend must be headless or extension`
- `replace must be a boolean`
- `A Chrome browser is already paired`
- `No Chrome browser is paired`
- `The Chrome browser is offline`
- `The Chrome browser action failed`

Existing bridge messages remain: `Browser connection refused`,
`Browser assignment refused`, `Browser transport is not available`,
`Browser command refused or failed`, `Browser command failed`,
`Browser control ended; pending outcomes may be unknown`, and
`Browser disconnected; pending outcomes may be unknown`.
The upgrade can return `WebSocket upgrade failed`. Existing request validation,
no-page errors, truncation labels and screenshot captions remain.
Chrome supplies its own debugger warning. The new `webNavigation` permission
adds the documented Chrome warning `Read your browsing history`; include it in
Nil's installation report.

Slice 3 supplies member settings, pairing input, extension ownership/status badge
and popup, disconnect/re-pair controls, installation packaging, and agent guidance.
It must show the member identity and active assignments and explain desktop
localhost, retained pages, popup return and unknown outcomes. Public prose belongs
in the surfaces listed in `documentation.md`; collect it for Nil's sign-off.
No remote streaming panel or Browsers page is part of this loop.

## Prior art

The pinned Playwright BrowserModel, ExtensionProtocolV2 and CDPRelayServer
informed the restricted adapter. References:
[Playwright relay](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts),
[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[CDP extension loader](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/).
