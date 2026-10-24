# Schedule management

A schedule runs a prompt in a fresh session daily, weekly, at an interval, or only on demand (schedule `{type:"none"}`: Run now and webhooks start it). A schedule runs with nobody present, so only an agent that acts without approvals can make one: a Claude or OpenCode agent in `bypassPermissions`, or a Codex agent in `never`. Any other agent asks the member to create the schedule on the Schedules tab of the Automations page. A privileged agent can make one in any mode, and can change, delete or run its manager's schedules. An ordinary agent can see, change, delete or run only the schedules it made.

A schedule that an ordinary agent makes cannot have more access than the agent:

- Mode: a Claude or OpenCode schedule always runs with `bypassPermissions`, so the agent needs `bypassPermissions`. A Codex schedule runs with no approvals in its sandbox, so a Codex agent needs `never` and the same sandbox or a wider one.
- Folder: `cwd` is the agent's working folder or a folder inside it.
- Room: the agent's room, or no room.

A request for more returns 403 `schedule_exceeds_agent` with the reason. Isomux checks the mode and the folder again at each change and run that the agent asks for, and at each run start, with the agent's current settings. A run start that is not in the limits makes a failed run with the reason. Turning the schedule off (`{enabled:false}`) and deleting it are always allowed.

A schedule belongs to a room, whose members see it with its runs and transcripts. A job with no room is the maker's and owners' only.

Create with `POST /api/cronjobs` and `{name,schedule,prompt,cwd,modelFamily,effort,permissionMode,roomId?}`. Without `roomId` the job takes your room; `roomId:""` means no room. Run now with `POST /api/cronjobs/:id/runs`, which returns `{runId}`. Change with `PATCH /api/cronjobs/:id` (for example `{enabled:false}`); delete with `DELETE /api/cronjobs/:id`. Read jobs, run lists, and run transcripts with the GET routes below.

`schedule` is `{type:"daily",hour,minute}`, `{type:"weekly",weekday,hour,minute}` (weekday 0 is Sunday), `{type:"interval",minutes}` (at least 5) or `{type:"none"}`. Times are in the server's time zone.

Safe example: `GET /api/cronjobs`.

## Route contract

`GET /api/cronjobs`, `GET /api/cronjobs/:id`, `GET /api/cronjobs/:id/system-prompt`, `POST /api/cronjobs`, `PATCH /api/cronjobs/:id`, `DELETE /api/cronjobs/:id`, `POST /api/cronjobs/:id/runs`, `GET /api/cronjobs/:id/runs`, `GET /api/cron-runs`, `GET /api/cronjobs/:id/runs/:runId`, `POST /api/cronjobs/:id/runs/:runId/messages`, and `PATCH /api/cronjobs/:id/runs/:runId/messages/:logEntryId` return schedule/run/message wires or 204.

Reads return the jobs you can see; for an ordinary agent, only the jobs it made. Mutations are limited to the jobs the agent owns. Invalid bodies return 400/422; a mutation on someone else's job returns 403, and a schedule outside an ordinary agent's limits 403 `schedule_exceeds_agent`; hidden or missing jobs, missing runs, and an inaccessible `roomId` return 404; backend failures return 500.

`POST /api/cronjobs/:id/runs/:runId/messages` accepts `{text,clientMessageId?}` and returns 200 when the message is in the run log. A busy or unresumable run returns 409 and the usage cap 429. A resend with an accepted `clientMessageId` returns 200 with an empty `messageId` and sends nothing.
