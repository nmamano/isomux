---
name: subagent-review
description: Review uncommitted changes by spawning a subagent to look for bugs and assess if the approach is principled or hacky. Use before committing to get a code review.
---

Spawn a subagent (smartest model available) to review the diff of uncommitted changes (both staged and unstaged). Explain to the subagent only the goal of the changes, not the rationale for the approach chosen. Ask the subagent to look for bugs and analyze if the changes are principled or hacky. It must either approve the changes for commit or surface a list of blockers, plus any smaller nits it noticed along the way. Let the user see the feedback before committing.

Then fix what came back - nits as well as blockers. Judge each point on whether acting on it makes the change better, not on whether it stands between you and the commit: the goal is quality, not reaching the finish line. If you think a point is wrong, say so and explain why rather than skipping it silently.
