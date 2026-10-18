# Continuous loop

Draft, 2026-10-18. Board task 178dbb5a.

## Goal

Agents work the Isomux room's backlog without Nil present, for as long as reviewed `ready` tasks remain. When a task needs Nil, the loop parks it in Nil's attention queue and takes the next task. Nil goes through the queue at his own pace. Nothing in the loop waits on a clock or a deadline.

## What Nil owns

- Design go/no-go on new features.
- Sign-off of copy (the customer-facing prose listed in the isomux-lead-session skill, Phase 5).
- The push.

Inside a task, the worker and reviewer make the smaller choices themselves and record them in the report. Nil sees them at review time, and a wrong choice gets redone.

Merges into local main need no approval from Nil (Nil, 2026-10-18).

## What the loop picks

Credits are limited, so the loop works only on what Nil wants now. The priority field is the queue: the Lead takes P0 first, then P1 down to P3, the oldest first within a priority, and never P4.

The loop picks only tasks that Nil has reviewed. Agents (Isomux PM, Isomux Lead, workers, Isomux Comms) set a priority when they file, so a priority alone does not show Nil's intent. Nil's review sets the priority and the class tag below. A task without a tag is unreviewed, and the loop never picks it. This covers old tasks whose priority Nil no longer trusts and new tasks that nobody has looked at yet.

When the queue has no reviewed `ready` task, the loop stops. Idle credits cost nothing; credits spent on work Nil did not choose are waste.

## Task tags

Each open task in the room has a title prefix `[<class> | <state>]`.

Class:

- `auto`: the loop can do it from start to finish.
- `decide`: needs Nil's design go/no-go. The loop may research it and write a decision packet (the question, the options, its recommendation). It does not implement before the go.
- `taste`: the result is mainly copy or visual design that Nil must approve (landing, site, docs prose, look of a feature).
- `authority`: needs an action the loop never does (Stripe, Hosted, customers, secrets, releases, logins). The loop does not touch it.

State: `ready` when an agent can take the task now. Otherwise a short reason for the wait, for example `nil`, `soak until 10-25`, `after <task id>`. The list of reasons is open.

Examples: `[auto | ready] Codex usage_update double-counts after session resume`, `[decide | nil] Support local models`.

Rules:

- A tag comes only from Nil's review, in the triage view of the loop app. Agents file tasks without a tag. The room prompt says so.
- After the review, the Lead may change the state (for example to `nil` when a task parks), never the class or the priority.
- Only Nil's words move a task from `nil` to `ready`.
- P4 (backlog) tasks get no tag until Nil promotes them.

## Curation

The curator (a new agent) prepares Nil's review. For each unreviewed task, it proposes a priority, a class, and one outcome: keep, rescope (with the new scope) or obsolete (with the reason), each with one line of why. It argues against the task first: did a merge already solve it, does a current goal need it, has it been untouched for months, does a different scope fit what Nil values now.

It runs once on the whole open board (Nil wants every task reviewed again, also the ones that have a priority), and after that on each new task. When Nil's direction changes (a pilot, a launch, a trending topic), Nil tells the curator, and it proposes new priorities for the tasks the change affects.

Nil decides in the triage view of the loop app: one card per task with the proposal, made for the phone, with accept, another priority, obsolete, and an optional note. The app sends each decision to the curator, and the curator writes it to the board. Triage is in the app, not in asks, because of its volume: about 280 open tasks (2026-10-18) against a cap of 50 open asks per agent.

## Nil's attention queue

Each item that needs Nil is an ask from Isomux PM to Nil (internal-docs/asks-design.md). It waits on the Asks page until Nil replies or dismisses it. The PM creates one per item when the Lead reports it, and sends Nil's answer to the Lead verbatim.

Item kinds:

- A decision packet for a `decide` task, recommendation first.
- A `taste` branch, with screenshots.
- Copy from merged work, for sign-off.
- Push approval, when main has signed-off work that is not pushed.

An ask holds at most 4000 characters. Copy that fits goes into the ask verbatim. Longer copy goes into the copy view of the loop app (the full text, old next to new), and the ask holds a one-line summary and a link to it; ask cards render web links. Nil answers in the ask either way.

An agent has at most 50 open asks. If the queue gets near that, the PM bundles items of the same kind.

## Roles

- **Isomux PM**: Nil's only contact, as today. It owns Nil's attention queue and does every restart.
- **Curator (new agent)**: proposes the review of every unreviewed task and writes Nil's triage decisions to the board. It owns the loop app.
- **Isomux Lead (dispatcher)**: picks the next reviewed `ready` task (by priority, then age; siblings that touch the same files go to one worker), assigns it to an idle worker, receives the worker's report, sends items for Nil to the PM, and updates the state part of tags. It does not merge.
- **Main owner (new agent)**: the only agent that writes to main. It merges approved branches, runs CI, and quarantines flaky tests. It writes no other code: a failure goes back to the worker.
- **Workers and reviewers**: the existing persistent pairs (Worker N with Reviewer N), with the existing edit-token protocol. A worker takes one task (or one bundle of siblings) at a time. The worker writes the tests. When the reviewer finds a gap in them, the reviewer may write the missing test itself and does not have to ask for it.

## The loop app

One app holds the deterministic parts of the loop: the triage view, the copy view, and the tick. Later it can show the loop's status (the queue, who works on what, recent merges).

The tick: the app sends Isomux Lead one message per hour. No agent can be trusted to have reached the gate it was sent to: a usage-limit hit, a restart, an error or an interruption can stop it short. On each tick, the Lead reads the session tail of every loop agent (the workers, the reviewers and the main owner) and resumes each one that stopped short. The tick replaces the Lead's 15-minute liveness sweep.

The tick also covers the 5-hour usage window. Isomux does not resume an agent after the limit resets (checked in server/backends/claude.ts only, 2026-10-18). At the first tick after the reset, the Lead resumes the agents that the limit stopped. The pilot must test this path on purpose.

The loop runs Claude Opus on Nil's subscription and may use the whole allowance for now (Nil, 2026-10-18). Later, Nil may set a limit.

## A task's path

1. The Lead assigns a `ready` task to an idle worker: clear the worker's session, claim the task, send the brief.
2. The worker and reviewer work as they do today. The reviewer approves a commit hash.
3. A question that does not change the task's scope: the worker and reviewer decide, and the report records the choice. A question that changes the scope or the design: the worker parks the task as `[decide | nil]` with the question and a recommendation, keeps the branch, and reports. The Lead sends the packet to the PM and gives the worker its next task.
4. The worker reports to the Lead, and the Lead sends the approved hash to the main owner.
5. The main owner rebases the branch on main (or recreates the work on fresh main when the worker thinks that goes better), squashes it to one commit, formats it, and runs `bun run ci:remote` on that commit. On green, it fast-forwards main. It merges one branch at a time.
6. On red: the main owner runs CI again once. If the second run is green, the test is flaky: it quarantines the test (`test.skip` with a task id; the task to fix and re-enable it is P1) and merges. If the second run is red and the branch caused it, the branch goes back to the worker with the failing test.
7. After the merge, the Lead marks the task done.

A `taste` task stays on its branch, not merged, until Nil approves it. Copy inside an `auto` task (a docs line, a prompt string) merges, and goes into Nil's queue for sign-off before the push.

## CI

The main owner runs `ci:remote` on Nil's desktop for every merge, about 5 minutes per run (2026-10-07). The rule to run CI only at batch end came from RAM pressure on this box, and the desktop removes it. When the desktop cannot run it, `ci:remote` falls back to a local `bun run ci` (about 17 minutes) and merges slow down.

## Restarts

A running loop is never idle, so the PM's idle watcher would never fire. When merged server changes wait to go live, the Lead stops dispatching, lets each worker reach its next hand-off, and asks the PM for the restart. After the restart, the Lead resumes dispatching, and the tick catches any agent the restart stopped short.

## Setup

1. Create the curator agent and the loop app with its triage view first, so Nil can start the review before the rest exists.
2. The curator proposes a review of every open P0-P3 task; Nil goes through them in the app.
3. Add the tag rule to the Isomux room prompt.
4. Update the isomux-lead-session and isomux-manager-session skills, and write skills for the curator and the main owner.
5. Create the main owner agent, and add the copy view and the tick to the app.
6. Run a pilot. Measure: tasks merged, quarantines, items in Nil's queue, Nil's rework, allowance used, and the limit-hit path.
