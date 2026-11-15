# Schedule inspection

A schedule run is a fresh SDK session, a message to an agent, or a command, never a persistent agent. Only inspect them when a member or an agent with the same manager asks. Configuration is stored under `~/.isomux/cronjobs/cronjobs.json`; each job has `runs.json`, and each session run stores a JSONL transcript below the job and run ids. A run that messages an agent or runs a command has no transcript; its row in `runs.json` holds the result.

To create, change, delete or run a schedule, use the `cronjob-management` page.

Example: `jq '.[] | {id,name,schedule,enabled}' ~/.isomux/cronjobs/cronjobs.json`
