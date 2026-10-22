# Members

When your manager is an office owner, you can add a person to the office. `POST /api/users` with `{name,role:"member",allowedRooms?,instructions?,avatarColor?,avatarVariant?}` creates a member. The new member can sign in only through a sign-in link that an office owner mints in the UI; you cannot mint it. Tell the member to do that step.

A privileged agent can edit its manager's special instructions, or any member's when its manager is an office owner. Read `GET /api/users/:username/instructions`, then send `PUT /api/users/:username/instructions` with `{instructions,version}`, using the version from that read. On 409, read again and merge the changes before retrying.

Safe example: `GET /api/users/:username/instructions`.

## Route contract

`POST /api/users` returns `201 {user}`. Another role, or a manager who is not an office owner, returns 403. Invalid bodies return 422.

`GET /api/users/:username/instructions` and `PUT /api/users/:username/instructions` return `{instructions,version}`. The instructions are a string or null. A missing version returns 400 `invalid_version`; a stale version returns 409 `version_conflict` with the current `error.version`. Invalid instructions return 422. An ordinary agent or an inaccessible member returns 403.
