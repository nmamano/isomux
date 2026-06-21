---
navTitle: Security audit
---

# Isomux authorization-system security audit

## Preface

This audit was performed in collaboration by an **Anthropic Claude Opus 4.7 (Max-effort) agent** and an **OpenAI GPT-5.5 (xhigh-thinking) agent**. The Opus agent drove the review: read the auth-relevant modules, framed the threat model, drafted the findings, and authored this document. The GPT-5.5 agent acted as an independent reviewer: scrutinized scope and findings, calibrated severities, fact-checked claims, and signed off on the final wording. Both agents are Large-Language-Model-based and operate as conversational coding agents inside the Isomux office they audited; their interaction was via the office's inter-agent messaging API. The work was directed by Isomux's primary author (Nil Mamano).

**Date:** 2026-05-17.
**Scope:** External-access risk — can a party who was **not** intentionally given an invite URL gain access to the office? Specifically: forge a session/invite, intercept a legitimate token, exploit a CSRF/CSWSH gap to ride an authenticated user's session, or escalate from same-host non-operator context. What an invited member can do **inside** the office is out of primary scope; several internal authorization gaps are surfaced separately in **Appendix C** for future reference.
**Out of scope:** What invited members can do once inside the office; OS-level isolation between members; agent-runtime safety hooks; denial-of-service; supply-chain.
**Methodology:** Static code review of the auth-related modules (Appendix A). Implementation cross-checked against `docs/access-and-invites.md`. Findings were independently reviewed.

---

## 1. TL;DR — is Isomux safe?

**For the documented threat model — an external attacker who was not given an invite — yes, Isomux's authorization system is sound.** Token forgery is infeasible (256-bit random tokens, SHA-256-hashed on disk, constant-time comparison); cross-origin attacks are closed (strict Origin allowlist built from operator config rather than request headers, `HttpOnly`+`SameSite=Lax`+`Secure`-on-HTTPS cookies, strict cookie+Origin gating on the WebSocket upgrade and on every state-changing HTTP method); and the first-owner claim surface is served on the loopback interface and self-disables once an owner exists, so a remote attacker cannot reach it or re-open it.

The residual external-access risk concentrates around **invite-URL handling**: an invite URL is a bearer token, and it appears in places the original recipient does not fully control (the recipient's browser history, the delivery channel). Invite TTLs are capped at 24 hours for owner-issued invites and 1 hour for self-device invites; `Referrer-Policy: no-referrer` is set on the invite-accept page so the token cannot leak via the Referer header; and the first-owner claim flow is served on the loopback interface.

A separate **shared-device** risk applies to anyone who opens Isomux on a computer they don't control: the session cookie persists for up to 1 year, and the next user of the browser has full access if the invited user forgot to sign out. The mitigation is per-device revocation from the Access pane, which propagates within ~1 second over the active WebSocket.

**This audit does not cover what an authenticated member can do once inside the office.** Several internal authorization gaps (cronjobs and file attachments accessible across rooms, uploaded HTML executing in the same origin, etc.) are surfaced in Appendix C as a forward-looking inventory but are explicitly out of the primary scope of this document. If your trust model treats every invited user as equally privileged for everything in the office (the documented model in `docs/access-and-invites.md`), the answer to "is Isomux safe?" is the TL;DR above. If your trust model relies on the room ACL to keep members separated, read Appendix C first.

---

## 2. Findings (ranked)

| #   | Severity          | Title                                                                                                            | Status                                                                                |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | **Low**           | Invite URLs are bearer tokens — they live in the recipient's browser history and delivery channel until consumed | **Mitigated** (24h owner / 1h self TTL; `Referrer-Policy: no-referrer`; one-time use) |
| 2   | **Low**           | Session cookie persists 30d rolling / 365d absolute — a forgotten session on a shared device remains valid       | **Documented; per-device revoke is the mitigation**                                   |
| 3   | **Informational** | `GET /i/<token>` distinguishes `not_found` / `consumed` / `expired` in the response                              | **Not actionable** (256-bit entropy)                                                  |

---

## 3. Threat model

### 3.1 Attacker capabilities (in scope)

- No valid session cookie.
- No valid invite URL — the attacker may try to acquire one through leakage.
- Standard internet-attacker primitives: control of a malicious domain the victim can be lured to; ability to send phishing links; ability to MITM unencrypted traffic on the network path; ability to read any data the victim's browser auto-attaches to a top-level navigation.
- (Conditional) Access to a device the invited user has used (shared computer, family device, cloud-synced browser history, recovered backup). Relevant for invite-URL retention and for the shared-device cookie persistence.

### 3.2 Attacker goals (in scope)

- Forge a session cookie or an invite token.
- Intercept or recover a legitimate cookie or invite token.
- Cause an authenticated victim's browser to act on the attacker's behalf (CSRF/CSWSH).
- Bypass the Origin allowlist via Host-header spoofing, DNS rebinding, or origin confusion.
- Reach the first-owner claim surface (active only while no owner exists) and claim ownership.

### 3.3 Out of scope per the redirect

- An authenticated member intentionally or accidentally elevating their privileges, reading other members' data, or mutating shared state in ways the room ACL was expected to prevent. Preserved in **Appendix C**.
- An authenticated member uploading malicious content that another member opens (cross-member XSS). Preserved in Appendix C.
- A same-host process running as the isomux Linux user impersonating an agent. Preserved in Appendix C.

---

## 4. Detailed findings

### Finding 1 — Invite URLs are bearer tokens — they live in the recipient's browser history and delivery channel until consumed

**Severity:** Low.

**Description.** An invite URL contains a 256-bit token and grants the role/identity the invite was minted for. The token has 256 bits of entropy and is SHA-256-hashed on disk (forgery is infeasible), but the _raw_ URL appears in two recoverable places between minting and acceptance:

1. **Browser history.** Every browser that opens the URL retains the full path including the token. Cloud-synced browsers (Chrome Sync, Edge Sync, Firefox Sync) replicate the URL across signed-in devices.
2. **The delivery channel** — whatever email, chat, or SMS the operator used to send the link.

**Mitigations.**

- **Tight TTL.** Owner-issued invite links expire 24 hours after issuing (`INVITE_TTL_MS` in `server/auth.ts`). Self-device invite links expire 1 hour after issuing (`SELF_INVITE_TTL_MS`). Neither TTL is configurable.
- **`Referrer-Policy: no-referrer`** on `/i/<token>`, the accept page, the SPA shell, and all auth pages that may carry a bearer token in the URL (`server/auth-middleware.ts:securityHeaders()`), so the token cannot leak via the Referer header on outbound navigations from the accept page. The first-owner claim form intentionally omits this header so Chrome doesn't downgrade its form-POST Origin to `null`; the claim URL has no token to leak.
- **One-time use.** Once the legitimate recipient clicks accept, the invite is permanently consumed (`server/auth.ts`). Any subsequent leak is inert.
- **Mutex-serialized acceptance.** Two concurrent clicks on the same URL cannot both succeed (`server/auth.ts`); whichever runs second sees `consumed=true` and is rejected.

**Residual risk.** Anything that obtains the URL before the recipient clicks — primarily someone with access to the recipient's browser history during the 24h (or 1h) window, or anyone who compromises the delivery channel during that same window — can claim the invite first. The legitimate recipient sees a 410 Gone page on their later attempt.

**Affected files & lines.**

- `server/auth.ts` — `INVITE_TTL_MS` and `SELF_INVITE_TTL_MS` constants.
- `server/auth-middleware.ts` — `securityHeaders()` helper, spread into token-bearing auth/invite HTML responses and the SPA shell; first-owner claim responses omit `Referrer-Policy` because their URL contains no bearer token (`securityHeaders({ tokenInUrl: false })`).
- `server/auth.ts` — one-time consumption.

**Operator guidance.** Send invites over channels you trust, and ask invitees to click promptly. The TTL is short enough that a leaked link generally expires before a casual leaker (a shared device's next user, a forgotten-to-log-out chat archive) can act on it.

---

### Finding 2 — Session cookie persists 30d rolling / 365d absolute — a forgotten session on a shared device remains valid

**Severity:** Low (the lifetime is a deliberate product choice).

**Description.** After acceptance, the session cookie persists for 30 days of rolling activity with a 1-year absolute cap (`server/auth.ts`). There is no client-side idle timeout. A member who opens isomux on a shared device (kiosk, family computer, work laptop they later return to IT, library terminal) and forgets to sign out leaves an authenticated session viable for up to 1 year. The next user of the device — who may not be an intended invitee — has full access in the original user's role and identity without ever needing the invite URL or the cookie value.

The cookie's `SameSite=Lax`, `HttpOnly`, `Secure`-on-HTTPS, and host-only attributes (`server/auth.ts`) defend against every cross-site attack; they do not defend against the next user of the same physical browser.

**Affected files & lines.**

- `server/auth.ts` — `rollingTtlMs = 30 days`, `absoluteTtlMs = 365 days`.

**Mitigation in place.**

- **Per-device revocation.** The Access pane lists every active session with its device user-agent, last-seen timestamp, and an 8-character device prefix. A member who realizes they left a session open on a shared device can revoke it from any other authenticated device. Revocation propagates over the active WebSocket within ~1 second (`server/auth.ts`: send `session_expired` then close), so the revoked browser tab lands on the login page rather than continuing to run.
- **Lockout prevention.** Revoking the office's last active owner session is refused server-side (`server/auth.ts`), so an operator cannot accidentally lock the office out of in-browser recovery while trying to clean up sessions.

**Operator guidance.** Do not stay signed in on devices you don't control. Use private/incognito windows on shared computers, or revoke from the Access pane after the fact. A shorter rolling-TTL operator override and an optional idle timeout would help deployments where shared-device use is common; neither is implemented today.

---

### Finding 3 — `GET /i/<token>` distinguishes `not_found` / `consumed` / `expired` in the response

**Severity:** Informational.

**Description.** `peekInvite` (`server/auth.ts`) returns one of three distinct errors — `not_found`, `consumed`, `expired` — and the HTTP handler `renderInviteError` renders a different message for each. An attacker who somehow obtained a _partial_ token (e.g. the 8-character display prefix from a log entry) could in principle distinguish "this prefix maps to a real token that's been used" from "this prefix doesn't map to anything." With 256 bits of token entropy this is not an actionable brute-force channel.

**Recommendation (optional).** Collapse all three error codes into a single "This invite is no longer valid" response. The legitimate user loses a small UX nicety (they don't learn whether their invite specifically expired vs was already consumed); the response carries no signal about the token's lifecycle state. Not currently implemented.

---

## 5. Verified controls (external-access scope)

These are observed-and-confirmed-correct implementation details that defend against the in-scope threats:

### 5.1 Token entropy

Both invite tokens and session ids are 32 bytes (256 bits) of `randomBytes`, base64url-encoded (`server/auth.ts`). Forgery by brute force is infeasible.

### 5.2 Hash-only on-disk storage

Only `sha256(rawToken)` and an 8-character display prefix are persisted (`server/auth.ts`). A read of `~/.isomux/invites.json` or `~/.isomux/sessions.json` does not yield usable bearer tokens.

### 5.3 Constant-time comparison

`safeHashEq` (`server/auth.ts`) compares hex strings via `timingSafeEqual` after a length check, used on every invite peek, accept, and session validate.

### 5.4 Mutex-serialized state mutations

A single in-process promise chain (`server/auth.ts`) serializes every mutation. Two concurrent attempts to consume the same invite cannot both succeed.

### 5.5 Fail-closed persist ordering

Invite acceptance persists the invite-consumed flag **before** the session (`acceptInvite` in `server/auth.ts`). For a process crash between the two writes, the invite stays consumed without a session: the safer failure mode. For a handled session-persist failure, the in-memory session is deleted and the invite-consumed flag is reverted, so the invite stays usable for a retry.

### 5.6 Cookie attribute set

`setCookieHeader` (`server/auth.ts`) emits `HttpOnly; Path=/; SameSite=Lax`, with `Secure` when the resolved public origin is HTTPS, and no `Domain` attribute (host-only).

### 5.7 Origin allowlist construction

`buildPublicOrigin` resolves the public origin from the boot-frozen bind decision: when the process started loopback-only (no owner yet, or external access disabled), it forces the `http://localhost:${PORT}` fallback regardless of any configured value, so cookie attributes and origin checks match the actual bind. Otherwise it uses `office-config.json#publicOrigin`, falling back to localhost when unset. The server **never** infers the origin from `Host` or `X-Forwarded-Host` headers, defeating DNS rebinding and Host-header confusion. Malformed values are logged and ignored rather than poisoning the allowlist. The Access pane is the only configuration surface for this value (see "External access and public origin" in `docs/access-and-invites.md`).

### 5.8 WebSocket upgrade gating

`/ws` (`server/index.ts`) requires both a valid cookie **and** an Origin header matching the resolved public origin. No loopback bypass on `/ws`. A cross-origin website cannot upgrade to the office WebSocket.

### 5.9 State-changing HTTP Origin gate

`authenticate()` (`server/auth-middleware.ts`) rejects mismatched Origin on POST/PUT/PATCH/DELETE. Modern browsers attach Origin to fetch/XHR and to cross-site POST navigations, and `SameSite=Lax` independently strips credentials from cross-site non-top-level requests. Either defense alone suffices.

### 5.10 Pre-auth POST Origin gate

`POST /auth/accept` and `POST /auth/logout` use `originValidForAuthPost`: Origin must match the resolved public origin, except when the Origin header is absent or the literal string `"null"` — in that case the request is accepted only if `Sec-Fetch-Site: same-origin` is present, a browser-attested Fetch Metadata signal that page JavaScript cannot forge or override. Empty-string Origin fails closed. The `null`-Origin fallback is needed because Chrome sends `Origin: null` on top-level form POSTs originating from a page that carries `Referrer-Policy: no-referrer` (§5.16), which applies to the invite-accept page. A cross-origin attacker submitting a credentialed form to /auth/accept gets `Sec-Fetch-Site: cross-site` or `same-site`, never `same-origin`, so the CSRF defense holds. `POST /auth/claim` is stricter (no null-Origin fallback) because the claim page does not carry `Referrer-Policy: no-referrer` and therefore always produces a concrete Origin header — see §5.11.

### 5.11 First-owner claim surface gated by bind and `hasOwner()`

The first-owner claim form (GET /) only renders when `!hasOwner()`. The `POST /auth/claim` handler re-checks `hasOwner()` under the auth mutex via `claimOwnership` — a concurrent successful claim makes the second attempt fail closed with `owner_exists`. The server binds `127.0.0.1` only when `!hasOwner()`, so the form is only reachable from the host or via SSH tunnel. Owner creation invalidates any pre-existing bootstrap invite rows, and `acceptInvite` rejects bootstrap rows whenever an owner exists.

### 5.12 Atomic disk writes

`persistInvites` and `persistSessions` use temp-file-plus-rename. A crash mid-write cannot leave the on-disk state inconsistent.

### 5.13 Notify-then-close revoke contract

`forceExpireSocketsForSession` (`server/auth.ts`) sends `{type: "session_expired"}` _before_ closing the socket. A revoked tab lands on the login page within ~1 second rather than looping reconnect against a 401.

### 5.14 Per-message session recheck

WS messages re-validate via `revalidateByHash`. Revocation takes effect on the next message without a reconnect; orphaned sessions are evicted on the spot.

### 5.15 Wire-trust override

The command dispatcher uses `session.username` server-side rather than trusting `cmd.username` (`server/index.ts`). A captured cookie cannot be used to spoof a different user's display name on chat messages.

### 5.16 Security headers on every HTML surface

`Referrer-Policy: no-referrer` on every HTML response that may carry a bearer token in the URL (`server/auth-middleware.ts:securityHeaders()`); explicitly omitted on the first-owner claim form response, whose URL has no token to leak, so Chrome's privacy coupling doesn't downgrade the form-POST Origin to `null`. `Strict-Transport-Security: max-age=31536000` added when the resolved public origin is HTTPS. `includeSubDomains` deliberately not set — the operator may not own siblings of the office origin (Tailscale Funnel, Cloudflare, Caddy under various parent domains); operators wanting subdomain-wide HSTS can layer it at their reverse proxy.

### 5.17 Owner-login CLI is gated by Unix-socket file permissions

`bun run server/index.ts owner-login --name "<owner>"` mints a 15-minute one-time login URL for an existing owner via a Unix-domain admin socket at `~/.isomux/admin.sock` (mode 0600). Filesystem permissions are the auth boundary — any UID that can already read the auth files in `~/.isomux/` can connect to the socket, so the CLI adds no new authority, just a clean RPC instead of editing JSON by hand. On a multi-user box where `~/.isomux/` is mode 0700 only the Isomux service user can mint recovery URLs. The mintInvite `ttlMsOverride` option is private to the admin socket; the WS wire intentionally doesn't accept it.

---

## 6. CSRF / CSWSH analysis

### 6.1 WebSocket upgrade

`/ws` rejects missing or mismatched Origin and missing/invalid cookie. No loopback bypass. **Verdict: safe.**

### 6.2 State-changing HTTP

Non-safe methods reject mismatched Origin. Missing Origin is accepted (for loopback curl from same-host agents), but modern browsers attach Origin to fetch/XHR and generally to cross-site POST navigations, and `SameSite=Lax` independently strips credentials from cross-site non-top-level requests. The two defenses are independent. **Verdict: safe.**

### 6.3 Pre-auth POSTs

`POST /auth/accept` and `POST /auth/logout` use `originValidForAuthPost`: Origin must match the resolved public origin, except when the Origin header is absent or the literal string `"null"` — in that case the browser-attested `Sec-Fetch-Site: same-origin` (Fetch Metadata, not forgeable by page JS) is required. Empty-string Origin fails closed. The `null`-Origin fallback exists because Chrome sends `Origin: null` on top-level form POSTs from pages that carry `Referrer-Policy: no-referrer` (§5.10, §5.16). `POST /auth/claim` is stricter: exact-Origin only, no `null` fallback, because the first-owner claim form deliberately omits `Referrer-Policy: no-referrer` so browsers always send concrete Origin (§5.11). **Verdict: safe.**

### 6.4 CORS wildcard on `/tasks` and `/cronjobs`

Both endpoints return `Access-Control-Allow-Origin: *`. With `credentials: include` the browser may still attach the cookie to the request, but it will not expose the response body to JavaScript because a wildcard ACAO lacks `Access-Control-Allow-Credentials: true`. For state-changing routes the Origin gate independently rejects mismatched origins before any response is generated. **Verdict: surprising but not a bypass.** Optional cleanup: replace `*` with the resolved public origin.

### 6.5 DNS rebinding

Cookie is host-only (no `Domain`). Origin allowlist is operator-configured, not header-inferred. An attacker domain that briefly resolves to the office IP still produces an Origin header equal to the attacker's domain — the allowlist check fails. **Verdict: safe.**

### 6.6 HTTP-host-header confusion

Public origin is never inferred from `Host` or `X-Forwarded-Host` (Section 5.7). **Verdict: safe.**

---

## 7. Cross-cutting observations

### 7.1 No rate limiting on `/i/<token>` or `/auth/accept`

Neither endpoint has rate limiting. With 256-bit token entropy this is not an actionable brute-force surface for full tokens. A global rate limit (e.g. 10 invite-peek requests per IP per minute, 5 accept attempts per IP per minute) would be cheap insurance and would surface attacker scanning in the access log. Not currently implemented.

### 7.2 Localhost fallback is plaintext but bind-confined

The bind decision is coupled to the boot-frozen external-access state: a process serving the localhost fallback also binds `127.0.0.1`, so plaintext cookies never leave the host. A process that needs a public HTTPS origin binds to all interfaces. There is no configuration that produces an externally-bound listener on the localhost fallback.

If an operator configures `publicOrigin` but disables the _External access_ toggle, the runtime still serves the localhost fallback — the toggle is the gate, and `buildPublicOrigin` returns localhost whenever the bind is loopback so cookie attributes match the actual connection.

### 7.3 Log hygiene

Raw tokens are never logged. `safePrefix` (`server/auth.ts`) is used for the few diagnostic log lines that need to reference an invite/session. No token leakage was found in error paths or `console.error` calls.

### 7.4 Cookie revocation latency

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
- **Threat model construction.** Built from `docs/access-and-invites.md` and module-level comments in `server/auth.ts`. Scope limited to external (non-invited) access risk per the project's primary use case (small-team self-hosted offices where every invited user is trusted equally).
- **Findings prioritization.** Severity reflects exploit preconditions, blast radius, and the gap between current behavior and the documented intent.
- **Pair review.** Produced by a pair-programming workflow with two LLM-based coding agents (Anthropic Claude Opus 4.7 Max-effort + OpenAI GPT-5.5 xhigh-thinking) acting in driver/reviewer roles. Findings, severities, and final wording were independently scrutinized.

---

## Appendix C — Internal authorization gaps (out of primary scope)

Known **post-acceptance** authorization gaps fall outside this report's external-access scope: an authenticated member with access to a single room can read and mutate resources belonging to members of other rooms (cronjobs, file attachments, tasks), and uploaded HTML can execute in the office's same-origin context. In the documented trust model (`docs/access-and-invites.md`, "Trust model boundaries"), every invited user is treated as equally privileged inside the office; the items below become findings only if that trust model is tightened.

### C.1 Cronjobs and cronjob run transcripts are office-wide-readable and globally mutable

- `server/index.ts` — every WebSocket open broadcasts the full cronjob list to the connecting session.
- `server/index.ts` — `add_cronjob`, `update_cronjob`, `delete_cronjob`, `run_cronjob_now`, `update_cronjobs_prompt`, `list_cronjob_runs`, `list_all_cronjob_runs`, `load_cronjob_run`, `send_cronjob_run_message`, `edit_cronjob_run_message` — none verify the calling session owns the cronjob.
- `server/index.ts` — HTTP `GET /cronjobs/*` is loopback-bypassable and unscoped.
- The `userId`/`username` fields are stored on each cronjob but no policy currently consumes them.

**If tightening is desired:** decide per-user vs office-wide-read + owner-only-write; gate the WS commands and HTTP routes accordingly.

### C.2 File serving and uploads bypass the room/agent ACL

- `server/index.ts` — `POST /api/upload/:agentId` checks the agent exists but does not check `agentVisibleForSession`.
- `server/index.ts` — `GET /api/files/:agentId/:filename` and `GET /api/images/:agentId/:filename` do not check visibility.
- `saveFile` (`server/persistence.ts`) preserves sanitized original filenames with numeric suffixes on collision, so common filenames are guessable.
- A member who previously had access to a room retains the ability to fetch any files whose URLs they remembered.

**If tightening is desired:** gate both routes with `agentVisibleForSession`.

### C.3 Uploaded HTML executes as same-origin active content

- `server/mime-types.ts` maps `html`/`css`/`xml`/`json` to their renderable MIME types; the comment at lines 2-5 acknowledges nosniff is absent.
- `server/index.ts` — `/api/files/...` is served at the office's own origin with the declared MIME type.
- Combined with C.2, any authenticated member can upload `payload.html` into any agent and deliver the URL to a victim; opening it in the victim's browser (top-level navigation under `SameSite=Lax` attaches the cookie) yields stored XSS in the office's origin with full WebSocket-command capability.

**If tightening is desired:** demote active-content extensions (`html`/`htm`/`xml`/`xhtml`/`svg`/`css`/`js`) on `/api/files` to `application/octet-stream` with `Content-Disposition: attachment`; add `X-Content-Type-Options: nosniff`; consider serving attachments from a separate origin.

### C.4 Loopback bypass scope (agent-API is token-bound; task/cron/backup are not)

- `server/index.ts` — the agent self-affordances (`POST /api/agents/:id/{diff,edit-file,read-file,terminal-command}`) and `POST /agents/:id/message` require a per-agent bearer token: affordances are bound to the calling agent by `agentParamMustEqualTokenAgent`, and the message sender is derived from the agent's injected `ISOMUX_AGENT_TOKEN` (a `senderAgentId` that does not match the token is rejected). A same-host process cannot act as an agent it holds no token for.
- The remaining loopback bypass (`isAgentApiPath`) covers `POST /tasks`, the `GET /cronjobs` read routes, and `GET /backup/status`: a same-host process reaches these without a token, so it can list/create tasks, read cronjob metadata/transcripts, and read backup status as if it were local.

**If tightening is desired:** extend the per-agent/per-run token requirement to the task and cronjob-read surfaces, as was done for the agent affordance and message endpoints.

### C.5 HTTP `POST /tasks` accepts client-controlled attribution

- `server/index.ts` — HTTP `POST /tasks` trusts `body.createdBy` and `body.username`; the WS path uses `session.username`.

**If tightening is desired:** force `createdBy = session.username` on the authenticated browser path; keep body-driven attribution for the loopback path.

### C.6 Room creation/close/rename gates use only room-visibility

- `server/index.ts` — `create_room` is unrestricted; `close_room` and `rename_room` gate on `roomAllowedForSession` only.

**If tightening is desired:** decide ownership semantics for rooms — closing/renaming requires creator-or-owner.

---

_End of report._
