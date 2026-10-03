# Member creation without invites (task ec1724a8)

Status: approved by the PM, 2026-10-02, with both open questions settled as recommended (400 for the old body, no shim; language off the create form).

## Problem

Today a new-member invite carries the profile (name hint, role, language, prompt, room grants). The server creates the user only when the invitee accepts. If the invite expires, the profile is lost.

Nil's direction: creating a member and signing a member in are two different actions. An invite is only a sign-in link for a member that already exists.

## 1. Create member

- Who: office owners. Route guard `cap(["user:admin", "user:create"], or(officeOwner, ownerProxyMemberCreate))`. `user:create` is held by the privileged agent and API sets only: an office owner's privileged agent or API token can create a member with role `member` and optional `allowedRooms` (an owner role is a 403; Nil, 2026-10-03). Ordinary agents and members' proxies cannot (task 1ad91d87).
- Where: the Members group in the settings sidebar gets a "New member" row for owners. It opens `UserEditPanel` in a create mode. There is no separate form.
- Fields in create mode: name (required), Office owner checkbox, avatar, room access (members only), profile prompt. These are the record fields the owner can already edit.
- Not in create mode: member memory, variable names, delete. They need a stored record. After "Create member" succeeds, the panel opens the new member in normal edit mode, where these sections are available.
- Language is not on the create form. It is a self-only preference (`/api/me/preferences`), so an owner cannot set it. The new member picks it on the first sign-in page (see 2).
- Never-signed-in state: `users.create` sets `pendingSignIn: true` on the record. The first accepted sign-in link for that member removes it. Legacy records do not have the field, which means "signed in before". The field is on `UserAdminWire`/`UserSelfWire` only, not on `UserPublicWire`.
- Roster: for owners, a pending member's summary line reads "never signed in" instead of "last seen …". Other members see a plain row, the same as any offline member.

## 2. One sign-in-link flow

- The owner Invites pane has one card: a member dropdown (every member, the owner included) and a "Create sign-in link" button. A note above it: to invite a new member, create them first in Members. The issue-invite form and the separate Recovery card are removed.
- Link policy: the current recovery policy. 24h TTL, one outstanding link per member (a new link replaces the old one).
- Accept page: a link for a pending member shows the language picker that new-user invites show today (default: browser language). Accepting sets the language and removes `pendingSignIn`. A link for a member who signed in before shows the one-click accept page, as today.
- Links bind to the member's id. Today a link stores only the username. If the owner renames a member before they accept, `acceptInvite` finds no record and `claimUser` creates a second user with the old name. This is more likely now, because owners create members in advance. New links store `userId`, and accept resolves the name from the record. If the record is gone, accept refuses with the existing "invalid link" page. Deleting a member also revokes their outstanding links.
- Rule after this change: accepting a link never creates a member. The only exceptions are the legacy rows in section 4.
- My devices (member self-invite) stays as it is: the 1h TTL, the "Sign-in links" pane, `POST /api/invites/self`. It is the members' door. Members cannot use the owner pane. It uses the same core and also binds to `userId`.
- `owner-login` CLI and the sign-in link from the External access save: these do not change. They also bind to `userId`.

## 3. First owner

No change. The first owner uses the tokenless claim form (`claimOwnership`), the Render setup key, or the VPS installer/control plane. The installer and the control plane claim, then call `POST /api/invites/recovery` for an owner that exists. Bootstrap invite rows in `invites.json` are already legacy; their accept branch stays.

## 4. Backward compatibility

- `invites.json`: the loader reads old rows without changes. A new optional `userId` field.
- Outstanding new-user rows (`newUser: true`) from the old flow: these still work until they expire. That is at most 24h after the upgrade. The accept branch that creates the user (name chosen by the invitee, room grants, language) stays for these rows only. Minting new rows is removed. Remove the branch in a later release.
- Outstanding legacy sign-in links for existing members (recovery, self-invite, owner-login rows without `userId`): the invites load at boot binds each to the userId its username has at that moment and persists it; a name with no member drops the row (accept shows the invalid-link page). After that, accept resolves only by id. (PM ruling, 2026-10-02. The role check between mint and accept stays.)
- `users.json`: new optional `pendingSignIn`. Absent means signed in.
- `POST /api/invites/recovery {userId}`: stays permanently, with the same handler as the new `POST /api/invites`. `deploy/install.sh` and `control-plane/remote/mint-invite.sh` call it, and the control plane talks to offices of every version.
- `POST /api/invites`: the new body is `{userId}`. An old body (`label`/`username`/`role`/…) returns 400 with this error: "Invites no longer create members. Create the member with POST /api/users, then send POST /api/invites with {userId}." Recommendation: no shim that creates the member. A shim keeps a second create path and cannot support unnamed invites.
- WS messages: nothing to do. The `mint_invite`/`mint_self_invite`/`list_invites`/`revoke_invite` arms are already removed. Only comments refer to them.
- `InviteMintReq` (shared/contract-shapes.ts) becomes `{userId}`. `RecoveryMintReq` becomes an alias of it.

## 5. Surfaces to update

- Server: `users.create` route + handler (`POST /api/users`, emits `users_list` + `user_admin_updated`), `invites.mint` handler, the seam in `isomux-office.ts`, `auth.ts` (`mintInvite` drops the profile/grant options for new mints, `StoredInvite.userId`, accept by id, `pendingSignIn` clear, peek gives `firstSignIn` in place of `newUser`), `users.ts` (`pendingSignIn`), users.delete revokes links, `auth-middleware.ts` accept page.
- UI: `UserSettingsView.tsx` (New member row, create mode, roster line), `InvitesPane.tsx` (one card + note), `ui/demo-server.ts` (`POST /api/users` disabled like invites).
- Tests: `routes-table.test.ts` (new route), `routes-invites-rest`, `routes-users-rest`, `auth-invites`, `invite-onboarding`, `invite-identity`, `invite-consumed-ux`, `InvitesPane.dom`, settings i18n DOM tests, `scripts/check-container-update-fixture.py` (two steps).
- System prompt (`server/system-prompt.ts:306`): "mint invites" → "create members or mint sign-in links".
- Docs: `docs/access-and-invites.md` (sections 2-4, operating notes), `docs/features.md` (invite-link access, per-member room access), `docs/hosting/blocks/invites.md`, `internal-docs/documentation.md` (the access-and-invites line), comments in `server/routes/handlers/invites.ts`.
- Translations: en/es/zh/ca. Remove the issue-invite and recovery keys. Add: "New member", "Create member", "never signed in", "Create sign-in link", and the note "To invite a new member, create them first in Members."

## Open questions for the PM

1. A 400 for the old `POST /api/invites` body, or a shim that creates the member and the link in one call? Recommendation: 400.
2. Language off the owner's create form (it is self-only), and picked by the member at first sign-in? Recommendation: yes.
