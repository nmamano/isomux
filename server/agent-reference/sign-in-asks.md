# Sign-in asks

Part of the `action-asks` page: open these steps as an action ask.

A sign-in link for a member: `step` is `{"kind": "sign-in-link", "username": "<member>"}`. Signing a member out on every device: `{"kind": "member-sessions", "username": "<member>"}`. Ending one session of a member: `{"kind": "session-revoke", "username": "<member>", "sessionPrefix": "<prefix>"}`, with a prefix from the session list; the ask closes when the session is gone, from the card or by hand. Taking back a member's unused sign-in links: `{"kind": "sign-in-links-revoke", "username": "<member>"}`. An office owner can apply these for any member, a member only for themself. Giving a member's sign-in link 3 more days from now, live or expired: `{"kind": "sign-in-link-extend", "username": "<member>"}`. The URL stays the same. Only an office owner can apply it. It refuses 409 `no_extendable_link` when the member has no link an owner can extend. A sign-out or a session step refuses 409 `would_strand_office` when it would end the last owner sessions. A session step also refuses 422 `unknown_session` when that member has no live session with that prefix.

A sign-in link made from the card shows only on the member's card. You never get it.

To see a member's sign-in links and their expiry, `GET /api/users/:username/sign-in-links` returns `{links:[{tokenPrefix,createdAt,expiresAt,expired?,extendable?}]}`, newest first: each unused link that is live, or expired and still extendable. It has the same access as the session list. You never get the link itself.

To name a session, read your manager's live sessions, or any member's when your manager is an office owner: `GET /api/users/:username/sessions` returns `{sessions:[{sessionPrefix,device,userAgent,createdAt,lastSeenAt}]}`, last seen first. `device` is the name the device gave itself, or null; the user agent tells a script's session (such as `curl/8.5.0`) from a browser's. Another member, or an unknown one, returns 403.
