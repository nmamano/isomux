// The refused card's Run (task 0faacc4e): Run command opens a confirm that
// shows the exact command; only its Run sends the run, once. The run's end is
// a system entry that shows how it went.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type LogEntry = import("../../shared/types.ts").LogEntry;

const COMMAND = "rm -rf ./build";

function bashCall(toolId: string, command: string): LogEntry {
  return {
    id: `call-${toolId}`,
    agentId: "a1",
    timestamp: 1,
    kind: "tool_call",
    content: "Bash",
    metadata: { toolId, input: { command } },
  };
}

function denialEntry(toolUseId: string): LogEntry {
  return {
    id: `denied-${toolUseId}`,
    agentId: "a1",
    timestamp: 2,
    kind: "system",
    content: "Bash was refused",
    metadata: {
      permissionDenied: {
        toolUseId,
        toolName: "Bash",
        message: "refused",
        decisionReason: "rm -rf is destructive",
      },
    },
  };
}

type Run = (toolUseId: string, command: string) => Promise<void>;

function renderCard(
  opts: { command?: string; onRun?: Run; turnEntries?: LogEntry[] } = {},
) {
  const command = opts.command ?? COMMAND;
  return render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={denialEntry("toolu-1")}
        turnEntries={opts.turnEntries ?? [bashCall("toolu-1", command)]}
        onRunDeniedCommand={opts.onRun}
      />,
    ),
  );
}

const q = (view: ReturnType<typeof renderCard>, action: string) =>
  view.container.querySelectorAll<HTMLButtonElement>(
    `button[data-denied-run="${action}"]`,
  );

function recorder(result: () => Promise<void> = () => Promise.resolve()) {
  const calls: Array<[string, string]> = [];
  const run: Run = (toolUseId, command) => {
    calls.push([toolUseId, command]);
    return result();
  };
  return { calls, run };
}

it("shows Run command, and no confirm until it is pressed", () => {
  const r = recorder();
  const view = renderCard({ onRun: r.run });
  expect(q(view, "open").length).toBe(1);
  expect(q(view, "confirm").length).toBe(0);
  expect(q(view, "cancel").length).toBe(0);
  view.unmount();
});

it("Run command opens a confirm with the exact command; nothing runs yet", () => {
  const r = recorder();
  const command = "rm -rf /tmp/t-1/a  'two  spaces'";
  const view = renderCard({ onRun: r.run, command });
  fireEvent.click(q(view, "open")[0]);
  expect(q(view, "confirm").length).toBe(1);
  expect(q(view, "cancel").length).toBe(1);
  // The command as it will run, in one element, spaces kept.
  const shown = [...view.container.querySelectorAll("*")].filter(
    (el) => el.children.length === 0 && el.textContent === command,
  );
  expect(shown.length).toBe(1);
  expect(r.calls.length).toBe(0);
  view.unmount();
});

it("Cancel closes the confirm and runs nothing", () => {
  const r = recorder();
  const view = renderCard({ onRun: r.run });
  fireEvent.click(q(view, "open")[0]);
  fireEvent.click(q(view, "cancel")[0]);
  expect(q(view, "confirm").length).toBe(0);
  expect(q(view, "open").length).toBe(1);
  expect(r.calls.length).toBe(0);
  view.unmount();
});

it("the confirm's Run sends the denial's id and the command, once", async () => {
  let finish = () => {};
  const r = recorder(() => new Promise<void>((resolve) => (finish = resolve)));
  const view = renderCard({ onRun: r.run });
  fireEvent.click(q(view, "open")[0]);
  const confirm = q(view, "confirm")[0];
  fireEvent.click(confirm);
  // A second press while the first is on its way sends nothing more.
  if (q(view, "confirm").length > 0) fireEvent.click(q(view, "confirm")[0]);
  expect(r.calls).toEqual([["toolu-1", COMMAND]]);
  await act(async () => finish());
  view.unmount();
});

it("a refused run says why, and Run command can be pressed again", async () => {
  const r = recorder(() =>
    Promise.reject(new Error("You cannot use this agent's terminal.")),
  );
  const view = renderCard({ onRun: r.run });
  fireEvent.click(q(view, "open")[0]);
  await act(async () => {
    fireEvent.click(q(view, "confirm")[0]);
  });
  expect(view.container.textContent).toContain(
    "You cannot use this agent's terminal.",
  );
  expect(q(view, "open").length).toBe(1);
  view.unmount();
});

it("has no Run command without the Run, or for a command it cannot run", () => {
  const r = recorder();
  for (const view of [
    renderCard({}),
    renderCard({ onRun: r.run, command: "cd /x\nrm -rf y" }),
    renderCard({ onRun: r.run, turnEntries: [] }),
    // The server refuses a command that hides text, so the card has no Run.
    renderCard({ onRun: r.run, command: "ls \u001b[8mrm -rf ~\u001b[0m" }),
  ]) {
    expect(q(view, "open").length).toBe(0);
    view.unmount();
  }
});

it("shows the run's end as the ask Run's result", () => {
  const view = render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "ran",
          agentId: "a1",
          timestamp: 3,
          kind: "system",
          content: `pat ran the refused command ${COMMAND}: exit 0`,
          metadata: {
            deniedCommandRun: {
              command: COMMAND,
              by: "u1",
              startedAt: 1,
              state: "done",
              exitCode: 0,
              signal: null,
              durationMs: 1200,
              output: "removed 3 files\n",
            },
          },
        }}
      />,
    ),
  );
  const result = view.container.querySelectorAll("[data-ask-run-result]");
  expect(result.length).toBe(1);
  expect(result[0].getAttribute("data-state")).toBe("done");
  expect(result[0].textContent).toContain("removed 3 files");
  view.unmount();
});
