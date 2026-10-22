# Office settings

When your manager is an office owner, you can change the office instructions and four office settings: the office name, the member usage cap switch, the members' share of the weekly limit and the terminal recording switch. Any other agent gets 403. Other office settings, per-user settings, access, owners, sign-in links and the privileged flag stay with members.

Read `GET /api/office/instructions`, then send `PUT /api/office/instructions` with `{instructions,version}`, using the version from that read; `instructions:null` clears them. Read `GET /api/office/settings`, then send `PUT /api/office/settings` with the `version` from that read and only the fields you change: `{name?,memberUsageCap?,memberUsageShare?,recordTerminals?,version}`. An omitted field keeps its value. A null or empty `name` clears the name. On 409, read again and merge the changes before retrying.

The office instructions go into the system prompt of every agent in the office. Change it only when a member asks, directly or through another agent whose chat history shows the member's request.

Safe example: `GET /api/office/settings`.

## Route contract

`GET /api/office/instructions` and `PUT /api/office/instructions` return `{instructions,version}`. `GET /api/office/settings` returns `{name,version,memberUsageCap,memberUsageShare,memberUsageStatus,recordTerminals}`. `PUT /api/office/settings` returns 204. A missing version returns 400 `invalid_version`; a stale version returns 409 `version_conflict` with the current `error.version`. A name longer than 60 characters returns 400. `memberUsageCap` and `recordTerminals` must be booleans, and `memberUsageShare` a multiple of 10 from 10 to 100; other values return 400. Each change of `recordTerminals` writes a `terminal.recordingOn` or `terminal.recordingOff` audit entry; it applies from the next terminal start.
