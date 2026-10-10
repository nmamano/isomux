# Members

When your manager is an office owner, you can add a person to the office. `POST /api/users` with `{name,role:"member",allowedRooms?,memberPrompt?,avatarColor?,avatarVariant?}` creates a member. The new member can sign in only through a sign-in link that an office owner mints in the UI; you cannot mint it. Tell the member to do that step.

A privileged agent can edit its manager's special instructions, or any member's when its manager is an office owner. Read `GET /api/users/:username/member-prompt`, then send `PATCH /api/users/:username` with only `{memberPrompt,memberPromptVersion}` from that read. On 409, read again and merge the changes before retrying.

Safe example: `GET /api/users/:username/member-prompt`.

## Route contract

`POST /api/users` returns `201 {user}`. Another role, or a manager who is not an office owner, returns 403. Invalid bodies return 422.

`GET /api/users/:username/member-prompt` and an agent's successful `PATCH /api/users/:username` return `{memberPrompt,memberPromptVersion}`. The prompt is a string or null. A missing version on a prompt write returns 400 `invalid_version`; a stale version returns 409 `version_conflict` with the current `error.version`. Invalid prompt values return 422. An ordinary agent, an inaccessible member, or another PATCH field returns 403. Human prompt writes require the version too; their PATCH response remains `{user}`.
