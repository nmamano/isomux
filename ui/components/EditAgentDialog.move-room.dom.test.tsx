// The "Move to room" buttons with back rooms (tasks 5b503e32 and f0af4677):
// each room offers its front and its back room, each disabled only when that
// area is full. No button shows an agent count. A room with its back room
// setting off offers its front only (task b16f1e6a).
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { claudeAgent, room } =
  await import("../test-support/claude-limits-fixture.tsx");
const { BACK_ROOM_SEATS, DESK_COUNT, firstFreeBackSeat } =
  await import("../../shared/desks.ts");

const { translatorFor } = await import("../../shared/i18n/translate.ts");
const EN = translatorFor("en");

// The fixture's room, with the back room on, as every room below but Off.
const own = { ...room, backRoom: true };
const frontFull = { ...own, id: "r2", name: "Front Full" };
const allFull = { ...own, id: "r3", name: "All Full" };
const off = { ...room, id: "r5", name: "Off", backRoom: false };

function fill(roomId: string, front: number, back: number) {
  const base = claudeAgent("opus", "default", []);
  const out = [];
  for (let i = 0; i < front; i++)
    out.push({ ...base, id: `${roomId}-f${i}`, roomId, desk: i });
  const taken: number[] = [];
  for (let i = 0; i < back; i++) {
    const desk = firstFreeBackSeat(taken)!;
    taken.push(desk);
    out.push({ ...base, id: `${roomId}-b${i}`, roomId, desk });
  }
  return out;
}

const backFull = { ...own, id: "r4", name: "Back Full" };

function dialog(
  agent: ReturnType<typeof claudeAgent>,
  agents: unknown[],
  ownRoom: typeof room & { backRoom?: boolean } = own,
) {
  const view = render(
    onLanguage("en", <EditAgentDialog onClose={() => {}} agent={agent} />, {
      rooms: [ownRoom, frontFull, allFull, backFull, off],
      agents: [agent, ...agents] as never,
      hasReceivedInitialState: true,
    }),
  );
  const buttons = [...view.container.querySelectorAll("button")];
  const front = (name: string) =>
    buttons.find((b) => b.textContent?.trim() === name);
  const back = (name: string) =>
    buttons.find(
      (b) =>
        b.getAttribute("aria-label") ===
        EN.t("dialogs.agent.moveToBackOf", { room: name }),
    );
  return { view, front, back };
}

describe("Move to room buttons", () => {
  it("offer each room's front and back room, each disabled only when full", () => {
    const { view, front, back } = dialog(claudeAgent("opus", "default", []), [
      ...fill("r2", DESK_COUNT, 0),
      ...fill("r3", DESK_COUNT, BACK_ROOM_SEATS),
      ...fill("r4", 0, BACK_ROOM_SEATS),
    ]);
    try {
      expect(front("Front Full")?.disabled).toBe(true);
      expect(back("Front Full")?.disabled).toBe(false);
      expect(front("All Full")?.disabled).toBe(true);
      expect(back("All Full")?.disabled).toBe(true);
      expect(front("Back Full")?.disabled).toBe(false);
      expect(back("Back Full")?.disabled).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("offer only the front of a room with the setting off, and not the agent's own such room", () => {
    const { view, front, back } = dialog(claudeAgent("opus", "default", []), [
      ...fill("r2", DESK_COUNT, 0),
    ]);
    try {
      expect(front("Off")?.disabled).toBe(false);
      expect(back("Off")).toBeUndefined();
      expect(back("Front Full")).toBeDefined();
    } finally {
      view.unmount();
    }
    const ownOff = dialog(claudeAgent("opus", "default", []), [], {
      ...room,
      backRoom: false,
    });
    try {
      expect(ownOff.front(room.name)).toBeUndefined();
      expect(ownOff.back(room.name)).toBeUndefined();
      expect(ownOff.front("Off")).toBeDefined();
    } finally {
      ownOff.view.unmount();
    }
  });

  it("offer the agent's own room only in the area it is not in", () => {
    const agent = claudeAgent("opus", "default", []);
    const atFront = dialog(agent, []);
    try {
      expect(atFront.front(room.name)?.disabled).toBe(true);
      expect(atFront.back(room.name)?.disabled).toBe(false);
    } finally {
      atFront.view.unmount();
    }
    const atBack = dialog({ ...agent, desk: firstFreeBackSeat([])! }, []);
    try {
      expect(atBack.front(room.name)?.disabled).toBe(false);
      expect(atBack.back(room.name)?.disabled).toBe(true);
    } finally {
      atBack.view.unmount();
    }
  });

  it("send a free front desk for the front and desk null for the back room", async () => {
    const bodies: unknown[] = [];
    setApiShim(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/move")) bodies.push(body);
      return {};
    });
    try {
      // Desks 0 and 1 of "Back Full" are taken: the front button sends desk 2.
      const one = dialog(claudeAgent("opus", "default", []), fill("r4", 2, 0));
      one.front("Back Full")!.click();
      one.view.unmount();
      const two = dialog(claudeAgent("opus", "default", []), []);
      two.back("Front Full")!.click();
      two.view.unmount();
      await new Promise((r) => setTimeout(r, 0));
      expect(bodies).toEqual([
        { targetRoomId: "r4", desk: 2 },
        { targetRoomId: "r2", desk: null },
      ]);
    } finally {
      setApiShim(null);
    }
  });

  it("names a back agent's place as the back room, not a desk number", () => {
    const agent = {
      ...claudeAgent("opus", "default", []),
      desk: firstFreeBackSeat([])!,
    };
    const view = render(
      onLanguage("en", <EditAgentDialog onClose={() => {}} agent={agent} />, {
        rooms: [room],
        agents: [agent],
        hasReceivedInitialState: true,
      }),
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain(EN.t("dialogs.agent.backRoom"));
      expect(text).not.toContain(
        EN.t("dialogs.agent.desk", { desk: agent.desk + 1 }),
      );
    } finally {
      view.unmount();
    }
  });
});
