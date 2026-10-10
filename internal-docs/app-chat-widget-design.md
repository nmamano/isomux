# App chat widget

Design for Nil's decision through PM, 2026-10-10. Task 4906e1dc.
No product change is authorized by this document.

## Recommendations

- **Access:** require app access and access to the message target's room. App access alone does not authorize reading that agent's conversation today. A member without room access can still use the app, with no chat launcher or target details.
  Alternative: grant app members a separate chat capability; this needs a new access policy.
- **Conversation:** use the target agent's current, shared conversation. This preserves its context and existing reply delivery, and avoids a second session system. The widget must say that other room members can read the chat; messages from the office and other apps appear there too.
  Alternative: one isolated thread per app registration and member, with separate provider sessions and reply routing.
- **Host:** replace the short-address redirect with an office page that frames the app and owns the widget. App HTML stays on its own origin; existing short links continue to work.
  Alternative: app-side integration, which would require work in each app and would not cover every app natively.
- **Mobile:** the same launcher opens a full-screen chat overlay. Closing it restores the app without reloading the iframe; the keyboard must not hide the composer.
  Alternative: a bottom sheet, which leaves too little room for both chat and the keyboard.

These are proposals, not settled policy. PM must take access, shared conversation, and the framing/auth changes below to Nil before build work. Exact new route and payload shapes return to PM; this document does not assign them.

## What the member sees

Desktop: the app fills the page. A bottom-right chat button opens a compact overlay with the target agent's name, shared-chat notice, transcript, composer, and image previews. Closing it restores space without discarding a draft. New replies mark the closed button as unread. Normal busy, queued, error, and reconnect states use the existing chat behavior.

Paste or drop images into the open widget, or select an image file. Show each image before sending and let the member remove it. The widget never captures the page. On mobile, the file picker accepts an OS screenshot; closing chat lets the member capture the app first. Focus returns to the launcher when chat closes. The member can always open the app directly if an app's own login or page behavior requires a top-level tab; that tab has no widget.

Proposed new copy, for review (placeholders in braces):

- Launcher: “Chat”
- Title: “Chat with {agentName}”
- Notice: “Shared with members of the agent's room.”
- Windows hint: “Press Win+Shift+S, then paste your screenshot here.”
- macOS hint: “Press Control+Shift+Command+4, then paste your screenshot here.”
- Other desktop/mobile hint: “Take a screenshot, then paste or attach it here.”
- File button: “Attach image”
- Close button: “Close chat”
- Direct link: “Open app directly”
- Unavailable state: “Chat is unavailable.”

## Message in, reply out, attachments

The office wrapper authenticates the member, resolves the live app registration and `messageTargetAgentId ?? createdByAgentId`, and checks both access scopes. It must not expose a hidden target's name or history. A proposed server check around the existing member send path should repeat those checks and resolve the target when sending (exact API shape goes to PM); the browser must not choose an arbitrary agent under an app identity. Keep the member as sender and add server-derived app context. Use the existing member queue and attachment delivery, not the app's token or `apps.sendMessage`: that route currently accepts text from an app identity and returns a delivery acknowledgement, not a reply stream (`server/routes/handlers/apps.ts:873–982`).

Replies remain ordinary entries in the agent's shared log. Reuse the office socket's room-filtered `log_entry` delivery (`server/isomux-office.ts:3159`) and reconnect replay (`shared/types.ts:1969–1979`), displaying the selected agent's current conversation. There is no inference that the next assistant entry belongs exclusively to this member. Session changes follow the existing chat behavior. If the target changes, clear the old transcript and recheck access before loading the new one; do not silently send an old draft or its attachments to the replacement target.

Reuse image upload/storage and provider attachment support. Today `POST /api/upload/:agentId` and file reads check the agent's room (`server/isomux-office.ts:2597–2625,7033–7045`). The widget also needs app/registration checks for its upload and send flow, with a target snapshot so a mid-upload target change fails safely. Upload returns attachment references; send carries those references with the text. Failed sends retain the draft for retry. Images belong to the shared agent chat and use its retention rules, not a private app store. Images never pass through the app server.

Recheck live app, member session, app visibility, and target-room access on sends, uploads, history/reconnect, and continued display. An app deletion, replacement registration, permission removal, or missing target clears/disables the widget. App-name reuse must not inherit the old widget state. Ordinary office file access retains its existing room policy. Existing agent permissions and execution authority remain unchanged.

## Short page, app host, and browser boundary

Current code, checked at `666120e7` on 2026-10-10:

- `server/app-short-url.ts:6–15` and `server/isomux-office.ts:6654–6684` produce `/{name}` and a no-store 302 to the app root, preserving the query. This GET/HEAD redirect runs before the auth wall. The wrapper must require office sign-in; keep HEAD as a bodyless redirect and preserve query forwarding. Only HTTPS offices with app hostnames get short addresses. Preserve that availability and query behavior when the page replaces the redirect; tailnet `ts.net`, plain HTTP, and localhost offices have no short address or widget (`server/app-domain.ts:80–98`).
- `server/app-visibility.ts:25–37` admits office owners, the app owner, or members with a live creator's room access. `canUserAccessApp` uses that policy (`server/isomux-office.ts:2627–2646`); viewer app records already omit the message target (`:2660–2662`). The creator's room can differ from the message target's room.
- `server/isomux-office.ts:6440–6467` diverts app hosts before office routing through `app-hosts.ts`. Keep that boundary. All widget scripts, API requests, and sockets stay on the office origin; the iframe receives no office credentials or chat data.
- `server/app-auth.ts:313–322,668–697` uses a host-only, Secure, HttpOnly, SameSite=Lax app cookie bound to an office session and registration generation. `mayInitiateHandshake` accepts browser navigation to a document, not an iframe (`:294–308`). Redeem currently returns to an app-relative path (`:618,702`). A wrapper cannot simply point a fresh iframe at the app and expect sign-in to work.
- `server/auth-middleware.ts:118–157` already permits app subdomains in office `frame-src`, while office `frame-ancestors 'none'` and X-Frame-Options DENY prevent embedding the office. Keep those office protections. `server/app-proxy.ts:247–264` currently passes upstream CSP and X-Frame-Options through.

**Proposed sign-in change:** use an end-to-end top-level office → app redeem → office wrapper round trip before loading the iframe. The office mint step cannot run inside the iframe either: office responses deny framing. Add an explicit wrapper-return mode bound to the code's registration and office session; construct its destination from the configured office origin and registry, never an arbitrary return URL. Preserve today's app-relative return mode for direct app visits. An app session expires after 12 hours or earlier when the office session expires or is revoked (`server/app-auth.ts:71–77,696`). Today a framed load without a live app session shows a plain-text 401, “authentication required” (`:799–802`; `server/app-host-responses.ts:33`). The wrapper cannot read that cross-origin response. **Open for PM/Nil before build:** how the wrapper detects initial readiness and expiry, including a missing browser cookie. A candidate is office-server session/expiry status plus an app-host-owned readiness signal; server state alone cannot prove that the browser retained its cookie. Approve the mechanism before choosing routes. Proposed recovery preserves the draft, shows a sign-in recovery action, and uses the same top-level flow with a bounded failure state; recovery copy follows that decision.

App addresses are `https://<label>.<office host>` (`server/app-domain.ts:112–118`). Office and app subdomains use separate origins but normally the same HTTPS site, so the existing Lax cookie can accompany the iframe request. Keep host-only cookies and the proxy's credential stripping; do not broaden cookie domains, add credentialed CORS, or use SameSite=None as a workaround. Confirm Chrome and mobile Safari behavior in a browser test. See [cookie rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

**Proposed framing change, for approval:** Isomux owns app response framing policy. On proxied app document responses, the proxy removes upstream X-Frame-Options and replaces only `frame-ancestors` with `'self'` plus the exact configured office origin, preserving all other CSP directives across all enforced policies. If upstream has no CSP, add a CSP with that `frame-ancestors` directive; if a policy has no such directive, add it. Today header-less app responses have no framing restriction (`server/app-proxy.ts:431–449`); sibling app frames are same-site and can carry the Lax cookie. The proposed policy narrows that exposure to the app itself and the office. Adding a second, looser CSP does not override a restrictive first policy. Keep HTML bytes unchanged and keep auth/error responses separate. This deliberately changes an app's upstream embedding policy; Nil must approve it. Apps with frame-breaking scripts, external sign-in redirects, or other incompatible behavior retain the direct-open path. See [frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors) and [multiple CSP policies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy).

**Proposed iframe sandbox:** `allow-scripts allow-same-origin allow-forms allow-downloads allow-popups`. The frame stays on a separate origin, so `allow-same-origin` preserves app cookies/storage without giving access to the office DOM. Exclude top-navigation tokens so an app cannot navigate the office tab. The wrapper ignores app-content `postMessage`; any future auth-readiness signal requires a separate origin/source/registration-bound protocol approved by PM. App login flows that require wider sandbox permissions use the direct-open link pending a PM decision.

## Build slices after approval

1. **Auth and framing:** implement wrapper return/readiness and narrow response-header changes. Test fresh and expired cookies, direct visits, revoked access, registration reuse, hostile return values, upstream CSP/XFO, and redirect-loop prevention in real browsers.
2. **Wrapper and text chat:** replace the short redirect, preserve query forwarding, add target resolution/access checks, shared transcript, queue/reconnect behavior, and desktop/mobile overlay. Verify target changes and room/app revocation during use. Keep the app iframe mounted when chat closes.
3. **Images and finish:** wire paste/drop/file selection to uploads, test target changes during upload and failed-send retry, and inspect screenshots on desktop and mobile Safari. Update `docs/features.md`, relevant app/API references, and other affected surfaces from `internal-docs/documentation.md`; new agent-facing routes also need curl labels. Build UI and obtain approval for the server restart needed to activate server changes.

This lane changes only this design document. No tests or test assertions change; no runtime gates are required by the brief. Reviewer verifies the code claims before PM submits the design to Nil.
