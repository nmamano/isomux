# Continuous loop

Board task 178dbb5a. Updated to Nil's rulings of 2026-10-18. The skills named below hold the steps; this doc holds the design.

## Goal

Agents work the Isomux room's backlog without Nil present, for as long as reviewed `ready` tasks remain. When a task needs Nil, the loop puts it in Nil's queue in the loop app and takes the next task. Nil goes through the queue at his own pace. Nothing in the loop waits on a clock or a deadline.

## What Nil owns

- Design go/no-go: the `decide` tasks.
- Sign-off of copy and of changes a user can see, before the push.
- The push.

Merges into local main need no approval from Nil. Inside a task, the worker and reviewer make the smaller choices and record them in the hand-off. Nil sees them at sign-off, and a wrong choice gets redone.

## What the loop picks

Credits are limited, so the loop works only on what Nil wants now. The priority field is the queue: the loop app takes P0 first, then P1 down to P3, the oldest first within a priority, and never P4.

The loop picks only tasks that Nil has reviewed. Agents set a priority when they file, so a priority alone does not show Nil's intent. Nil's review sets the priority and the class tag. A task without a tag is unreviewed, and the loop never picks it.

When the queue has no reviewed `ready` task, the loop stops. Idle credits cost nothing; credits spent on work Nil did not choose are waste.

## Task tags

Each open task in the room has a title prefix `[<class> | <state>]`.

Class:

- `auto`: the loop can do it from start to finish.
- `decide`: needs Nil's design call, or a choice between drafts. The loop researches it and sends a decision packet. It does not implement before Nil chooses.
- `hold` (label "On hold"): the loop never touches it (Stripe, Hosted, customers, secrets, releases, logins).

The class `taste` is gone: copy and looks merge and are signed off before the push, and a choice between drafts is `decide`.

State: `ready` when an agent can take the task now. Otherwise a short reason for the wait, for example `nil`, `merging`, `after <task id>`. The list of reasons is open.

Rules:

- A class and a priority come only from Nil's decisions. Agents file tasks without a tag.
- One exception: a worker may raise its own task from `auto` to `decide`, never the reverse.
- Only Nil's words move a task from `nil` to `ready`.
- P4 (backlog) tasks get no tag until Nil promotes them.

## Curation

Isomux Curator (isomux-curator skill) sits at a front desk, and Nil talks to it about what the loop picks and how tasks rank. For each unreviewed task, it proposes a priority, a class and an outcome (keep or obsolete), with one line of why. A keep can carry a new title or scope. It argues against the task first. It reviewed the whole open board once and then reviews each new task; when Nil's direction changes, it proposes new priorities for the tasks the change affects. It writes Nil's decisions to the board.

## Nil's queue: the loop app

The loop app is Nil's only queue for loop work. It has no asks and no relay through Isomux PM. Made for the phone, it holds three kinds of item:

- Triage cards: the curator's proposal for a task, with accept, another priority, obsolete, and an optional note. The curator applies the note with judgement: the note says how much of the task to rewrite.
- Decision packets from workers: the question, 2 to 4 options with exactly one recommended, a markdown body, and images (screenshots of a prototype, diagrams). Nil taps an option, obsolete, research more, or "none: see note".
- The Sign-off tab: copy changes (old next to new) and screenshots from merged work. Its "Approve and push" button sends Isomux Main the push go.

The app sends each triage and packet decision to the curator, which writes it to the board. A chosen packet option makes the task `[auto | ready]`; research more makes it `[decide | ready]`. An item that Nil rejects at sign-off is reverted by Isomux Main, and its task goes back to `ready` with Nil's note.

## Roles

The board is the loop's only state.

- **Isomux Curator**: the front desk for the loop (above). It owns the loop app.
- **Isomux PM** (isomux-manager-session skill): restarts, errands and escalations. It is not in the path of loop work.
- **Isomux Main** (isomux-main skill): the only agent that writes to main. It merges approved branches after CI, quarantines flaky tests, pushes on Nil's go, and reverts what he rejects. It writes no feature code.
- **Workers and reviewers 1-2** (isomux-loop-worker and isomux-loop-review skills): two persistent pairs, Worker N with Reviewer N, under the edit-token protocol. Two pairs, not six, because the loop runs around the clock and fewer parallel tasks mean fewer merge conflicts. The app's worker setting raises the number when the ready queue grows while the allowance has room.
- **Isomux Ad-hoc Worker** (isomux-adhoc skill): errands from the PM outside the loop. Its code also merges through Isomux Main.

Isomux Lead and Workers and Reviewers 3-6 are killed. The PM revives them for a batch that Nil asks for (isomux-lead-session skill).

Automatic handoff is on for all loop agents, so a full context continues in a fresh session. Workers, reviewers and Isomux Main also start fresh at the start of each task, and Main again when its merge queue is empty.

## The loop app's engine

Dispatch: every 2 minutes the app gives the oldest highest-priority `[auto|decide | ready]` task with no assignee to a free worker. It sets the assignee and messages the worker.

The tick: once an hour the app messages each worker that holds a task, and Isomux Main when tasks wait to merge. A usage-limit hit, a restart, an error or an interruption can stop an agent short of its gate; the tick makes it check where it stands and continue. Isomux also resumes an agent that a usage limit stopped about a minute after the window resets (task a254f3f3).

The loop runs Claude Opus on Nil's subscription and may use the whole allowance for now.

## A task's path

1. The app assigns a `ready` task to a free worker.
2. The worker and its reviewer agree the design first.
3. `auto`: if the design adds types or functions, the worker commits them as stubs. The reviewer writes the tests, shows they fail on today's code, and commits them. The worker writes the code and no tests; a missing case goes back to the reviewer. The isomux-test-audit skill is the bar for every test. The reviewer approves a commit hash.
4. `decide`: the worker researches the question, builds a prototype or a drawing where a picture helps, and sends a packet to the app. The task parks as `[decide | nil]` with the branch kept, and comes back to the queue as a card. It produces no merge.
5. A question that changes an `auto` task's scope or design turns it into `decide` (step 4).
6. The worker hands the approved hash to Isomux Main and sets the state to `merging`. If the diff changes copy or what a user sees, the worker also files a sign-off item in the app.
7. Isomux Main rebases the branch on main, squashes it to one commit, formats it and runs CI on that commit. On green, it fast-forwards main and marks the task done. It merges one branch at a time.
8. On red, Main runs CI again once. Green the second time: it quarantines the flaky test (`test.skip` with a P1 task to fix it) and merges. Red again because of the branch: the task goes back to `ready` with a note, and a free worker continues on the kept branch.

Follow-ups: one task must not spawn many. A small fix in the task's area (a stale comment, a wrong file list, a test the change made weak, dead code it exposed) is done in that task. A new task is only for a defect outside the scope or a question for Nil, and only after a board search finds no open task that covers it.

## CI

Isomux Main runs `ci:remote` on Nil's desktop for every merge, about 5 minutes per run (2026-10-07). When the desktop cannot run it, `ci:remote` falls back to a local `bun run ci` (about 17 minutes) and merges slow down.

The cronjob "Isomux nightly live tests" runs `test:live`, `test:opencode` and `test:systemd` on main every night at 03:00 PT. CI skips these suites, which an environment variable turns on.

## Restarts

When merged server changes wait to go live, Isomux Main tells the PM. The PM pauses dispatch in the app, restarts once the office is idle, and resumes dispatch. The tick catches any agent the restart stopped short.

## Status (2026-10-19)

Running: the curator, the triage view, dispatch, the tick, Isomux Main, and Workers and Reviewers 1-2. Not yet in the app code: decision packets and the Sign-off tab. Next: a pilot that measures tasks merged, quarantines, items in Nil's queue, Nil's rework, allowance used, and the usage-limit path, which the pilot must test on purpose.
