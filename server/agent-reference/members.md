# Members

When your manager is an office owner, you can add a person to the office. `POST /api/users` with `{name,role:"member",allowedRooms?,instructions?,avatarColor?,avatarVariant?}` creates a member. The new member can sign in only through a sign-in link that an office owner mints in the UI; you cannot mint it. Tell the member to do that step.

One member's special instructions can point to another member's instead of copying them: everyone who shares a room with that member can read them (see discovery). A privileged agent can edit its manager's special instructions, or any member's when its manager is an office owner. Read `GET /api/users/:username/instructions`, then send `PUT /api/users/:username/instructions` with `{instructions,version}`, using the version from that read. On 409, read again and merge the changes before retrying. Write instructions as you write memory lines: the rule or a pointer, without the member's words quoted, evidence or history (see memory).

A privileged agent can rename its manager, or any member when its manager is an office owner: `PATCH /api/users/:username` with `{name}`. Instructions, memory and other texts that use the old name keep it.

When your manager is an office owner, you can set up a member's sidebar, also before they sign in. `GET /api/users/:username/pinned` reads their Pinned list; `PUT /api/users/:username/pinned` with `{pinned}` replaces it. An entry is an agent id, or `member:<userId>` for a member. Read first, then send the whole list in order.

When your manager is an office owner, `GET /api/users/:username/os-user` tells whether the member's agents run as their own OS user: `state` (`off`, `on`, `moving`, `not_ready` or `broken`), `osUser`, the last run of the root command (`attempt`), and `commands`, the `enable` and `disable` lines an office owner runs as root to turn it on or off. You cannot run them. `run` is `password` or `no_password` when the owner's page can run them itself, else null. `support` is `{ok: false, reason}` where the root command cannot run. `unfinished: true` means an enable stopped while it moved their files; it is not ready until the enable runs again.

Safe example: `GET /api/users/:username/instructions`.

## Route contract

`POST /api/users` returns `201 {user}`. Another role, or a manager who is not an office owner, returns 403. Invalid bodies return 422. In an office with an Enterprise Contract (see office-settings), the add can be refused: 409 `seats_full` when the license has no free seat, 409 `enterprise_secret_needed` before the secret is set, 403 `enterprise_secret_rejected` or `enterprise_not_signed`, and 429 `enterprise_rate_limited`. Tell the member; IT adds seats on the enterprise account.

`GET /api/users/:username/instructions` and `PUT /api/users/:username/instructions` return `{instructions,version}`. The instructions are a string or null. A missing version returns 400 `invalid_version`; a stale version returns 409 `version_conflict` with the current `error.version`. Invalid instructions return 422. A read of an unknown member returns 403. A read of a member who shares no room with you also returns 403, unless your manager is an office owner. A write by an ordinary agent, or of a member outside your reach, returns 403.

`GET /api/users/:username/pinned` returns `{pinned}`. `PUT /api/users/:username/pinned` returns 204. The server drops entries for agents and members that do not exist, repeats, and the member's own entry. A body that is not a list of strings returns 422 `invalid_pinned`; more than 200 entries return 422 `too_many_pinned`. An unknown member returns 404 `user_not_found`. An ordinary agent, or one whose manager is not an office owner, gets 403.

`GET /api/users/:username/os-user` returns the object above; `commands` is null for an owner and where the root command cannot run. Other callers get 403, and an unknown member 404.

`PATCH /api/users/:username` returns `{user}`. A body with any field other than `name` returns 403; a body with no name returns 422. A rename by an ordinary agent, or of a member outside your reach, returns 403. A name that another member has returns 409 `name_taken`.
