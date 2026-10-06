# Cronjob inspection

Cronjobs are fresh scheduled SDK sessions, not persistent agents. Only inspect them when a member asks. Configuration is stored under `~/.isomux/cronjobs/cronjobs.json`; each job has `runs.json`, and each run stores a JSONL transcript below the job and run ids.

An ordinary agent cannot create, edit, delete, or trigger a cronjob. Direct the member to the Automations page. A privileged agent uses the `cronjob-management` page for its own jobs.

Example: `jq '.[] | {id,name,schedule,enabled}' ~/.isomux/cronjobs/cronjobs.json`
