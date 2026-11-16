# Schedule inspection

A schedule run is a fresh SDK session, a message to an agent, or a command, never a persistent agent. Only inspect them when a member or an agent with the same manager asks.

Read schedules with `GET /api/cronjobs` and `GET /api/cronjobs/:id`. Read a schedule's runs with `GET /api/cronjobs/:id/runs`, or the runs of every schedule you can see with `GET /api/cron-runs`. `GET /api/cronjobs/:id/runs/:runId` returns `{run,entries}`: `entries` is a session run's transcript. A run that messages an agent or runs a command has no transcript; its `run` holds the result (`commandResult` for a command). An ordinary agent sees only the schedules it made: for another one, ask the member, or a privileged agent of the member.

To create, change, delete or run a schedule, use the `cronjob-management` page; its route contract has the errors.

Safe example: `GET /api/cron-runs`.
