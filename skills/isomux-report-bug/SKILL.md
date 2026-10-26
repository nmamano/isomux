---
name: isomux-report-bug
description: Report an Isomux bug on GitHub. Use when the user asks to report one. When you hit a flaw in Isomux itself while you work (a bug, a wrong doc, a tool or route that does not do what it says), offer to report it. Shows the full draft and files only after the user approves.
---

Help the user file a bug report against the isomux GitHub repo (https://github.com/nmamano/isomux).

1. If you hit the bug yourself, describe what you saw and what you did instead. Otherwise, ask the user to describe the bug.
2. Gather system info: isomux version (find the isomux install directory by checking where this skill file lives - it's under `skills/` in the isomux repo - then run `git rev-parse --short HEAD` there), OS (`uname -a`), and the user's current room and desk (from `GET /agents`, agent reference page `discovery`: match your own agent ID, do NOT include the agent name).
3. Draft a GitHub issue with the description from step 1 and a "System info" section at the bottom.
4. Show the full draft to the user. Flag any potentially sensitive information (file paths, system details, project names, etc.) so the user can remove it. Do NOT file until they explicitly approve. Let them edit or remove anything.
5. Once approved, file using `gh issue create --repo nmamano/isomux`.
