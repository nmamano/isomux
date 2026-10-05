# Cronjob management

A cronjob is a fresh scheduled session that runs a prompt daily, weekly, or at an interval. A privileged agent can create cronjobs and change, delete, or run the ones it owns; reads cover any cronjob. These routes replace the Schedules-page rule for your own jobs.

Create with `POST /api/cronjobs` and `{name,schedule,prompt,cwd,modelFamily,effort,permissionMode}`. Run now with `POST /api/cronjobs/:id/runs`, which returns `{runId}`. Change with `PATCH /api/cronjobs/:id` (for example `{enabled:false}`); delete with `DELETE /api/cronjobs/:id`. Read jobs, run lists, and run transcripts with the GET routes below.

Safe example: `GET /api/cronjobs`.

## Route contract

`GET /api/cronjobs`, `GET /api/cronjobs/:id`, `GET /api/cronjobs/:id/system-prompt` (not available to OpenCode agents), `POST /api/cronjobs`, `PATCH /api/cronjobs/:id`, `DELETE /api/cronjobs/:id`, `POST /api/cronjobs/:id/runs`, `GET /api/cronjobs/:id/runs`, `GET /api/cron-runs`, `GET /api/cronjobs/:id/runs/:runId`, `POST /api/cronjobs/:id/runs/:runId/messages` (not available to OpenCode agents), and `PATCH /api/cronjobs/:id/runs/:runId/messages/:logEntryId` (not available to OpenCode agents) return cronjob/run/message wires or 204.

These routes require a privileged agent. Mutations are limited to jobs the agent owns. Invalid bodies return 400/422; jobs owned by someone else return 403; missing jobs or runs return 404; backend failures return 500.

`POST /api/cronjobs/:id/runs/:runId/messages` (not available to OpenCode agents) accepts `{text,clientMessageId?}` and returns 200 when the message is in the run log. A busy or unresumable run returns 409 and the usage cap 429. A resend with an accepted `clientMessageId` returns 200 with an empty `messageId` and sends nothing.
