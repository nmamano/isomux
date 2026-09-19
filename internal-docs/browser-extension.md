# Chrome extension bridge

## Scope and status

Slice 1 proves the browser transport. The production `/browser` route and
headless preview code still use their existing implementation. No production
route imports this bridge or its isolated fixture. Pairing, persistent browser
records, agent routing, reconnect UI, owned popups, badge/popup, and installation
instructions belong to later slices. Windows and real-site acceptance belong
to Nil. This document is the maintained protocol and ownership reference.

## Public Playwright seam

Playwright 1.62.1 runs in the Bun office process. Its public
`chromium.connectOverCDP(transport, { noDefaults: true })` overload accepts a
`ConnectOverCDPTransport`. `server/browser-extension-transport.ts` connects
that object directly to one authorized bridge assignment. There is no agent
CDP HTTP or WebSocket endpoint. No private Playwright module is imported.

On 2026-09-19 (office date), the endpoint overload failed against an isolated
Bun 1.3.11 WebSocket server: Playwright's bundled WebSocket client treated the
HTTP 101 upgrade as a normal response. The direct public transport bypasses
that client. PM approved this seam without a runtime upgrade or a child process.
The pinned Chromium implementation sends commands without calling the optional
transport `open`, so the adapter establishes its assignment at construction.

`noDefaults` preserves the default context's download, focus, and media
settings. The root adapter handles only `Browser.getVersion`,
`Target.setAutoAttach`, `Target.getTargets`, `Target.getTargetInfo`,
`Target.createTarget`, and `Target.attachToBrowserTarget`. The last command
creates a synthetic browser session with the same restricted assignment view.
It never attaches a real profile-wide debugger session. Other root commands,
including cookie/storage/browser-context access, fail. The shared protocol
lists allowed page-session methods. Unknown methods fail instead of using an
arbitrary attached tab.

## Ownership and transport

`BrowserExtensionBridge` receives a credential-hash lookup and a live
member/agent authorization callback. It hashes the presented browser credential
and retains the hash for revalidation. One live extension connection belongs
to one member. Each agent has a separate assignment and synthetic CDP session;
each assignment can create one main task tab. Creating a second task tab fails.
The member's active tab never selects or changes an assignment.

Only the extension creates and attaches a task tab. The server checks the
assignment and generation before sending page commands. The extension checks
its own assignment map before calling `chrome.debugger.sendCommand`. Both sides
track child sessions from the owned debugger attachment. The extension limits
auto-attach to iframe targets. Root discovery reports only the task target;
unrelated tabs never enter the agent target map. No popup support is claimed yet.

The MV3 worker opens an outbound WebSocket. Remote URLs require `wss:`;
unencrypted `ws:` is accepted only with exact loopback hostnames for local
fixtures. URL credentials, queries and fragments are refused. The first frame
is `{kind: "hello", version: 1, credential}`. The listener authenticates before
calling `bridge.connect`. The reply is `{kind: "ready", version: 1, generation}`.
The fixture supplies a random browser-only credential bound to one fake member;
no production pairing bypass exists. Extension-local storage is restricted to
trusted extension contexts. There is no content script, externally-connectable
declaration, web-accessible resource, or page-to-extension messaging handler.

The version-1 command envelope contains `kind`, `generation`, `id`,
`assignment`, `method`, and `params`. Methods are `create`, `cdp`, and `detach`.
Results echo the generation and request id, with a result object or a generic
error. Events carry the generation, assignment, method, params, and optional
child session id. CDP payloads and credentials are never logged. Request ids
increase within a connection; a new connection has a fresh random generation.

## Disconnect and end control

Connection loss rejects all pending requests, closes every affected Playwright
transport, clears assignments, and detaches the extension's debugger sessions.
No command queue survives. Late results and events from old generations are
discarded. A fresh connection needs a fresh Playwright object and assignment.
Already dispatched page code may have taken effect: callers receive an unknown
outcome, never an automatic retry. Closing one agent's transport detaches its
tab and leaves the real page open. Detach during tab creation prevents the
pending creation from acquiring a debugger after control ends.

Each in-flight extension request currently has a 30-second deadline. A deadline
closes the connection as an unknown outcome. Slice 2 must integrate this with
action cancellation, revocation notifications and member-wide connection loss.
It must not retry commands after the deadline. Authentication is rechecked on
dispatch and event delivery; persistent revocation must also actively close the
connection. No automatic reconnect is shipped in this slice.

## Evidence and checks

The live check loads the actual built extension through the public CDP
`Extensions.loadUnpacked` command in a fresh Chrome profile. Setup uses
Playwright's private pipe and `--enable-unsafe-extension-debugging`; it omits
Playwright's `--disable-extensions` launch default. It exposes no debug port.
The setup connection only loads/configures the extension, creates an unrelated
tab, and inspects final target existence. All task-page reads, actions and the
screenshot pass through the extension bridge.

The local form check proves snapshot/text, fill, trusted mouse click and PNG
capture. The lifecycle check observes a site-side counter before cutting the
connection while evaluation waits, requires rejection, then creates a fresh
connection and verifies the counter remains one. It also checks assigned-only
discovery, refusal of a second task tab and root cookie access, and that ending
control leaves task and unrelated pages open.

Development evidence, 2026-09-19 office date: Chrome 151.0.7922.137,
Playwright 1.62.1, Bun 1.3.11; successful local proof in
`/tmp/isomux-extension-proof-qdvGaq/` (development tree, not a release gate).
Final gate logs record the committed start and end hash; the review handoff
identifies those paths. These are functional sanity checks, not latency results.
No account mutations or Windows acceptance are inferred from them.

Build: `bun run build:extension`. Output: `browser-extension/dist/` (ignored).
Normal checks include extension sources in root TypeScript and ESLint, build
the extension during CI, and run the three focused test files above. The real
Chrome command is recorded in [the testing guide](testing-guide.md).

## Copy inventory

Extension manifest name and page title: `Isomux Browser`.
Manifest description: `Connect Chrome task tabs to an Isomux office.`
Setup page: `Browser connection setup is not available in this build.`
No badge, popup, or other extension status UI exists in this slice.

Errors that can reach the Playwright caller: `Browser connection refused`,
`Browser assignment refused`, `Browser transport is not available`,
`Browser command refused or failed`, and
`Browser control ended; pending outcomes may be unknown`.
The bridge's internal pending errors also use `Browser command failed` and
`Browser disconnected; pending outcomes may be unknown`; CDP emits the generic
failure above. No browser or protocol payload is included in these strings.

The fixture page alone shows `Bridge form`, `Message`, `Apply`, and, after the
test, `extension proof`; its unrelated page shows `Unrelated fixture tab`.
Chrome supplies its own debugger warning; its wording is not owned by Isomux.

## Prior art and next-slice limits

The pinned package's `BrowserModel`, `ExtensionProtocolV2`, and `CDPRelayServer`
were read as prior art. The upstream relay virtualizes browser-level commands
and maps tab debugger events to CDP sessions. This bridge changes that model
to assignment-only discovery and rejects arbitrary profile commands.
Reference: [official Playwright relay source](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts).

Chrome restricts debugger domains and supports flattened child sessions from
Chrome 125. Its target auto-attach needs explicit handling for frame trees.
Reference: [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
The test loader is the public
[CDP Extensions API](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/).

Slice 2 must add production pairing, credential persistence/revocation,
manager-derived identity, explicit backend selection, socket heartbeat and
reconnect, popup ownership and frame tests. It must validate the production
WebSocket handshake and TLS deployment, including Origin and office binding;
the loopback fixture is not that authorization boundary. The page-method list
does not promise downloads, uploads, cookies, permissions, popup behavior or
arbitrary CDP compatibility. Server-local preview remains a separate path.
Later copy belongs in the surfaces listed in `documentation.md`; this slice
does not add a member-visible production feature.
