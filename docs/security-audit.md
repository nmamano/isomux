# Isomux authorization-system security audit

## Preface

This audit was performed in collaboration by an **Anthropic Claude Opus 4.7 (Max-effort) agent** and an **OpenAI GPT-5.5 (xhigh-thinking) agent**. The Opus agent drove the review: read the auth-relevant modules, framed the threat model, drafted the findings, implemented the agreed hardening, and authored this document. The GPT-5.5 agent acted as an independent reviewer: scrutinized scope and findings, calibrated severities, fact-checked claims, reviewed the code changes before commit, and signed off on the final wording. Both agents are Large-Language-Model-based and operate as conversational coding agents inside the Isomux office they audited; their interaction was via the office's inter-agent messaging API. The work was directed by Isomux's primary author (Nil Mamano).

**Date:** 2026-05-17.
**Scope:** External-access risk — can a party who was **not** intentionally given an invite URL gain access to the office? Specifically: forge a session/invite, intercept a legitimate token, exploit a CSRF/CSWSH gap to ride an authenticated user's session, or escalate from same-host non-operator context. What an invited member can do **inside** the office is out of primary scope; an earlier broader pass identified several internal authorization gaps and they are preserved in **Appendix C** for future reference.
**Out of scope:** What invited members can do once inside the office; OS-level isolation between members; agent-runtime safety hooks; denial-of-service; supply-chain.
**Methodology:** Static code review of the auth-related modules (Appendix A). Implementation cross-checked against `docs/access-and-invites.md`. Findings were independently reviewed and the agreed hardening (Section 6) was implemented in the same pass before publication.

---

## 1. TL;DR — is Isomux safe?

**For the documented threat model — an external attacker who was not given an invite — yes, Isomux's authorization system is sound.** Token forgery is infeasible (256-bit random tokens, SHA-256-hashed on disk, constant-time comparison); cross-origin attacks are closed (strict Origin allowlist built from operator config rather than request headers, `HttpOnly`+`SameSite=Lax`+`Secure`-on-HTTPS cookies, strict cookie+Origin gating on the WebSocket upgrade and on every state-changing HTTP method); and the bootstrap path that creates the first owner self-disables once an owner exists and cannot be re-opened by a remote attacker.

The residual external-access risk concentrates around **invite-URL handling**: an invite URL is a bearer token, and it appears in places the original recipient does not fully control (the recipient's browser history, the delivery channel, the systemd journal during the very first server boot). The implementation now caps invite TTLs at 24 hours for owner-issued invites and 1 hour for self-device invites, sets `Referrer-Policy: no-referrer` on the invite-accept page to close the Referer-leak path, and documents the bootstrap-journal exposure as a high-stakes window in the office lifecycle.

A separate **shared-device** risk applies to anyone who opens Isomux on a computer they don't control: the session cookie persists for up to 1 year, and the next user of the browser has full access if the invited user forgot to sign out. The mitigation is per-device revocation from the Access pane, which propagates within ~1 second over the active WebSocket.

**This audit does not cover what an authenticated member can do once inside the office.** An earlier pass found several internal authorization gaps (cronjobs and file attachments accessible across rooms, uploaded HTML executing in the same origin, etc.) — those are preserved in Appendix C as a forward-looking inventory but are explicitly out of the primary scope of this document. If your trust model treats every invited user as equally privileged for everything in the office (the current documented model in `docs/access-and-invites.md`), the answer to "is Isomux safe?" is the TL;DR above. If your trust model relies on the room ACL to keep members separated, read Appendix C first.

---

## 2. Findings (ranked)

| # | Severity | Title | Status |
|---|---|---|---|
| 1 | **Medium** | Bootstrap invite token is printed to stdout/systemd journal during the bootstrap window | **Documented; alternative delivery path remains a follow-up** |
| 2 | **Low** | Invite URLs are bearer tokens — they live in the recipient's browser history and delivery channel until consumed | **Mitigated** (24h owner / 1h self TTL; `Referrer-Policy: no-referrer`; one-time use) |
| 3 | **Low** | Session cookie persists 30d rolling / 365d absolute — a forgotten session on a shared device remains valid | **Documented; per-device revoke is the mitigation** |
| 4 | **Informational** | `GET /i/<token>` distinguishes `not_found` / `consumed` / `expired` in the response | **Not actionable** (256-bit entropy) |

The original audit pass also flagged **missing HSTS** and **invite-URL referrer leakage** as separate findings; both were closed by hardening landed during this audit (Section 6).

---

## 3. Threat model

### 3.1 Attacker capabilities (in scope)

- No valid session cookie.
- No valid invite URL — the attacker may try to acquire one through leakage.
- Standard internet-attacker primitives: control of a malicious domain the victim can be lured to; ability to send phishing links; ability to MITM unencrypted traffic on the network path; ability to read any data the victim's browser auto-attaches to a top-level navigation.
- (Conditional) Read access to the isomux process's stdout / systemd user journal during the bootstrap window. Strictly narrower than generic shell access: another Linux user usually cannot read another user's `--user` journal unless permissions have been broadened (e.g. a logging sidecar, a centralized log shipper, group-readable journal directories).
- (Conditional) Access to a device the invited user has used (shared computer, family device, cloud-synced browser history, recovered backup). Relevant for invite-URL retention and for the shared-device cookie persistence.

### 3.2 Attacker goals (in scope)

- Forge a session cookie or an invite token.
- Intercept or recover a legitimate cookie or invite token.
- Cause an authenticated victim's browser to act on the attacker's behalf (CSRF/CSWSH).
- Bypass the Origin allowlist via Host-header spoofing, DNS rebinding, or origin confusion.
- Escalate from the bootstrap path (no owner exists) to claim ownership.

### 3.3 Out of scope per the redirect

- An authenticated member intentionally or accidentally elevating their privileges, reading other members' data, or mutating shared state in ways the room ACL was expected to prevent. Preserved in **Appendix C**.
- An authenticated member uploading malicious content that another member opens (cross-member XSS). Preserved in Appendix C.
- A same-host process running as the isomux Linux user impersonating an agent. Preserved in Appendix C.

---

## 4. Detailed findings

### Finding 1 — Bootstrap invite token is printed to stdout/systemd journal during the bootstrap window

**Severity:** Medium.

**Description.** On first boot with no owner, the server writes the bootstrap invite URL — containing the raw, unconsumed one-time bearer token — to stdout. Under systemd this lands in the user journal. Anyone with `journalctl --user -u isomux` read access during the bootstrap window (default 24 hours; `server/auth.ts:344`) can open the URL, choose any display name, and become the office owner. The bootstrap path self-disables once an owner exists (`server/auth.ts:351`), so the window is narrow but high-stakes: any party who claims ownership during it controls every future invite, can revoke any session, and can edit office-wide settings.

On a single-user box this is the operator only. On a shared dev box, a container with a logging sidecar, or a hosted environment with broader log access, the audience is larger than the deploying operator.

**Affected files & lines.**

- `server/index.ts:3001-3017` — bootstrap URL logged via `console.log`.
- `server/auth.ts:347-393` — `ensureBootstrapInvite`. TTL hardcoded at 24h.
- `server/index.ts:2988-2989` — `--regenerate-bootstrap` re-opens the window if the operator restarts the server with the flag while no owner exists.

**Exploit preconditions.**

- The box has no owner yet (fresh install, or `--regenerate-bootstrap` was just run).
- The attacker has read access to either the process's stdout or the systemd user journal.

**Impact.** Full ownership of the office.

**Mitigation in place.** This audit added an explicit "Bootstrap-window exposure" section to `docs/access-and-invites.md` calling out the journal-access trust boundary. The bootstrap path self-disables once any owner exists, so the window is bounded to the first boot.

**Remaining follow-up.** An alternative delivery path (e.g. `ISOMUX_BOOTSTRAP_TOKEN_FILE=/path` → write the URL to that file with mode 0600 instead of logging) would close the residual exposure for deployments where journal access is broader than the deploying operator. Not implemented in this audit pass; left as a documented follow-up.

---

### Finding 2 — Invite URLs are bearer tokens — they live in the recipient's browser history and delivery channel until consumed

**Severity:** Low (after the hardening landed in this audit; was Medium before).

**Description.** An invite URL contains a 256-bit token and grants the role/identity the invite was minted for. The token has 256 bits of entropy and is SHA-256-hashed on disk (forgery is infeasible), but the *raw* URL appears in several recoverable places between minting and acceptance:

1. **Browser history.** Every browser that opens the URL retains the full path including the token. Cloud-synced browsers (Chrome Sync, Edge Sync, Firefox Sync) replicate the URL across signed-in devices.
2. **The delivery channel** — whatever email, chat, or SMS the operator used to send the link.
3. **(Closed by this audit.) The Referer header on outbound navigations from the accept page.** The audit added `Referrer-Policy: no-referrer` to the `/i/<token>` response and the SPA shell, so the token is not leaked to any link the recipient clicks while the invite page is loaded.

**Mitigations in place after this audit.**

- **Tight TTL.** Owner-issued invite links expire 24 hours after issuing (`INVITE_TTL_MS` in `server/auth.ts`). Self-device invite links expire 1 hour after issuing (`SELF_INVITE_TTL_MS`). Neither TTL is configurable — the previous configurable-up-to-1-year knob was removed in this audit pass.
- **`Referrer-Policy: no-referrer`** on `/i/<token>`, the accept page, the SPA shell, and all auth pages. See `server/auth-middleware.ts:securityHeaders()`.
- **One-time use.** Once the legitimate recipient clicks accept, the invite is permanently consumed (`server/auth.ts:712-721`). Any subsequent leak is inert.
- **Mutex-serialized acceptance.** Two concurrent clicks on the same URL cannot both succeed (`server/auth.ts:95-100`); whichever runs second sees `consumed=true` and is rejected.

**Residual risk.** Anything that obtains the URL before the recipient clicks — primarily someone with access to the recipient's browser history during the 24h (or 1h) window, or anyone who compromises the delivery channel during that same window — can claim the invite first. The legitimate recipient sees a 410 Gone page on their later attempt.

**Affected files & lines.**

- `server/auth.ts:441-450` — `INVITE_TTL_MS` and `SELF_INVITE_TTL_MS` constants.
- `server/auth-middleware.ts` — `securityHeaders()` helper, spread into every HTML response.
- `server/auth.ts:712-721` — one-time consumption.

**Operator guidance.** Send invites over channels you trust, and ask invitees to click promptly. The TTL is short enough that a leaked link generally expires before a casual leaker (a shared device's next user, a forgotten-to-log-out chat archive) can act on it.

---

### Finding 3 — Session cookie persists 30d rolling / 365d absolute — a forgotten session on a shared device remains valid

**Severity:** Low (the lifetime is a deliberate product choice).

**Description.** After acceptance, the session cookie persists for 30 days of rolling activity with a 1-year absolute cap (`server/auth.ts:712-723`). There is no client-side idle timeout. A member who opens isomux on a shared device (kiosk, family computer, work laptop they later return to IT, library terminal) and forgets to sign out leaves an authenticated session viable for up to 1 year. The next user of the device — who may not be an intended invitee — has full access in the original user's role and identity without ever needing the invite URL or the cookie value.

The cookie's `SameSite=Lax`, `HttpOnly`, `Secure`-on-HTTPS, and host-only attributes (`server/auth.ts:1328-1346`) defend against every cross-site attack; they do not defend against the next user of the same physical browser.

**Affected files & lines.**

- `server/auth.ts:712-723` — `rollingTtlMs = 30 days`, `absoluteTtlMs = 365 days`.

**Mitigation in place.**

- **Per-device revocation.** The Access pane lists every active session with its device user-agent, last-seen timestamp, and an 8-character device prefix. A member who realizes they left a session open on a shared device can revoke it from any other authenticated device. Revocation propagates over the active WebSocket within ~1 second (`server/auth.ts:327-339`: send `session_expired` then close), so the revoked browser tab lands on the login page rather than continuing to run.
- **Lockout prevention.** Revoking the office's last active owner session is refused server-side (`server/auth.ts:1146-1184`), so an operator cannot accidentally lock the office out of in-browser recovery while trying to clean up sessions.

**Operator guidance.** Do not stay signed in on devices you don't control. Use private/incognito windows on shared computers, or revoke from the Access pane after the fact. The audit recommends a Section 7.2 hardening (shorter rolling TTL operator override, optional idle timeout) for deployments where shared-device use is common.

---

### Finding 4 — `GET /i/<token>` distinguishes `not_found` / `consumed` / `expired` in the response

**Severity:** Informational.

**Description.** `peekInvite` (`server/auth.ts:546-563`) returns one of three distinct errors — `not_found`, `consumed`, `expired` — and the HTTP handler `renderInviteError` renders a different message for each. An attacker who somehow obtained a *partial* token (e.g. the 8-character display prefix from a log entry) could in principle distinguish "this prefix maps to a real token that's been used" from "this prefix doesn't map to anything." With 256 bits of token entropy this is not an actionable brute-force channel.

**Recommendation (optional).** Collapse all three error codes into a single "This invite is no longer valid" response. The legitimate user loses a small UX nicety (they don't learn whether their invite specifically expired vs was already consumed); the response carries no signal about the token's lifecycle state. Not implemented in this audit pass.

---

## 5. Verified controls (external-access scope)

These are observed-and-confirmed-correct implementation details that defend against the in-scope threats:

### 5.1 Token entropy
Both invite tokens and session ids are 32 bytes (256 bits) of `randomBytes`, base64url-encoded (`server/auth.ts:273-278`). Forgery by brute force is infeasible.

### 5.2 Hash-only on-disk storage
Only `sha256(rawToken)` and an 8-character display prefix are persisted (`server/auth.ts:55-82`). A read of `~/.isomux/invites.json` or `~/.isomux/sessions.json` does not yield usable bearer tokens.

### 5.3 Constant-time comparison
`safeHashEq` (`server/auth.ts:287-290`) compares hex strings via `timingSafeEqual` after a length check, used on every invite peek, accept, and session validate.

### 5.4 Mutex-serialized state mutations
A single in-process promise chain (`server/auth.ts:95-100`) serializes every mutation. Two concurrent attempts to consume the same invite cannot both succeed.

### 5.5 Fail-closed persist ordering
Invite acceptance persists the invite-consumed flag **before** the session (`server/auth.ts:705-721`). A mid-flow disk failure leaves the invite consumed without a session, the safer failure mode.

### 5.6 Cookie attribute set
`setCookieHeader` (`server/auth.ts:1328-1346`) emits `HttpOnly; Path=/; SameSite=Lax`, with `Secure` when the resolved public origin is HTTPS, and no `Domain` attribute (host-only).

### 5.7 Origin allowlist construction
`buildPublicOrigin` (`server/auth.ts:1301-1323`) resolves precedence env → office-config → localhost. The server **never** infers the origin from `Host` or `X-Forwarded-Host` headers, defeating DNS rebinding and Host-header confusion. Malformed values are logged and ignored rather than poisoning the allowlist.

### 5.8 WebSocket upgrade gating
`/ws` (`server/index.ts:2209-2223`) requires both a valid cookie **and** an Origin header matching the resolved public origin. No loopback bypass on `/ws`. A cross-origin website cannot upgrade to the office WebSocket.

### 5.9 State-changing HTTP Origin gate
`authenticate()` (`server/auth-middleware.ts`) rejects mismatched Origin on POST/PUT/PATCH/DELETE. Modern browsers attach Origin to fetch/XHR and to cross-site POST navigations, and `SameSite=Lax` independently strips credentials from cross-site non-top-level requests. Either defense alone suffices.

### 5.10 Pre-auth POST Origin gate
`POST /auth/accept` and `POST /auth/logout` use `originValidForAuthPost` — Origin must be present **and** matching. An attacker cannot trigger invite-accept or logout on the victim's behalf via a credentialed fetch.

### 5.11 Bootstrap self-disable
`ensureBootstrapInvite` returns null when an owner already exists. `--regenerate-bootstrap` only acts while no owner exists.

### 5.12 Atomic disk writes
`persistInvites` and `persistSessions` use temp-file-plus-rename. A crash mid-write cannot leave the on-disk state inconsistent.

### 5.13 Notify-then-close revoke contract
`forceExpireSocketsForSession` (`server/auth.ts:327-339`) sends `{type: "session_expired"}` *before* closing the socket. A revoked tab lands on the login page within ~1 second rather than looping reconnect against a 401.

### 5.14 Per-message session recheck
WS messages re-validate via `revalidateByHash`. Revocation takes effect on the next message without a reconnect; orphaned sessions are evicted on the spot.

### 5.15 Wire-trust override
The command dispatcher uses `session.username` server-side rather than trusting `cmd.username` (`server/index.ts:636-638`). A captured cookie cannot be used to spoof a different user's display name on chat messages.

### 5.16 Security headers on every HTML surface
`Referrer-Policy: no-referrer` on every HTML response (`server/auth-middleware.ts:securityHeaders()`); `Strict-Transport-Security: max-age=31536000` added when the resolved public origin is HTTPS. `includeSubDomains` deliberately not set — the operator may not own siblings of the office origin (Tailscale Funnel, Cloudflare, Caddy under various parent domains); operators wanting subdomain-wide HSTS can layer it at their reverse proxy.

### 5.17 Bootstrap-URL-not-recoverable
Raw tokens never persist (Section 5.2). Once the bootstrap URL has scrolled off stdout/journal retention, no on-disk path recovers it.

---

## 6. Hardening landed during this audit

These are the changes implemented in the same pass that produced this document, in response to the initial findings. All four are in main as of the commit that introduced this file.

1. **Invite TTL fixed at 24h for owner-issued invites, 1h for self-device invites; the previous configurable-up-to-1-year knob removed.**
   - `INVITE_TTL_MS` and `SELF_INVITE_TTL_MS` constants in `server/auth.ts`.
   - `ttlSeconds` removed from `MintOptions`, the `mint_invite` wire shape (`shared/types.ts`), the WS handler (`server/index.ts`), and the `IssueInviteForm` UI (`ui/components/AccessPane.tsx`).
   - Closes the "owner-issued invite is a 1-year bearer credential" sub-finding from the original audit.

2. **`Referrer-Policy: no-referrer` on every HTML response.**
   - `securityHeaders()` helper in `server/auth-middleware.ts`. Spread into every `Response` from the auth pages, the invite-error page, the redirect on accept/logout, and the SPA shell (`serveIndexHtml` in `server/index.ts`).
   - Closes the "future outbound link from accept page leaks token via Referer" sub-finding.

3. **`Strict-Transport-Security: max-age=31536000` on HTML responses when origin is HTTPS.**
   - Same helper. `includeSubDomains` deliberately omitted (see Section 5.16).
   - Closes the previous "missing HSTS" finding.

4. **Bootstrap-window exposure documented in `docs/access-and-invites.md`.**
   - New section before "Operating notes" explicitly states that journal read access during the bootstrap window equals office ownership, and describes the recommended boot-and-claim-immediately flow.

The session absolute cap was also raised from 90 days to 1 year (`absoluteTtlMs` in `server/auth.ts`) as a separate product decision; the corresponding shared-device risk is documented in Finding 3 with per-device revocation as the mitigation.

---

## 7. CSRF / CSWSH analysis

### 7.1 WebSocket upgrade
`/ws` rejects missing or mismatched Origin and missing/invalid cookie. No loopback bypass. **Verdict: safe.**

### 7.2 State-changing HTTP
Non-safe methods reject mismatched Origin. Missing Origin is accepted (for loopback curl from same-host agents), but modern browsers attach Origin to fetch/XHR and generally to cross-site POST navigations, and `SameSite=Lax` independently strips credentials from cross-site non-top-level requests. The two defenses are independent. **Verdict: safe.**

### 7.3 Pre-auth POSTs
`POST /auth/accept` and `POST /auth/logout` require Origin present **and** matching. **Verdict: safe.**

### 7.4 CORS wildcard on `/tasks` and `/cronjobs`
Both endpoints return `Access-Control-Allow-Origin: *`. With `credentials: include` the browser may still attach the cookie to the request, but it will not expose the response body to JavaScript because a wildcard ACAO lacks `Access-Control-Allow-Credentials: true`. For state-changing routes the Origin gate independently rejects mismatched origins before any response is generated. **Verdict: surprising but not a bypass.** Optional cleanup: replace `*` with the resolved public origin.

### 7.5 DNS rebinding
Cookie is host-only (no `Domain`). Origin allowlist is operator-configured, not header-inferred. An attacker domain that briefly resolves to the office IP still produces an Origin header equal to the attacker's domain — the allowlist check fails. **Verdict: safe.**

### 7.6 HTTP-host-header confusion
Public origin is never inferred from `Host` or `X-Forwarded-Host` (Section 5.7). **Verdict: safe.**

---

## 8. Cross-cutting observations

### 8.1 No rate limiting on `/i/<token>` or `/auth/accept`
Neither endpoint has rate limiting. With 256-bit token entropy this is not an actionable brute-force surface for full tokens. A global rate limit (e.g. 10 invite-peek requests per IP per minute, 5 accept attempts per IP per minute) would be cheap insurance and would surface attacker scanning in the access log. Not implemented in this audit pass.

### 8.2 The localhost fallback is plaintext
When neither `ISOMUX_PUBLIC_ORIGIN` nor `office-config.json.publicOrigin` is set, the resolved origin is `http://localhost:${PORT}` and cookies are issued without `Secure`. The documentation states the localhost fallback is appropriate only for single-user laptop setups, but the implementation does not enforce that — a deployment that's accidentally bound to a non-loopback interface while still on the localhost fallback issues plaintext cookies that any LAN attacker can capture. Hardening recommendation: refuse to bind to a non-loopback interface when in localhost-fallback mode, or at least log a strong warning.

### 8.3 Log hygiene
Raw tokens are never logged outside the documented bootstrap path (Finding 1). `safePrefix` (`server/auth.ts:1382-1384`) is used for the few diagnostic log lines that need to reference an invite/session. No additional token leakage was found in error paths or `console.error` calls.

### 8.4 Cookie revocation latency
A revoked session is force-closed within ~1 second on any active WebSocket (per-message recheck + notify-then-close). For an HTTP-only attacker (no WebSocket) the next HTTP request returns 401 immediately. Revocation is effectively synchronous from the legitimate user's perspective.

---

## Appendix A — Files reviewed

Primary auth modules:

- `server/auth.ts`
- `server/auth-middleware.ts`
- `server/users.ts`
- `server/index.ts` (auth-relevant slices: WS upgrade, command dispatch, `/auth` routes, `/tasks`, `/cronjobs`, `/agents/:id/*`, `/api/upload`, `/api/files`)
- `server/cronjob-manager.ts` (auth-relevant slices)
- `server/mime-types.ts`
- `shared/identity.ts`, `shared/public-origin.ts`, `shared/types.ts`

Reference document: `docs/access-and-invites.md`.

---

## Appendix B — Methodology

- **Static code review.** No dynamic testing, no exploit PoCs executed against a live instance.
- **Threat model construction.** Built from `docs/access-and-invites.md` and module-level comments in `server/auth.ts`. Narrowed during the audit to focus exclusively on external (non-invited) access risk per the project's primary use case (small-team self-hosted offices where every invited user is trusted equally).
- **Findings prioritization.** Severity reflects exploit preconditions, blast radius, and the gap between current behavior and the documented intent.
- **Pair review.** Produced by a pair-programming workflow with two LLM-based coding agents (Anthropic Claude Opus 4.7 Max-effort + OpenAI GPT-5.5 xhigh-thinking) acting in driver/reviewer roles. Findings, severities, and final wording were independently scrutinized. The hardening landed in Section 6 was implemented and reviewed in the same pass.

---

## Appendix C — Internal authorization gaps (out of primary scope)

The audit's initial pass surfaced a class of **post-acceptance** authorization gaps: an authenticated member with access to a single room can, in the current implementation, read and mutate resources belonging to members of other rooms (cronjobs, file attachments, tasks), and uploaded HTML can execute in the office's same-origin context. Per the audit's primary scope (external-access risk only), these are not the focus of this document and are framed as a forward-looking inventory rather than active findings. Isomux's current documented trust model (`docs/access-and-invites.md`, "What this is not") explicitly treats every invited user as equally privileged for everything in the office; the items below become real findings only if that trust model is tightened.

### C.1 Cronjobs and cronjob run transcripts are office-wide-readable and globally mutable

- `server/index.ts:2887-2894` — every WebSocket open broadcasts the full cronjob list to the connecting session.
- `server/index.ts:1488-1637` — `add_cronjob`, `update_cronjob`, `delete_cronjob`, `run_cronjob_now`, `update_cronjobs_prompt`, `list_cronjob_runs`, `list_all_cronjob_runs`, `load_cronjob_run`, `send_cronjob_run_message`, `edit_cronjob_run_message` — none verify the calling session owns the cronjob.
- `server/index.ts:2296-2348` — HTTP `GET /cronjobs/*` is loopback-bypassable and unscoped.
- The `userId`/`username` fields are stored on each cronjob but no policy currently consumes them.

**If tightening is desired:** decide per-user vs office-wide-read + owner-only-write; gate the WS commands and HTTP routes accordingly.

### C.2 File serving and uploads bypass the room/agent ACL

- `server/index.ts:2733-2806` — `POST /api/upload/:agentId` checks the agent exists but does not check `agentVisibleForSession`.
- `server/index.ts:2808-2829` — `GET /api/files/:agentId/:filename` and `GET /api/images/:agentId/:filename` do not check visibility.
- `saveFile` (`server/persistence.ts`) preserves sanitized original filenames with numeric suffixes on collision, so common filenames are guessable.
- A member who previously had access to a room retains the ability to fetch any files whose URLs they remembered.

**If tightening is desired:** gate both routes with `agentVisibleForSession`.

### C.3 Uploaded HTML executes as same-origin active content

- `server/mime-types.ts:7-21` maps `html`/`css`/`xml`/`json` to their renderable MIME types; the comment at lines 2-5 acknowledges nosniff is absent.
- `server/index.ts:2823-2828` — `/api/files/...` is served at the office's own origin with the declared MIME type.
- Combined with C.2, any authenticated member can upload `payload.html` into any agent and deliver the URL to a victim; opening it in the victim's browser (top-level navigation under `SameSite=Lax` attaches the cookie) yields stored XSS in the office's origin with full WebSocket-command capability.

**If tightening is desired:** demote active-content extensions (`html`/`htm`/`xml`/`xhtml`/`svg`/`css`/`js`) on `/api/files` to `application/octet-stream` with `Content-Disposition: attachment`; add `X-Content-Type-Options: nosniff`; consider serving attachments from a separate origin.

### C.4 Loopback agent-API trusts any same-host process as an agent

- `server/index.ts:2548-2729` — `POST /agents/:id/diff|edit-file|read-file|terminal-command|message` are loopback-bypassable; the handlers validate `senderAgentId` exists but do not authenticate that the calling process *is* that agent.
- A same-host process can post messages and surface UI cards purporting to come from any other agent.

**Status:** documented in `docs/access-and-invites.md` as "Not protection against rogue agents." Tightening requires per-agent auth tokens on `/agents/:id/*` calls.

### C.5 HTTP `POST /tasks` accepts client-controlled attribution

- `server/index.ts:2403-2441` — HTTP `POST /tasks` trusts `body.createdBy` and `body.username`; the WS path uses `session.username`.

**If tightening is desired:** force `createdBy = session.username` on the authenticated browser path; keep body-driven attribution for the loopback path.

### C.6 Room creation/close/rename gates use only room-visibility

- `server/index.ts:1366-1460` — `create_room` is unrestricted; `close_room` and `rename_room` gate on `roomAllowedForSession` only.

**If tightening is desired:** decide ownership semantics for rooms — closing/renaming requires creator-or-owner.

---

*End of report.*
