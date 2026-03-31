---
name: isomux-review
description: Review uncommitted changes by spawning a subagent to look for bugs and assess if the approach is principled or hacky. Use before committing to get a code review.
---

Spawn a subagent (smartest model available) to review the diff of uncommitted changes (both staged and unstaged). Explain to the subagent only the goal of the changes, not the rationale for the approach chosen. Ask the subagent to look for bugs and analyze if the changes are principled or hacky. It must either approve the changes for commit or surface a list of blockers. Let the user see the feedback before committing.
