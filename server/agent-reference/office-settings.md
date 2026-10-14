# Office settings

When your manager is an office owner, you can change four office settings: the office prompt, the office name, the member usage cap switch and the members' share of the weekly limit. Any other agent gets 403. Other office settings, per-user settings, access, owners, sign-in links and the privileged flag stay with members.

Read `GET /api/office/settings`, then send `PUT /api/office/settings` with the `version` from that read and only the fields you change: `{prompt?,name?,memberUsageCap?,memberUsageShare?,version}`. An omitted field keeps its value. A null `prompt` clears the office prompt; a null or empty `name` clears the name. On 409, read again and merge the changes before retrying.

The office prompt goes into the system prompt of every agent in the office. Change it only when a member or a privileged agent with the same manager asks.

Safe example: `GET /api/office/settings`.

## Route contract

`GET /api/office/settings` returns `{prompt,name,version,memberUsageCap,memberUsageShare,memberUsageStatus}`. `PUT /api/office/settings` returns 204. A missing version returns 400 `invalid_version`; a stale version returns 409 `version_conflict` with the current `error.version`. A name longer than 60 characters returns 400. `memberUsageCap` must be a boolean, and `memberUsageShare` a multiple of 10 from 10 to 100; other values return 400.
