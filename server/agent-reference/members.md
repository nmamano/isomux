# Members

When your manager is an office owner, you can add a person to the office. `POST /api/users` with `{name,role:"member",allowedRooms?,memberPrompt?,avatarColor?,avatarVariant?}` creates a member. The new member can sign in only through a sign-in link that an office owner mints in the UI; you cannot mint it. Tell the member to do that step.

Safe example: none; this route always creates a record.

## Route contract

`POST /api/users` returns `201 {user}`. Another role, or a manager who is not an office owner, returns 403. Invalid bodies return 422.
