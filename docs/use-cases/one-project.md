---
title: Several agents on one project
navTitle: Several agents on one project
description: One way to run several Isomux agents on one project - one room, a lead that drives its workers, and hand-offs by message.
order: 6
---

# Several agents on one project

Isomux sets no workflow for this. Here is one way to set it up:

- **One room for the project** - the room's instructions reach every agent in it. The lead can sit at a front desk and its workers in the back room.
- **A lead that drives its workers** - a [privileged](../features.md#agent-coordination) lead can spawn and instruct its workers, each on its own engine and model, so you talk mostly to the lead.
- **Hand-offs by message** - the lead sends a worker its spec, and the worker reports back when it is done.
- **A git worktree per agent** - Isomux has no built-in worktree support. You can tell each agent to work in its own git worktree, so agents do not overwrite each other's uncommitted edits.
