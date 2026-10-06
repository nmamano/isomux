# Cronjob management

A cronjob is a fresh scheduled session that runs a prompt daily, weekly, at an interval, or only on demand (schedule `{type:"none"}`: Run now and webhooks start it). A privileged agent can create cronjobs and change, delete, or run the ones it owns. These routes replace the Automations-page rule for your own jobs.

A cronjob belongs to a room, whose members see it with its runs and transcripts. A job with no room is the maker's and owners' only.

Create with `POST /api/cronjobs` and `{name,schedule,prompt,cwd,modelFamily,effort,permissionMode,roomId?}`. Without `roomId` the job takes your room; `roomId:""` means no room. Run now with `POST /api/cronjobs/:id/runs`, which returns `{runId}`. Change with `PATCH /api/cronjobs/:id` (for example `{enabled:false}`); delete with `DELETE /api/cronjobs/:id`. Read jobs, run lists, and run transcripts with the GET routes below.

Safe example: `GET /api/cronjobs`.

## Route contract

`GET /api/cronjobs`, `GET /api/cronjobs/:id`, `GET /api/cronjobs/:id/system-prompt` (not available to OpenCode agents), `POST /api/cronjobs`, `PATCH /api/cronjobs/:id`, `DELETE /api/cronjobs/:id`, `POST /api/cronjobs/:id/runs`, `GET /api/cronjobs/:id/runs`, `GET /api/cron-runs`, `GET /api/cronjobs/:id/runs/:runId`, `POST /api/cronjobs/:id/runs/:runId/messages` (not available to OpenCode agents), and `PATCH /api/cronjobs/:id/runs/:runId/messages/:logEntryId` (not available to OpenCode agents) return cronjob/run/message wires or 204.

These routes require a privileged agent. Reads return jobs you can see; mutations are limited to jobs the agent owns. Invalid bodies return 400/422; a mutation on someone else's job returns 403; hidden or missing jobs, missing runs, and an inaccessible `roomId` return 404; backend failures return 500.

`POST /api/cronjobs/:id/runs/:runId/messages` (not available to OpenCode agents) accepts `{text,clientMessageId?}` and returns 200 when the message is in the run log. A busy or unresumable run returns 409 and the usage cap 429. A resend with an accepted `clientMessageId` returns 200 with an empty `messageId` and sends nothing.
