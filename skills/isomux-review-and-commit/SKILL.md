---
name: isomux-review-and-commit
description: Review uncommitted changes for bugs and issues, then commit automatically if no blockers are found. Blockers prevent the commit; non-blockers are reported but don't block it.
---

Review uncommitted changes and commit if they pass review.

1. Spawn a subagent (smartest model available) to review the diff of uncommitted changes (both staged and unstaged). Explain only the goal of the changes, not the rationale for the approach. Ask the subagent to classify every issue it finds as either a BLOCKER or a NON-BLOCKER:
   - Blockers: bugs, logic errors, security issues, broken functionality — things that would make the commit incorrect.
   - Non-blockers: style nits, minor refactoring opportunities, naming suggestions — things worth noting but not worth holding up the commit.
     The subagent must either approve the changes or list blockers.
2. If there are blockers: list them and do NOT commit. Tell the user what needs to be fixed. Also list non-blocking issues.
3. If there are no blockers: report any non-blockers, then commit.
