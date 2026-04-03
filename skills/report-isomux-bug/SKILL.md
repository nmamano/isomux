---
name: report-isomux-bug
description: File a bug report against the isomux repo on GitHub. Gathers system info, shows a full draft for user approval before filing.
---

Help the user file a bug report against the isomux GitHub repo (https://github.com/nmamano/isomux).

1. Ask the user to describe the bug.
2. Gather system info: isomux version (find the isomux install directory by checking where this skill file lives — it's under `skills/` in the isomux repo — then run `git rev-parse --short HEAD` there), OS (`uname -a`), and the user's current room and desk (from ~/.isomux/agents-summary.json — match your own agent ID, do NOT include the agent name).
3. Draft a GitHub issue with the user's description and a "System info" section at the bottom.
4. Show the full draft to the user. Flag any potentially sensitive information (file paths, system details, project names, etc.) so the user can remove it. Do NOT file until they explicitly approve. Let them edit or remove anything.
5. Once approved, file using `gh issue create --repo nmamano/isomux`.
