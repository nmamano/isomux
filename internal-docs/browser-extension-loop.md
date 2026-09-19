# Chrome extension browser loop

## North star

Nil approved this project on 2026-09-19 (office date). Agents use a member's
desktop Chrome through a small Isomux extension. Playwright stays on the office
server. The member uses the real browser tab. Deliver a working installable
extension and office integration in this session, then let Nil test real sites.
The old browser is removed only after the replacement passes Nil's tests.

## RULINGS (final)

1. Slice mode in MAIN, `/home/nil/nil/isomux`. Lane 1 only. No worktree and no
   automatic lane alternation. This overrides the room worktree rule for this
   loop. Worker 1 is Astra high; Reviewer 1 is Sol high. No Claude usage.
2. One slice at a time. Worker and reviewer use the edit token and commit
   handoffs in main. PM owns formatting and deployment. Use scoped checks
   between slices; full CI is not a slice gate (RULING 16).
3. Desktop Chrome only. Edge, Firefox and mobile extensions are out of scope.
4. Extension opens an authenticated encrypted WebSocket to the office. No
   laptop daemon, inbound laptop port or SSH tunnel. Local isolated test
   servers may use loopback HTTP/WS. Remote production uses HTTPS/WSS.
5. Keep Playwright on the server. Extension handles attachment, tab ownership,
   transport and browser command dispatch. Prove debugger-protocol compatibility
   before expanding the product. No custom replacement selector engine.
6. A browser connection belongs to one office member. An agent uses its
   manager's connection. Multiple agents can operate separate tabs in one
   browser profile. They share website login/account state.
7. One main task tab per agent. Site-created temporary popups belong to that
   same agent when needed. No mid-task transfer between agents. No tab groups.
   Ending browser control detaches and leaves the page open, including music.
8. A different member speaking to an agent does not switch browser identity.
   Show whose browser is in use. Agent guidance preserves the existing rule to
   confirm before using its manager's logged-in accounts for another member.
9. Toolbar badge distinguishes disconnected, connected, and control of the
   current tab. Popup shows office, member, agent/tab assignments and disconnect.
   No standalone Browsers page in this loop. No page overlay unless necessary
   and approved by PM. No continuous video or remote Browser panel in v1.
10. Reconnect automatically. Never replay a command whose side effect may have
    happened before disconnection. Report unknown outcomes. Revocation and loss
    of ownership must stop access. Web pages cannot request browser attachment
    or acquire the bridge credential.
11. Sanity checks, not a latency benchmark project. Nil judges responsiveness
    on his actual Windows Chrome. His acceptance tasks are: add his usual oat
    milk to his Amazon cart; find his recent X posts missing from his personal
    site; play the old Portugal. The Man albums on YouTube. Do not execute
    account mutations as part of automatic verification.
12. Preserve existing headless functionality while proving the new path.
    Server-local previews need separate treatment: localhost in Chrome refers
    to the member's machine. Do not remove preview capture or old browser code
    before Nil's go after real-site testing.
13. No production restart or push without Nil's explicit current approval.
    Nil's GO authorizes local implementation, plan/code commits and slice gates.
14. Keep Codex context defaults. Record decisions here and hand off when needed.
15. Use Playwright's public `ConnectOverCDPTransport` directly with the
    authorized in-process bridge assignment. No internal agent CDP HTTP/WS
    endpoint, runtime upgrade, private Playwright patch or Node child.
    The actual extension still connects over authenticated WebSocket. PM and
    reviewer verified the public seam in pinned Playwright 1.62.1; the real
    extension gate passed on 2026-09-19. One successful real-extension sanity
    pass is sufficient; repeat only to resolve a concrete failure.
16. Nil, 2026-09-19: do not leave PM and worker idle while CI runs. This
    overrides the manager skill's full-CI-after-each-slice rule for this loop.
    Use the scoped build, type, lint and behavior gates; continue to the next
    slice after review approval. Do not launch another full CI during this
    implementation loop. Any final release gate is a separate checkpoint.
17. PM, 2026-09-19: `webNavigation` is approved for popup ownership through
    `onCreatedNavigationTarget.sourceTabId -> tabId`. Discard unrelated sources
    before retaining/transmitting event data. Revalidate generation/assignment
    after async attachment. No focus, timing or URL correlation. Document the
    Chrome permission warning `Read your browsing history`. No history capture.
18. PM, 2026-09-19: corrupt/unreadable/invalid browser selection state keeps
    office startup available but browser actions unavailable until explicit
    member selection. No silent headless fallback. An absent legacy state file
    alone receives the migration default. Preserve invalid state for diagnosis.

## Accepted defaults

- One selected browser connection per member for agent routing in v1. Binding
  an agent to a tab must not follow whichever tab happens to become active.
- Use revocable browser-specific credentials. Do not give the extension an
  agent, owner, or general remote API token. Persist hashes server-side.
- Pair through an authenticated member flow. A connection is bound to its
  office and member. Revalidate authorization and tab ownership at execution.
- Keep the existing agent browser action shape where possible. Browser selection
  is explicit; no silent headless fallback after extension disconnection.
- Expose only assigned tabs to each Playwright connection, including related
  frames/popups. Never expose all profile tabs through target discovery.
- No cookie/profile export is needed. Audit Playwright initialization for
  unnecessary profile-wide operations. Protocol events can carry sensitive
  data; do not log payloads or credentials.
- Unpacked installation is today's delivery route. Web Store publication is
  a separate step and is not required to demonstrate the product today.

## Decision protocol

Worker and reviewer settle internal module structure, protocol encoding and
test construction within these rulings. A control suggested here is a claim
to verify, not proof that it works. PM settles implementation deadlocks from
source or a small reproduction. Product/API/security changes outside this
scope go to PM before implementation. PM records rulings here between token
handoffs. Only genuine blockers go to Nil mid-loop; other decisions wait for
the consolidated report. Do not expand the scope to unrelated board tasks.

## Gates

Before each handoff, commit, then open each gate log with `git rev-parse HEAD`.
Run `bun run build:ui`, scoped `bun test <nonempty explicit file list>`,
`bunx eslint <touched supported files>` and `bunx tsc --noEmit`.
Add `bun run build:demo` if touching `ui/demo-server.ts` or
`shared/storage-labels.ts`. New extension build/test commands must be recorded
in the slice report and integrated into the appropriate project checks.
For changed HTTP routes include:
`bun test server/test-support/routes-table.test.ts server/test-support/routes-agents-manifest.test.ts`.
Verify those paths exist; resolve the manifest test's actual path if needed.
Use the render-test guide before adding or editing DOM tests.
Reviewer independently reruns the final scoped test gate and meaningful
regression mutants. Assertions target behavior, not prose. No performance
benchmarks or full CI in the worker/reviewer round. No worker prettier.

PM formats touched files after approval and commits. Full CI is not a slice
gate; see RULING 16. Runs that can grow large use a 2G memory scope. Capture
commands and results; never infer success from a wrapper.

## Slice checklist

- [x] 1. Prove Playwright through a real Chrome extension and isolated office.
  Reviewer approved `48e84ae90acd9d19f4a489260fe67b7378686937` on 2026-09-19:
  88 scoped passes, one opt-in skip; real Chrome gate 1 pass / 21 assertions.
  Evidence: `/tmp/reviewer1-extension-slice1-final-tests.log`,
  `/tmp/reviewer1-extension-slice1-live.log`,
  `/tmp/isomux-extension-proof-KwYXV1/evidence.json`.
  Production browser routes remain unchanged. PM formatting commit `6062b082`.
  PM full CI was stopped by Nil's ruling before the full suite completed;
  this is not a CI pass. Its build:ui, build:extension, ci:web, tsc,
  format:check and lint stages passed. Proceed on approved scoped gates.
- [x] 2. Complete member pairing, routing, tab ownership and recovery.
  Reviewer approved `794bcd8f82d27b40877f362877617a6b1248bf61` on 2026-09-19.
  Independent final gate: 275 pass / 2,236 assertions in 14 files,
  `/tmp/reviewer1-slice2-r3-final-tests.log`; focused persistence/routes:
  `/tmp/reviewer1-slice2-r3-focused.log`. Real-office Chrome run:
  `/tmp/worker1-slice2-r2-live.log`, 1 pass / 23 assertions at `249b660a`;
  later revisions only changed storage repair, unit tests and internal prose.
  Final worker type/build/lint evidence: `/tmp/worker1-slice2-r3-gates.log`.
  Windows/real-site acceptance remains with Nil. No full CI between slices.
- [x] 3. Complete member UI, extension UI, packaging, agent guidance and docs.
  Reviewer approved `6534ccf31c8db250aea472d086d6ba45a3f1a6a8` on 2026-09-19:
  `/tmp/reviewer1-slice3-final-tests.log`, 286 pass / 34,259 assertions.
  Worker build/type/lint: `/tmp/worker1-slice3-final3-gates.log`.
  Real downloaded-package check: `/tmp/worker1-slice3-popup-worker.log`,
  1 pass / 33 assertions at `d38719f8`; later edits only narrow test types.
  Live ZIP SHA256: `2dee6f0efce6b08fef56dfdd32853ccd7c07b16e0547fa76bfe74062560f4ba8`.
  Screenshots and sanitized evidence: `/tmp/isomux-extension-office-Lnh6q1/`.
  PM inspected settings and control-popup screenshots. Copy inventory:
  `/tmp/worker1-slice3-copy.md`. Final copy and restart await Nil.
- [ ] 4. Run end-to-end sanity checks, prepare Nil's Windows installation and
  real-site acceptance. Propose removal only after Nil's results.

## SLICE-1 PICKUP

Goal: prove the architecture with the smallest real vertical path. Read this
whole file. First send this pickup and PM brief verbatim to Reviewer 1 and
plan-gate with them. Do not ask Nil to select implementation details.

Use the existing pinned Playwright dependency first. Study its official
extension/CDP relay prior art and debugger API restrictions. Build a minimal
MV3 extension and isolated office bridge with real authenticated transport.
The isolated fixture may establish a member-bound test credential without a
finished pairing UI, but do not ship a bypass route in the production office.
Preserve the current production browser route until explicit backend routing
is implemented. Add a focused internal design/evidence doc for the long-lived
protocol and ownership model; this loop file is deleted at loop close.

Acceptance: real Chrome loads the built extension, connects to the isolated
bridge, and Playwright opens an assigned tab, reads a snapshot/text, fills and
clicks a local test page, and captures a screenshot. Demonstrate that unrelated
tabs are absent from the agent's target view. Confirm a disconnect terminates
pending work without replay. These are functional sanity checks, not latency
measurements. Do not claim Windows or real-site acceptance from a box-local run.

Decide with reviewer: smallest protocol adaptation required by Playwright;
module seams that let slice 2 add persistence and authenticated pairing; how to
exercise the actual Chrome extension automatically on this Linux box without
changing production browser state. Report a missing runtime dependency instead
of building an elaborate workaround. Use isolated profiles, bounded process
lifetimes, and never the member's stored browser profile or real logins.

Locked: no laptop daemon, no engine replacement, no groups, no production
restart, no remote browser debug port exposed to the network, no unrestricted
CDP endpoint, no speculative compatibility promises. If existing Playwright
cannot use the bridge without a substantial rewrite, stop and report the
specific failing command and alternative to PM.

Report once reviewer approves: approved hash; path; what works; exact scoped
gate commands and evidence paths; limits; every user-visible string verbatim;
any removed/replaced assertion; next slice's traps. Transfer token to PM.

## SLICE-2 PICKUP

Goal: make the proven bridge usable through the real office browser action
route, with real pairing, durable credentials and recovery. Read the whole
loop file and `internal-docs/browser-extension.md` first. Slice 1's approved
implementation is `48e84ae9`; public in-process Playwright transport is proven.
PM formatting commit `6062b082` follows it. No separate CDP HTTP endpoint is necessary.

First plan-gate the member flow, exact routes, persistent state and websocket
dispatch with Reviewer 1. Choose the smallest flow consistent with existing
authorization. Use a short-lived single-use pairing code created by the
authenticated member (or an existing authorized operator acting in that
member's scope). The extension sends the code over its office-bound WSS
connection; the server issues a browser-only credential on that connection.
The code must resist guessing and cannot be used twice. Store only credential
hashes on the server. A paired browser's credential cannot reach office routes.
No plaintext credential in URLs, logs, page content or ordinary browser storage.
Trusted extension-local storage is appropriate. Pairing is an explicit member
action, not a per-operation approval gate. UI for this flow is slice 3.

Register routes in the normal route table and websocket upgrade/dispatch path;
reuse existing host classification and authorization. App hostnames must never
reach pairing or browser sockets. Check current manager identity from the
agent record for each action; do not use the latest chat speaker. Add explicit
backend selection per member with the old headless mode as the migration
default. Selecting extension mode never silently falls back when offline.
Preserve existing action shapes and screenshot cards. Existing preview-url
stays on the server. Define extension-mode errors clearly. End control means
detach; pages remain open. Report unavoidable action-contract differences.

Implement heartbeat, bounded reconnect backoff, revocation, browser restart and
server restart recovery without command replay. A reconnect gets a fresh
generation and fresh assignments. If a browser is revoked or a manager/agent
loses reach, actively detach and reject pending work. Closing or detaching one
agent should not stop another agent's tab. Do not reset website account state.
Keep one selected connection per member; do not silently replace a live device
from another connection. Explicit re-pair/replacement revokes the old one.

Temporary popup ownership derives only from an already assigned opener, never
the active tab. Maintain one main task tab and its related popup flow; retain
the original tab for OAuth return instead of closing it. Cover same-origin and
cross-origin frames. If popup handling forces a product decision, ask PM with
the exact user-visible consequence rather than inventing a collaboration mode.

Acceptance: isolated production-shaped office routes pair an extension and
serve an agent browser action end to end. Two agents of one member can act in
separate tabs; another member and unauthorized target cannot use those tabs.
Revocation cuts the socket and control. Reconnect rejects old responses and
never replays a side effect. Popup/frame sanity proves ownership and completion
on local fixtures. Existing headless mode and preview tests pass. Use one real
extension sanity run, not a measurement or repeated-run campaign.

Decide with reviewer: module seams, route names and existing policy mappings,
pairing-code lifetime and sensible payload/deadline limits, focused tests and
mutants. Locked: all RULINGS above, flat-file state, one Bun server process,
no browser credential accepted as ordinary office auth, no new human approval
for each action, no node subprocess or runtime upgrade, no production restart.
Any authorization-policy change not expressible with the existing model comes
to PM. Extend maintained internal docs; collect eventual public copy for the
slice-3 report. New agent-facing routes also need ROUTE_LABELS entries.

Required route gates:
`bun test server/test-support/routes-table.test.ts server/test-support/routes-agents-manifest.test.ts`.
Also run touched-area auth, websocket/host-dispatch, persistence, bridge and
browser action tests, build:ui, build:extension, eslint and tsc. Use
`NODE_OPTIONS=--max-old-space-size=1600` for tsc inside the 2G scope as needed;
slice 1 proved the inherited 1GB Node heap insufficient. Commit before gates.

Report once approved: exact approved hash, path, what changed, exact gates and
evidence, member-facing consequences/limits, all visible strings verbatim,
removed/replaced assertions and slice-3 requirements. Transfer token to PM.

## SLICE-3 PICKUP

Goal: make the approved production bridge installable and usable by Nil from
Windows Chrome without developer tools. Read the whole plan and maintained
`internal-docs/browser-extension.md`. Slice 2 approved hash is `794bcd8f`.
Plan-gate with Reviewer 1, then implement in main with the edit token.

Add a Browser section to the member's existing personal settings. Show the
selected mode, paired/online state and browser owner. Select server browser or
Chrome explicitly. Generate/copy an expiring pairing code, replace a previous
pairing explicitly, and revoke it. Handle backend:null/selectionRequired by
asking for an explicit choice. Keep the flow short. No standalone Browsers page,
no per-action approvals, no tab groups and no remote streaming controls.

Finish the extension setup page/popup: office HTTPS URL, pairing-code input,
connection status, member identity, assigned agents/tabs, reconnect/disconnect
and unpair as appropriate. Accept a normal office origin and derive the socket
path internally. Reject credentials/query/fragment in connection URLs. Do not
make customers enter a WebSocket path, token or raw JSON. Store credentials only
in trusted extension storage; do not expose them to ordinary pages or logs.
Disconnect must stop reconnect until the member reconnects; revocation requires
pairing again. Add sanitized display metadata to the authenticated protocol,
derived from current server-side member/agent records, not client claims.

Chrome toolbar badge must distinguish offline, connected and control of the
current tab. Popup lists the assigned agent, can focus its owned tab, and has
a clear stop-control action that leaves the page open. A tab keeps its agent;
do not add transfers. No injected page overlay or title rewriting. Keep Chrome's
own debugger warning. Ensure normal Chrome audio playback is left alone, as
Nil's YouTube task ends with music playing after control stops.

Deliver a downloadable ZIP with manifest at its root after extraction, built
from repository sources. Serve it through the appropriate existing office auth
and host boundary, with a settings download link and version. Make the normal
UI/install/update build path also produce the extension package, so customers
never need a manual server rebuild step after updates. Check release/install
surfaces before choosing the smallest integration. No Web Store publication
or external account setup. Test packaged bytes, not just a source directory.
Do not add a third-party ZIP dependency when existing tooling suffices.

Update `server/system-prompt.ts` browser guidance and relevant documentation
surfaces. Explain browser ownership, native tab control, explicit mode choice,
offline/unknown outcomes, retained tabs/music, ignored extension viewport, and
desktop-localhost vs server preview. Existing old-profile claims must be
conditional on headless mode. Update shared API contract comments accordingly.
Add ROUTE_LABELS for any agent-facing routes and route gates for any HTTP change.
Keep public prose short; collect all customer-facing prose, rare errors and
agent instructions verbatim for Nil's sign-off. Internal docs need no copy
approval. Include the Chrome `Read your browsing history` permission warning
and its popup-binding purpose in installation guidance/report. Translate new
UI strings using the existing catalogs; report English only to PM.

Acceptance: isolated production office plus actual packaged Chrome extension
can complete the member settings -> download -> pair -> connected flow. UI
shows the correct member and agent; current-tab badge changes correctly; stop
control leaves the page, unpair ends access, offline state is accurate. Check
the settings UI and extension UI visually and preserve screenshots. Cover
ineligible-member/foreign-origin boundaries when adding metadata or routes.
Reuse slice 2 fixture rather than inventing a parallel server. No real account
mutation, Windows claims or latency benchmark. Nil judges those after deploy.

Decide with reviewer: component placement, UI composition, download route and
build integration, minimal protocol metadata. Locked: RULINGS above. Raise new
permissions, product-policy changes or missing tools to PM. No full CI, server
restart or push. Run build:ui, build:extension, scoped behavior/DOM/route tests,
touched-file eslint and tsc at the committed handoff hash. Include build:demo
if its trigger files change. Read the DOM testing guide first.

Report once approved: exact hash, path, all checks/evidence, screenshots and ZIP
location, literal public/agent copy, removed/replaced assertions, remaining
Windows installation steps and limitations. Transfer token to PM.

## SLICE-4 PICKUP

PM close-out, no additional implementation lane unless a concrete gap appears.
Slice 3's actual packaged-extension run already covers installation/pairing UI,
two agents, frame/popup use, disconnect/reconnect, stop control and unpair.
Do not repeat that successful run or create a broader performance campaign.
Format touched files, build main and package, and run focused post-format checks.
Show the reviewed screenshots and copy to Nil. Ask for the production restart
only after the reviewable package is ready. On explicit current approval,
schedule a wake-up then restart once; verify service and HTTP health. Help Nil
load the unpacked extension on Windows and pair it with this office.

Nil owns the Amazon/X/YouTube acceptance and responsiveness judgment. Browser
restart/laptop-sleep behavior has unit/lifecycle coverage but physical Windows
sleep and actual media playback are not established by local fixtures. State
those limits without treating synthetic timings as user experience evidence.
Keep the headless/preview path until Nil accepts the replacement and authorizes
removal. Do not mark the board task done before the end-to-end delivery checkpoint.
No push or Web Store publication is authorized. Remove this loop file when the
loop closes, leaving maintained design/docs and task evidence intact.


## Acceptance feedback checkpoint (2026-09-19)

Panel correction approved at `28e85f81`; background click correction approved
at `5f3d20a7`. PM owns the edit token. Worker/reviewer gates are complete;
no full CI or repeat successful live run. Package rebuild succeeded. Deploying
the panel correction still needs a new explicit restart approval. The focus
correction needs the updated unpacked extension loaded in Chrome. Nil's real
YouTube playback remains unverified.

Nil proposed offering existing tabs through a per-tab extension-popup toggle.
PM recommends an agent picker plus ON only on offered tabs; this is a proposed
change to the original agent-created-tab model, not yet implemented. Do not
claim existing tabs can be offered until that feature ships.

Nil granted standing permission on 2026-09-19 to restart the office as often as
needed for this project. This supersedes the per-restart approval checkpoint
above. Schedule the wake-up and verify service health each time. No push or
publication permission is implied.

## Per-tab opt-in pickup (2026-09-19)

Nil explicitly directed implementation. The popup offers the current HTTP(S) tab
to one selected eligible agent; one root tab per agent, no implicit transfer,
ON only on offered tabs. Agent reads work before goto; goto reuses the tab. No
automatic creation or fallback without an offered tab. Off revokes and detaches
while retaining pages. Preserve scoped popup chains and no replay. Disconnect
may release grants explicitly; no silent restoration or creation. Narrow
activeTab permission is approved if needed; no broad permission expansion.
Worker/reviewer settle implementation and scoped protocol details; real new
policy choices go to PM. Worker owns all existing PM feedback edits for
integration, preserving the settings improvements and icon. Nil granted PM
standing restart permission. No push or publication authorized.


Implementation of the approved per-tab contract uses protocol 2 / extension 0.2.0.
The generation-bound offer reserves the selected agent and exact local tab before
attach. Off cancels pending or active ownership; reconnect and reload require a
new offer. The packaged office sanity fixture uses raw Chrome without Playwright
launch defaults and checks the existing page before goto, same-target navigation,
a trusted background click with a screenshot, conflicts, and retained-page Off.
