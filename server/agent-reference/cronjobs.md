# Schedule inspection

Schedules run as fresh SDK sessions, not persistent agents. Only inspect them when a member or an agent with the same manager asks. Configuration is stored under `~/.isomux/cronjobs/cronjobs.json`; each job has `runs.json`, and each run stores a JSONL transcript below the job and run ids.

To create, change, delete or run a schedule, use the `cronjob-management` page.

Example: `jq '.[] | {id,name,schedule,enabled}' ~/.isomux/cronjobs/cronjobs.json`
