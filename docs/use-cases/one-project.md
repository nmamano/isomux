---
title: Several agents on one project
navTitle: Several agents on one project
description: Run several Isomux agents on one project - one room, a lead that drives its workers, and hand-offs by message.
order: 3
---

# Several agents on one project

- **One room per project** - the room's instructions reach every agent in it; the lead sits at a front desk and its workers in the back room.
- **A lead that drives its workers** - a [privileged](../features.md#agent-coordination) lead spawns and instructs its workers, each on its own engine and model, so you talk mostly to the lead.
- **Hand-offs go by message** - the lead sends a worker its spec and the worker reports back when it is done.
- **A git worktree per agent** - Isomux has no built-in worktree support. Tell each agent to work in its own git worktree, so agents do not overwrite each other's uncommitted edits.
