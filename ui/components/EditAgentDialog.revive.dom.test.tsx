// Task 5ea0e610: a button whose click does nothing is disabled. In the spawn
// dialog's Revive row, a click on any chip while one revive runs does nothing
// (handleRevive returns), so every chip is disabled until it ends, the chip
// being revived too.
// Task c3c5e709: the Revive row groups the killed agents by room (AGENTS.md
// "UI rules": an agent selector groups agents by room).
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { room, settle, viewer } =
  await import("../test-support/claude-limits-fixture.tsx");
const { setApiShim } = await import("../api.ts");

type KilledAgentSummary = import("../../shared/types.ts").KilledAgentSummary;

afterAll(() => setApiShim(null));

function killed(
  id: string,
  name: string,
  where: { id: string; name: string } = room,
  topic: string | null = null,
): KilledAgentSummary {
  return {
    id,
    name,
    agentType: "claude",
    lastRoomId: where.id,
    lastRoomName: where.name,
    topic,
    killedAt: 1,
  };
}

it("disables every Revive chip while a revive runs, the one being revived too", async () => {
  const revives: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "POST" && path.endsWith("/revive")) {
      revives.push(path);
      return new Promise(() => {}); // the revive is still running
    }
    if (path === "/api/me/rooms") return { rooms: [] };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    return {};
  });
  const view = render(
    onLanguage(
      "en",
      createElement(EditAgentDialog, {
        onClose: () => {},
        deskIndex: 0,
        roomId: room.id,
        defaultCwd: "/srv/new-agent",
        spawnAgentType: "claude",
      }),
      {
        rooms: [room],
        agents: [],
        hasReceivedInitialState: true,
        sessionContext: viewer([]),
        killedAgents: [killed("k1", "Alpha"), killed("k2", "Beta")],
      },
    ),
  );
  try {
    await settle();
    const chips = () => [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        ".agent-restore-section button",
      ),
    ];
    expect(chips().length).toBe(2);
    expect(chips().map((c) => c.disabled)).toEqual([false, false]);
    await act(async () => {
      fireEvent.click(chips()[0]);
    });
    await settle();
    // The click started the revive of the first chip.
    expect(revives).toEqual(["/api/agents/k1/revive"]);
    expect(chips().map((c) => c.disabled)).toEqual([true, true]);
  } finally {
    view.unmount();
  }
});

it("groups the Revive chips by room: office order, current room names, deleted rooms last", async () => {
  setApiShim(async (_method, path) => {
    if (path === "/api/me/rooms") return { rooms: [] };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    return {};
  });
  const lab = { ...room, id: "r2", name: "Lab" };
  const view = render(
    onLanguage(
      "en",
      createElement(EditAgentDialog, {
        onClose: () => {},
        deskIndex: 0,
        roomId: room.id,
        defaultCwd: "/srv/new-agent",
        spawnAgentType: "claude",
      }),
      {
        // Office order: Lab before Studio, which the killed list does not follow.
        rooms: [lab, room],
        agents: [],
        hasReceivedInitialState: true,
        sessionContext: viewer([]),
        // Newest killed first. Studio was called Old Studio when k1 was killed;
        // r9 is a deleted room.
        killedAgents: [
          killed("k1", "Alpha", { id: room.id, name: "Old Studio" }, "Fix it"),
          killed("k2", "Beta", { id: "r9", name: "Gone" }),
          killed("k3", "Gamma", lab),
          killed("k4", "Delta", room),
        ],
      },
    ),
  );
  try {
    await settle();
    const rows = [
      ...view.container.querySelectorAll<HTMLElement>(
        ".agent-restore-section [data-revive-group]",
      ),
    ].map((row) => {
      const label = row.cloneNode(true) as HTMLElement;
      for (const chip of label.querySelectorAll("button")) chip.remove();
      return [
        row.dataset.reviveGroup,
        label.textContent?.trim(),
        [...row.querySelectorAll("button")].map((chip) => chip.textContent),
      ];
    });
    expect(rows).toEqual([
      ["r2", "Lab", ["Gamma"]],
      ["r1", "Studio", ["Alpha", "Delta"]],
      ["r9", "Gone", ["Beta"]],
    ]);
    // The room shows on the row, so a chip's hover title is its topic only.
    const chip = (name: string) =>
      [
        ...view.container.querySelectorAll<HTMLButtonElement>(
          ".agent-restore-section button",
        ),
      ].find((c) => c.textContent === name)!;
    expect(chip("Alpha").title).toBe("Fix it");
    expect(chip("Delta").hasAttribute("title")).toBe(false);
  } finally {
    view.unmount();
  }
});
