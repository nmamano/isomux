# Browser use for isomux agents

Status: exploration and prototype. Nothing here is merged. Task 9b174a6a.
Written 2026-09-05 in the `browser-use` worktree.

Every claim below names its source. A claim with no source is marked
**unverified**.

## 1. What the question is

An isomux agent can screenshot a page today (`POST /api/agents/:id/preview-url`).
It cannot open a page, read the page, click a control, or fill a form. This
document asks how to give agents that, on all three backends, and what it costs.

## 2. Recommendation in one paragraph

Isomux runs one headless Chrome, gives each agent its own browser context, and
exposes the actions as an isomux REST route (`POST /api/agents/:id/browser`).
This works on Claude, Codex and OpenCode on the day it lands, because all three
backends reach isomux the same way they already reach `preview-url`. The MCP
route (`@playwright/mcp`) is real and works, but it puts the screenshot in the
chat on Claude only (section 6.3), it needs different wiring in each backend
(section 5), and it is invisible to the isomux safety policy (section 7.1).
Section 9 lists the design questions this recommendation answers, so a reversal
is one revert.

## 3. What each backend gives

### 3.1 Claude Agent SDK 0.3.257

- No built-in browser or computer-use tool. A grep of `sdk.d.ts` for
  `computer`, `browser`, `chrome` and `playwright` returns only sandbox notes
  about macOS XPC services and browser-based auth. Source:
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- MCP servers are a session option: `Options.mcpServers?: Record<string,
  McpServerConfig>` (`sdk.d.ts:1813`, 0.3.270). `strictMcpConfig` (`sdk.d.ts:2145`)
  makes that option the only source.
- A live session can list and change its MCP servers: `mcpServerStatus()`
  (`sdk.d.ts:2775`), `setMcpServers()` (`sdk.d.ts:2935`), and
  `toggleMcpServer()`. `internal-docs/per-agent-mcp-access.md` already
  describes this surface for account-level connectors.
- Isomux passes **no** `mcpServers` option. `SdkSessionOptions`
  (`server/backends/claude.ts:53-69`) is a strict subset of the SDK options and
  has no MCP field. A Claude agent therefore gets MCP only from disk: a
  `.mcp.json` in its working directory, its Claude settings, and its
  claude.ai account connectors. This is how the Stripe MCP reaches agents in
  `~/nil/isomux`.
- The Chrome extension that Claude Code can drive is a desktop-browser feature.
  It needs a browser window that a person is signed in to. It does not apply to
  a headless server. **Unverified**: I did not find an extension surface in
  `sdk.d.ts`, and I did not read vendor documentation for it, because the
  headless conclusion does not depend on the detail.

### 3.2 Codex 0.144.6 (App Server)

- No built-in browser tool. The app-server tool config is `ToolsV2`, and it
  holds one field, `web_search`. Source:
  `server/backends/codex/_generated/v2/ToolsV2.ts`.
- Codex reads MCP servers from `mcp_servers.<name>` in `config.toml`, and it
  accepts the same key as a dotted override. Measured 2026-09-05 with
  `CODEX_HOME` pointed at an empty temporary directory:

  ```
  codex -c 'mcp_servers.probe.command="echo"' -c 'mcp_servers.probe.args=["hi"]' mcp list
  Name   Command  Args  Env  Cwd  Status   Auth
  probe  echo     hi    -    -    enabled  Unsupported
  ```

  Binary:
  `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
- `thread/start` takes a per-thread override map, `config?: { [key: string]:
  JsonValue }`. Source:
  `server/backends/codex/_generated/v2/ThreadStartParams.ts`. Isomux already
  sends dotted keys in it: `CODEX_THREAD_CONFIG_OVERRIDES` sets
  `memories.use_memories` and `memories.generate_memories`
  (`server/backends/codex/adapter.ts:148-152`, used at `adapter.ts:852`).
- **Unverified**: that the app-server `config` map accepts `mcp_servers.*` the
  way the CLI `-c` flag does. The two share a dotted-key shape and isomux
  already uses the map for other dotted keys, so it is likely. It needs a live
  app-server run to be a fact.

### 3.3 OpenCode 1.18.23

- MCP servers live under the `mcp.<name>` path of `opencode.json`. The bundled
  binary writes exactly that path in `opencode mcp add`, and the local server
  shape is `{ type: "local", command: [...], environment: {...} }`. Source:
  strings extracted from `node_modules/opencode-linux-x64/bin/opencode`
  (`J1(C,["mcp",D],u,...)` in the `add` handler, and the three
  `{type:"local",command:...}` literals).
- Isomux owns that file. `OpenCodeSupervisor.ensureServer()` writes
  `opencode.json` from `this.config` on every server start
  (`server/backends/opencode/supervisor.ts:236`), and the content is
  `DEFAULT_OPENCODE_CONFIG` (`supervisor.ts:26`). Adding an `mcp` block is one
  edit to that constant.
- The file is per **environment-source identity**, not per agent
  (`server/backends/opencode/profile-paths.ts`), so an MCP server added there
  reaches every OpenCode agent that shares the profile.
- Isomux declares `mcp: false` for OpenCode
  (`server/backends/opencode/adapter.ts:62`) against `mcp: true` for Claude
  (`server/backends/claude.ts:165`) and Codex
  (`server/backends/codex/adapter.ts:168`). The flag is declared in
  `shared/types.ts:102` and read nowhere in `server/` or `ui/`. It is a label,
  not a gate, and the label understates what OpenCode can do.

## 4. What runs on this box

Measured 2026-09-05 on the office box (auntie, 24 GB RAM, 8 CPUs).

- `/usr/bin/google-chrome` is Google Chrome 151.0.7922.137.
- `playwright-core` 1.62.1 was already on the box before this work, declared by
  `control-plane/web/package.json` and installed at
  `/home/nil/nil/isomux/control-plane/web/node_modules/playwright-core`; the
  probes below imported that exact nested path. This branch adds it as a root
  dependency, so after the merge a reader finds it at
  `node_modules/playwright-core`. Its `package.json` has no `scripts` and no
  `dependencies`, so it downloads no browser of its own. Unpacked size 14 MB.
- Playwright drives the system Chrome with `channel: "chrome"`. A probe launched
  the browser in 521 ms, set page content, read the title, clicked a button,
  read the changed text, produced an ARIA snapshot, and wrote a 7.7 kB PNG. Full
  run 2.4 s. Probe kept at `/tmp/bu-probe/probe.ts`, outside the repo.
- The ARIA snapshot is the same page representation `@playwright/mcp` returns,
  and it is a public `playwright-core` API (`locator.ariaSnapshot()`). It is
  what makes a page readable to a model without sending the HTML.

## 5. The MCP route

`@playwright/mcp` is at 0.0.80 and depends on `playwright@1.63.0-alpha-2026-08-31`
and `playwright-core` at the same alpha. Source: `registry.npmjs.org/@playwright/mcp`,
read 2026-09-05. One consequence: the dependency is pre-1.0 and pinned to an
alpha of Playwright.

An earlier draft of this section claimed that `playwright` downloads browser
binaries during install, so an isomux self-hoster would pay for them. That is
false. `playwright@1.62.1` has `"scripts": null` in its `package.json`
(`/home/nil/.bun/install/cache/playwright@1.62.1@@@1/package.json`, read
2026-09-05), so the package runs no install script and downloads nothing;
browsers arrive only through `npx playwright install`. Correction from Isomux
Reviewer 4, verified locally. The footprint difference between the two routes is
therefore small, and the case against MCP rests on the per-backend wiring and
the safety gap, not on install size.

Wiring per backend, if isomux took this route:

| Backend | Where the server is attached | Per agent? |
| --- | --- | --- |
| Claude | new `mcpServers` field on `SdkSessionOptions`, passed to the SDK | yes, and live-togglable |
| Codex | `mcp_servers.*` keys in the `thread/start` config map | yes, per thread (**unverified**, section 3.2) |
| OpenCode | `mcp` block in `DEFAULT_OPENCODE_CONFIG` | no, per profile |

So the MCP route needs three separate changes, gives per-agent control on two
backends out of three, and adds a pre-1.0 dependency. It also spawns one Node
process **and one Chrome** per agent session (section 8).

## 6. The isomux-native route

### 6.1 Shape

One module, `server/browser-session.ts`, owns:

- one headless Chrome for the whole office, launched on first use;
- one `BrowserContext` per agent, created on first use and closed when idle;
- the actions: `goto`, `snapshot`, `text`, `click`, `fill`, `press`,
  `screenshot`, `close`.

One route, `POST /api/agents/:id/browser`, with the same
`self:affordance` capability and `agentParamMustEqualTokenAgent` guard the other
affordances use (`server/routes/table.ts:541-548`).

### 6.2 Why the browser resolution is shared

`preview-capture.ts` already resolves the browser: `ISOMUX_PREVIEW_BROWSER`,
then `BROWSER_CANDIDATES` on `PATH`, then `BROWSER_ABSOLUTE_PATHS`
(`server/preview-capture.ts:102-118, 214-228`). The comment records why the
absolute paths are needed: a systemd unit has a minimal `PATH`. The browser
session passes the same result to Playwright as `executablePath`, so one rule
holds for both features and the existing environment override keeps working.

### 6.3 Why the screenshot lands in chat on all three backends

`emitAgentPreviewUrl` saves the PNG with `savePersistedFile` and writes a
`file-view` log entry marked `{ preview: true }`
(`server/agent-manager.ts:2257-2292`). A browser screenshot reuses that path
without change.

The MCP route does not have this. For **Claude only**, isomux extracts base64
image blocks out of a `tool_result` and attaches them to the tool card
(`server/backends/claude.ts:1018-1052`). The comment on that branch says it
plainly: "Codex agents never hit this path; they go straight to /read-file."

The Codex adapter does record the MCP result, but as text: it sets the tool
result content to `JSON.stringify(result ?? {})` with no attachments
(`server/backends/codex/adapter.ts:1792-1817`). So a Playwright MCP screenshot
becomes an image card for a Claude agent, and for a Codex agent it becomes a
JSON blob carrying base64 in the visible transcript. That is worse than
invisible. OpenCode is untested here.

## 7. Safety

### 7.1 What the isomux safety policy sees today

- Claude: `createSafetyHooks()` registers `PreToolUse` matchers for eight tool
  names - `Bash`, `Read`, `NotebookRead`, `Grep`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit` (`server/safety-hooks.ts`). There is no `mcp__*` matcher. An
  MCP tool call from a Claude agent never reaches the policy.
- Codex: the hook fires before MCP actions. `internal-docs/safety-hooks.md`
  records that `PreToolUse` "covered every measured Bash, `apply_patch`,
  dynamic-tool, and MCP action before its side effect" (Codex 0.144.6,
  2026-08-28 and 2026-08-29).
- OpenCode: `permission.asked` covers asked tools. Read, grep and glob emit no
  permission event (same document).
- Where the policy does see an MCP call, it allows it. The action kind is
  `uncovered-tool` and its branch returns `allow()`
  (`server/safety-policy.ts:2063-2064`).

`internal-docs/safety-hooks.md` already names this as a live residue: "A
filesystem-capable MCP remains a concrete route around the built-in tool
mappings. On 2026-08-30, live policy checks allowed such an MCP to write Isomux
state, read a backend login file, and replace the Codex checker executable."

A browser MCP is filesystem-capable in three ways: it can navigate to `file://`
URLs, it can save a screenshot or a PDF to a path the model chooses, and it can
upload a local file into a form. So the MCP route adds a new instance of a
residue the project has already written down.

The isomux route narrows that gap, and it is worth being exact about how far.
The rules run inside the route handler, in the isomux process, before Playwright
is called: the scheme must be http or https, the URL may carry no credentials,
and the context refuses downloads. That is enforcement rather than a policy layer
that returns `allow()`.

**There is no origin policy.** The check runs on the URL the agent passes to
`goto`, and a page navigates itself afterwards. Measured 2026-09-05 against
Chrome 151.0.7922.137 with a one-off script at `/tmp/bu-probe/nav.ts` - outside
the repo by design, so it is not expected to survive; the results are the
record:

| What the page tried | What Chrome did |
| --- | --- |
| click a `file://` link from an http page | refused, URL unchanged |
| `location.href = "file://..."` from an http page | refused, URL unchanged |
| a 302 from http to `file://` | refused, `net::ERR_UNSAFE_REDIRECT` |
| a 302 from http to another http path | followed |

So the **scheme** boundary holds after `goto` as well, because Chrome enforces
it, not because isomux does. The **origin** boundary does not exist: a page can
navigate itself to any other http(s) origin, exactly as it can for a person
following a link. That is deliberate. An origin allowlist would be a human
approval gate wearing a different coat, and Nil's philosophy rules it out.

Two observations from the same run, neither of them a policy:

- A refused navigation leaves the page on `chrome-error://chromewebdata/`. This
  is **observed behaviour, not a `no_page` state**: it is a real page, so a
  following `snapshot` reads Chrome's error page and answers normally. Only
  `about:blank` reads as no page.
- `window.open` creates a **second page inside the agent's context**. The
  implementation adopts the new window as the agent's page, the way a person
  following a `target=_blank` link ends up on the new tab, and closes the page
  it left. One page per agent is an invariant, not a cap: the footprint in
  section 8 was measured with one page per context, and a second live page
  would multiply the per-context cost the shared-browser case is argued from.
  The swap runs on the agent's own queue, so a click that opens a window
  answers from the page it clicked and the swap lands after it.

### 7.2 What is new about a driving browser

`preview-url` renders an untrusted page. The compensating control is the agent
system prompt, which tells the agent to decline suspicious sites
(`server/preview-capture.ts:6-13`, `server/system-prompt.ts:105`). A driving
browser goes further: it can submit a form, follow a login, and act as the
person whose cookies the profile holds.

The browser now holds the manager's logins. That is the point of the
feature, and it raises the consequence of a hostile page or mistaken action.
The boundary is ownership: the office stores one profile per member under its
state root, every agent managed by that member shares it, and another member's
agents never load it. If a member asks an agent managed by someone else to use a
login, the agent confirms that it will act with its manager's profile first.

The browser keeps the other enforced boundaries: http(s) only for the URL the
agent passes, no credentials in that URL, refused downloads, Chrome's sandbox,
and one page per agent. There is no permission prompt and no origin allowlist.
The context closes after 15 idle minutes, but its storage state persists.

The selected mechanism is Playwright `storageState`, saved with
`indexedDB: true` and `credentials: true`. In Playwright 1.62.1 this captures
cookies, local storage, IndexedDB and virtual WebAuthn credentials. It does not
capture sessionStorage, Cache Storage or service-worker state, so a site that
keeps authentication only there will not survive an idle close. Source:
`node_modules/playwright-core/types/types.d.ts`, read 2026-09-10.

Two alternatives were weighed on 2026-09-10. A plain read-at-open and
write-at-close storage-state file loses a newer login when an older context
closes last, so the implementation serializes writes per member, re-reads the
latest file and merges only that context's changes. A persistent Chrome context
per member would let Chrome own the profile directly, but it costs one browser's
fixed memory per active member and lets that member's agents share a context. The
storage-state design keeps one shared browser and one context per agent.

### 7.3 Live view and human input

Round 3, 2026-09-12: the Browser panel offers an address field, back, forward,
reload, and Close page. Opening the panel creates a blank page for the manager
when none exists. Closing the panel hides it; Close page ends the context.
An agent goto that creates a fresh page sends a manager-only notification.
Only the mounted chat responds, so a background agent cannot take over the panel.
A later action on an existing page does not undo a manual panel dismissal.

The server checks room access at subscription and at every frame delivery.
The server checks management on every browser input, including open, navigation,
and close. Other room members can watch an existing page but cannot create one.
The server sends the full address to the manager and origin plus pathname to
other viewers. The same function strips screenshot captions and viewer addresses.

Navigation runs on the per-agent action queue and uses the agent goto validator.
Pointer and keyboard input use the immediate CDP path and can interleave with an
agent action. Only manager watchers suspend the five-minute idle timer; a room
viewer cannot keep the manager's profile context alive. Watcher identity is
checked again while frames are delivered.

The current transport uses opt-in binary CDP JPEG frames over the office
WebSocket; legacy watches keep JSON. Each binary message carries its agent id
and watch generation. Sustained socket pressure lowers JPEG quality, then
scaled capture bounds; a clear buffer restores them. Capture uses the highest
demand among watchers, so one fast watcher keeps its quality while a slow
watcher drops delivered frame rate. See the dated measurement and limits in
[browser-panel-bandwidth.md](browser-panel-bandwidth.md). The panel
keeps one image decode and one replaceable waiting frame, and coalesces pointer
movement. A debounced ResizeObserver requests CSS size times device pixel ratio,
quantized to 16 pixels and bounded to 320–2560. Capture uses the largest live
watcher bound, capped by the page viewport; joins, resizes, and departures
recompute it. The canvas uses the decoded image size while input retains page
coordinates. The video evaluation and dated measurements are recorded in
[browser-panel-round-3.md](browser-panel-round-3.md). Chrome 151.0.7922.137 on
this box rejected `Page.startScreenRecording` as an unknown method on 2026-09-12,
although the current [CDP Page reference](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
lists it as experimental. No video capture flag is enabled in the office browser.

On 2026-09-12, Bun 1.3.11 acting as a Playwright CDP client timed out against a
local Chrome endpoint while Node connected. The cause is not established.
This is a constraint on a direct desktop-CDP option; an extension using
`chrome.debugger` and opening its own office connection does not use that path.
The Node measurement bridge lives under `/tmp/browser-3/` and is not shipped.

### 7.4 Per-backend permission gate, if one were wanted

For completeness, and not as a recommendation:

- Claude: `canUseTool` already runs for every tool
  (`server/backends/claude.ts:657-661`), so a browser MCP tool would surface as
  a normal permission prompt in the chat, under the agent's permission mode.
- Codex: the approval policy (`AskForApproval`) and the `PreToolUse` hook both
  see MCP actions, so a deny is available.
- OpenCode: `permission.asked` carries the tool, and the isomux adapter answers
  `once` or `reject` (`internal-docs/safety-hooks.md`).

With the isomux route there is no per-backend work: the agent calls a route, and
the route decides. The cost is that the decision is not shown as a permission
card, because it is not a backend tool call.

## 8. Cost and footprint

Measured 2026-09-05 on this box: Chrome 151.0.7922.137 driven by
`playwright-core` 1.62.1, headless, `--no-sandbox`. Each context loaded the
isomux office page (`http://localhost:4000/`), which is a heavy single-page app
and therefore an upper bound for an ordinary page. The figure is PSS across the
whole Chrome process tree, so shared pages are counted once.

| State | PSS | Processes |
| --- | --- | --- |
| browser, no context | 351 MB | 11 |
| 1 context, 1 page | 574 MB | 14 |
| 2 contexts | 735 MB | 17 |
| 3 contexts | 885 MB | 18 |
| 4 contexts | 1034 MB | 20 |
| 5 contexts | 1143 MB | 22 |
| 6 contexts | 1324 MB | 24 |
| after closing all 6 | 422 MB | 11 |

The fixed browser cost is about 350 MB and each context adds about 160-220 MB.
Closing contexts returns the memory.

So one shared browser with six contexts costs about 1.3 GB. Six separate
browsers cost about 3.4 GB, because each pays the 350 MB fixed cost again. On a
24 GB box that difference decides whether browser use is background noise or a
reason for earlyoom to kill agents.

Two notes on reading this against the existing number in the tree.
`preview-capture.ts:120-122` records 188-208 MiB for typical pages and 403 MiB
for the heaviest page on 2026-08-29. That is a different measurement: a one-shot
screenshot CLI run, measured by cgroup `memory.peak`, not a persistent browser
under Playwright. Both are correct for what they measure.

Conclusion: **one shared browser, one context per agent, idle-close the context**.

Re-measured 2026-09-10 after adding the per-member storage-state profile, with
Chrome 151.0.7922.137 and `playwright-core` 1.62.1. Each context loaded a small
local page, so these figures do not replace the heavier office-page measurements
above. No same-page run without persistence was made, so this run does not
isolate the profile's own memory cost. PSS over the Chrome process tree was 255
MB at one agent (9 processes) and 964 MB at six agents (19 processes).
The same run set an HttpOnly session cookie, closed the context, and confirmed
that a later agent of the same member read `logged-in`; an agent of another member
read `logged-out`. Log: `/tmp/browser-use/slice2-measurement.log`.

## 9. Open questions for Nil

Each answer below is implemented, and marked in the code, so reversing one is a
single revert.

1. **Shared browser or one per agent?** Recommendation: shared browser,
   per-agent context. Reason: section 8, about 2 GB saved at six agents.
2. **isomux route or MCP server?** Recommendation: isomux route. Reason: it
   works on all three backends at once (section 3), the screenshot reaches the
   chat on all three (section 6.3), and it is enforceable rather than
   `allow()`-by-default (section 7.1). The MCP route stays open: nothing here
   prevents adding `mcpServers` to `SdkSessionOptions` later.
3. **Which backends get it first?** Recommendation: all three, because the route
   costs nothing per backend.
4. **Does the browser keep cookies between turns?** Nil's 2026-09-05 ruling:
   yes. The manager's agents share one persistent storage-state profile;
   another member's agents never load it (section 7.2).
5. **Is there a permission prompt?** Recommendation: no prompt. Isomux enforces
   rules in the route handler and the agent sees a refusal, matching the
   philosophy that no human-approval gate stands in front of an agent action.
6. **Is `file://` allowed?** Recommendation: no. An agent already reads files
   with its own tools, under the safety policy. Letting the browser read them
   would route file reads around that policy.
7. **Idle timeout.** Recommendation: close an agent's context after 15 minutes of
   no browser call, and close the browser when the last context goes. Both are
   constants, not environment variables.
8. **May an agent hold more than one page at a time?** Recommendation: no. One
   page per agent is what section 8 measured, and a window the site opens
   replaces the page rather than adding to it. Raised by Isomux Reviewer 4. No
   flow that needs two live pages has been found; if one turns up, this is the
   question to reopen, not something to widen quietly.

## 10. What I could not verify

- That the Codex app-server `thread/start` `config` map accepts `mcp_servers.*`
  (section 3.2). The CLI accepts the key; the map is untested for it.
- The Claude Chrome-extension surface (section 3.1). It needs a signed-in
  desktop browser, so it cannot apply to this box either way.
- Whether an OpenCode MCP tool call raises a `permission.asked` event. The
  safety document lists tools that do not; MCP is not in either list.

## 11. The prototype, and what it proved

Two isolated runs, both 2026-09-05, both with `ISOMUX_HOME` on a temporary
directory and a port of their own, killed by PID. The office on port 4000 was
never touched.

### 11.1 Second run, against the reviewed code

Ports 41297 (office) and 36901 (demo page). This is the run against the code
after all three review rounds, and it is the one that carries the evidence.

The demo page held two text fields, a submit button, a status paragraph reading
"The form has not been sent.", and the word `marmalade` in the body. One Claude
agent in the isolated office was told to use the browser affordance and nothing
else: open the page, read its title, find the secret word, fill both fields,
click the button, read the status line again, and screenshot it.

It made seven `POST /api/agents/:id/browser` calls with its own bearer token.
Every one succeeded. The first snapshot:

```
- heading "Isomux browser demo" [level=1]
- paragraph: The form has not been sent.
- text: Item
- textbox "Item"
- text: Quantity
- textbox "Quantity"
- button "Place order"
- paragraph: The secret word on this page is marmalade.
```

The snapshot after two `fill` calls and a `click`:

```
- heading "Isomux browser demo" [level=1]
- paragraph: Received order for 3 x marmalade
- paragraph: The secret word on this page is marmalade.
```

That second snapshot is the point of the whole exercise: the agent changed the
page and read the change back. `preview-url` cannot do this.

The screenshot landed in the agent's chat as a `file-view` card captioned
`http://127.0.0.1:36901`, filename `127.0.0.1-36901.png`, 15956 bytes. The
agent then reported in its own words, unprompted and correctly, that the click
did not navigate ("the URL and title unchanged, so it updates in place"), that
the two fills cost two calls because `fill` takes one selector each, and that
its page was still open and would self-close in five minutes.

### 11.2 First run, against a109a65

Ports 4791 and 4792, before the three review rounds. Same shape with a
"Greet" button; six browser calls, all successful, screenshot card captioned
`http://127.0.0.1:4792`. Two properties were confirmed live in that run and not
re-measured in the second:

- **One shared browser.** The office process held exactly one Chrome tree, 11
  processes, 470 MB PSS while the page was open.
- **Idle close.** The agent's last call was at about 08:33 UTC and Chrome exited
  at 08:38:03 UTC with the office still running. The 5-minute idle timer closed
  the context, and the last context closed the browser.

### 11.3 What the second run found that the tests did not

The isolated office **would not stop on SIGTERM** once an agent had used the
browser. Measured: an isolated office with the browser untouched exited 2 s
after SIGTERM; one that had used it was still alive minutes later and needed
SIGKILL. On a real box `systemctl stop isomux` would wait out its timeout every
time.

The cause is not isomux code. `chromium.launch()` defaults `handleSIGINT`,
`handleSIGTERM` and `handleSIGHUP` to true, so Playwright installs its own
handlers and does not re-raise. `server/backends/opencode/supervisor.ts` already
owns those signals for this process: it runs its cleanup and then re-raises.
Playwright's handler swallowed that re-raised signal, and the process stopped.

**The fix is the three launch options, and nothing else.** Setting them false in
`launchOptions()` removes the interception, and the office answers SIGTERM
again.

A first attempt also registered a reaper in `browser-session.ts`, in the same
shape as the OpenCode supervisor's. Isomux Reviewer 4 rejected it, correctly:
two independent self-re-raising reapers do not compose. Both run on the first
signal, and whichever cleanup finishes first re-raises and terminates the
process in the middle of the other's. Measured with both modules imported,
`listenerCount` was `{SIGINT: 2, SIGTERM: 2}`. The reaper is gone; this module
installs no signal handler at all. If graceful browser shutdown is ever needed
beyond process death, it belongs in one central shutdown coordinator that also
owns OpenCode, not in a second handler.

Nothing needs it today. Chrome is a child on a remote-debugging pipe, so it
exits when the office does. The probe that proves both properties imports the
OpenCode supervisor and `browser-session` together, which is the production
shape, leaves a browser open, and raises SIGTERM on itself:

```
listeners: {"SIGINT":1,"SIGTERM":1}
chrome processes with the browser open: 1
raising SIGTERM on self
Terminated
exit=143
chrome after the process died: 0
```

One signal owner, the process terminates by SIGTERM rather than hanging, and no
Chrome is orphaned. Count Chrome by reading `/proc/*/exe`, not with `pgrep -f`:
a `pgrep -f chrome` pattern matches the cmdline of the shell running it, which
made an early run of this probe report a phantom orphan.

This is a good argument for running the demo at all. Three rounds of unit tests
found none of it, because it is a property of the process, not of the pool.

### 11.4 What the prototype still does not exercise

Two agents driving the browser at the same time. The pool gives each agent its
own context and the unit tests cover the cross-agent lifecycle race directly,
but no live two-agent run was made.

### 11.5 Live panel probe

Re-measured 2026-09-10 with Chrome 151.0.7922.137. A real `BrowserPool`
opened a local login page while a live-view listener was attached. The listener
received 19 screencast frames. CDP keyboard input entered
`boss@example.test`, the agent clicked Sign in, and the page reported
`signed in as boss@example.test`. After close, a later agent of the same member
read `signed in`; an agent of another member read `signed out`. Human input and
the agent click used the same page. Log:
`/tmp/browser-use/slice3-live-probe.log`. The panel render is captured at
`/tmp/browser-use/browser-panel.png`.

## 12. What landed in this branch

- `server/browser-session.ts` - the pool and the actions. Two serialization
  points, and the lock order between them is fixed: **the per-agent queue
  first, the office-wide lifecycle chain second.** Nothing inside the lifecycle
  chain ever takes an agent queue.
  - The per-agent queue runs one agent's work at a time, so two concurrent cold
    calls cannot each build a context and leak one, and a close cannot land
    inside an action.
  - The lifecycle chain runs one office-wide lifecycle step at a time: creating
    a context, and closing the browser when the last context goes. Per-agent
    queues are not enough, because the browser is shared. Without it, agent B
    sits inside `newContext` having already seen a connected browser while
    agent A's close removes the last session and takes that browser down; B then
    installs a session on a browser that is gone. Page actions stay concurrent
    across agents - only the shared browser's existence is serialized.
  - Slow teardown runs outside the lock. A close unlinks the browser under the
    lock and awaits the actual `close()` after releasing it, so a hung teardown
    blocks no other agent.
  - Each Playwright call carries its own timeout; the pool's backstop above it
    closes the context and waits for the losing operation before it releases the
    queue, so a timed-out call can never land inside the next action.
  - A window the site opens is adopted on the agent's own queue, and the page it
    left closes, holding one page per agent.
  - Playwright's own signal handlers are disabled, so the office still answers
    the SIGTERM that the OpenCode supervisor's reaper re-raises after an agent
    has used the browser. This module installs NO signal handler: OpenCode's
    supervisor is the single owner, and a second self-re-raising reaper would
    cut its cleanup short (section 11.3).
  - Each agent context loads the manager's storage-state profile. On
    close, a third queue serializes writes per member; the writer re-reads the
    file and merges its changes against its opening baseline. Profile capture
    has its own deadline, and a corrupt file is moved aside before the member
    starts again with an empty profile.
- `POST /api/agents/:id/browser` - route, handler, manager op, contract shapes.
- The Browser side panel - CDP screencast frames over the office WebSocket and
  direct CDP pointer and keyboard input. Room members can watch; only the manager can drive.
- `server/preview-capture.ts` - `defaultFindBrowser` exported so both features
  resolve the same executable.
- `playwright-core` 1.62.1 as a root dependency, imported lazily so an office
  where no agent opens a browser does not pay for it at boot.
- Doc surfaces: `docs/features.md`, `docs/self-hosted.md`, `api/chat.ts`,
  `AGENTS.md`, `internal-docs/safety-hooks.md`,
  `internal-docs/testing-guide.md`, `server/system-prompt.ts`, and
  `ROUTE_LABELS` in `ui/log-view/isomux-curl.ts`.
- Tests: `server/test-support/browser-session.test.ts` (43 cases, stub browser),
  the manager DI case that pins the stable user id as the profile key, and five
  REST cases in `server/test-support/routes-agent-affordances-rest.test.ts`,
  plus the live-view authorization case and Browser panel render test.

The member-visible copy is quoted verbatim in the report to the PM, for Nil to
approve or replace. It is applied in this branch so the branch is testable.
