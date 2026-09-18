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
   handoffs in main. PM owns between-slice formatting, full CI and deployment.
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

PM formats after approval with `bun run format`, commits, and runs full
`bun run ci` in a detached systemd unit with MemoryMax=10G and an explicit
exit line. No tree edits during CI. Other runs that can grow large use a 2G
memory scope. Capture commands and results; never infer success from a wrapper.

## Slice checklist

- [ ] 1. Prove Playwright through a real Chrome extension and isolated office.
- [ ] 2. Complete member pairing, routing, tab ownership and recovery.
- [ ] 3. Complete member UI, extension UI, packaging, agent guidance and docs.
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

Pending slice 1 evidence. Complete production pairing, revocation, member and
agent routing, tab ownership, popups and recovery. Prove cross-member and
cross-agent refusal at the real authorization boundary.

## SLICE-3 PICKUP

Pending slice 2 evidence. Finish extension/member UI and installation package.
Update relevant surfaces from internal-docs/documentation.md. Collect all
customer-facing and agent-facing prose for Nil's final sign-off.

## SLICE-4 PICKUP

Pending slice 3 evidence. Sanity-check installation, reconnect and two-agent
use; prepare deployment/restart checkpoint and Windows installation for Nil.
The live-site tests belong to Nil. Leave removal behind that acceptance gate.
