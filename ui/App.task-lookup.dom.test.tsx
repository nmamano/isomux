// Task chips for tasks the store does not hold (task 9ebe887d), through the
// real App and store. The tasks frame holds only the open and in-progress
// tasks, so an id in chat text that names a closed task is read with GET
// /api/tasks?ids=, in one batch, before it is tried as an ask: a closed task's
// id must not cost a GET /api/asks/<id>. The Tasks view's own reads are in
// ui/components/TaskView.summary.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  ask,
  askReads,
  boot,
  inboxButton,
  openFullChat,
  setAsks,
  setExtraApi,
  setTaskBoard,
  setUpInboxTests,
  taskGets,
} = await import("./test-support/inbox-fixture.tsx");
const { subscribeTaskLookup } = await import("./task-lookup.ts");
type View = import("./test-support/inbox-fixture.tsx").View;
type TaskItem = import("../shared/types.ts").TaskItem;

setUpInboxTests();

const closed = (id: string, status: "done" | "obsolete"): TaskItem => ({
  id,
  title: `Closed task ${id}`,
  description: `About ${id}`,
  status,
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
  version: `v-${id}`,
});
const DONE = closed("0000dead", "done");
const OBSOLETE = closed("0000beef", "obsolete");
// An id that is no task: after the task lookup misses, it is tried as an ask.
const OTHER = "0000cafe";

async function settle() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

// The summary frame of an office with no open task.
async function emitSummaryFrame() {
  await act(async () =>
    shimEmit({ type: "tasks", tasks: [], summary: true } as never),
  );
  await settle();
}

const taskChip = (root: ParentNode, id: string) =>
  root.querySelector<HTMLButtonElement>(
    `button.task-id-chip[data-task-id="${id}"]`,
  );
const idsRead = () => taskGets.flatMap((g) => g.ids ?? []);

it("an ask prompt that names closed tasks reads them in one batch and chips them; only the id that is no task is tried as an ask", async () => {
  setTaskBoard([DONE, OBSOLETE]);
  setAsks([
    {
      ...ask("b7c8d9e0", "a1"),
      prompt: `Close ${DONE.id} and ${OBSOLETE.id}, then ${OTHER}?`,
    },
  ]);
  const view = await boot("/inbox/asks");
  await emitSummaryFrame();
  const card = view.container.querySelector('[data-ask="b7c8d9e0"]')!;
  expect(card).not.toBeNull();
  expect(taskChip(card, DONE.id)).not.toBeNull();
  expect(taskChip(card, OBSOLETE.id)).not.toBeNull();
  expect(taskChip(card, DONE.id)!.getAttribute("title")).toBe(DONE.title);
  // One read for the three ids, each id once, and no status list.
  const lookups = taskGets.filter((g) => g.ids !== null);
  expect(lookups).toHaveLength(1);
  expect([...lookups[0].ids!].sort()).toEqual(
    [DONE.id, OBSOLETE.id, OTHER].sort(),
  );
  expect(askReads).toEqual([OTHER]);
});

it("a chat that names a closed task chips it after the lookup, and draws it again after a new tasks frame", async () => {
  setTaskBoard([DONE]);
  setAsks([ask("q1", "a1")]);
  const view: View = await boot();
  await emitSummaryFrame();
  await act(async () => fireEvent.click(inboxButton(view)!));
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-agent="a1"]',
  );
  await act(async () => fireEvent.click(name!));
  await openFullChat(view);
  await act(async () =>
    shimEmit({
      type: "log_entry",
      entry: {
        id: "e1",
        agentId: "a1",
        kind: "text",
        content: `Finished ${DONE.id} yesterday.`,
        timestamp: 1_000,
      },
    } as never),
  );
  await settle();
  expect(taskChip(view.container, DONE.id)).not.toBeNull();
  expect(idsRead().filter((id) => id === DONE.id)).toHaveLength(1);
  expect(askReads).toEqual([]);

  // A reconnect: the closed row leaves the store with the new frame, and the
  // chip on screen is read again rather than turning into plain text.
  await emitSummaryFrame();
  expect(taskChip(view.container, DONE.id)).not.toBeNull();
  expect(idsRead().filter((id) => id === DONE.id)).toHaveLength(2);
  expect(askReads).toEqual([]);
});

// On a slow link a lookup can take seconds. While it is in flight the page
// must stay still: no request again, no change told to the chips. A render
// loop here (a lookup that tells its listeners although nothing changed, and
// a chip that asks again on each tell) keeps act() from settling, so this
// case then ends on its timeout rather than on an assertion.
it("while a lookup is in flight, nothing is asked again and nothing re-renders", async () => {
  let reads = 0;
  setExtraApi((method, path) =>
    method === "GET" && path.startsWith("/api/tasks")
      ? (reads++, new Promise(() => {}))
      : undefined,
  );
  setAsks([{ ...ask("b7c8d9e0", "a1"), prompt: `Close ${DONE.id}?` }]);
  await boot("/inbox/asks");
  await emitSummaryFrame();
  // Enabling condition: the lookup was sent and has not answered.
  expect(reads).toBe(1);
  let told = 0;
  const unsubscribe = subscribeTaskLookup(() => told++);
  await settle();
  unsubscribe();
  expect(told).toBe(0);
  expect(reads).toBe(1);
  expect(askReads).toEqual([]);
});
