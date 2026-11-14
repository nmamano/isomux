// The "Move to room" buttons with back rooms (tasks 5b503e32 and f0af4677):
// each room offers its front and its back room, each disabled only when that
// area is full. No button shows an agent count. Every room but the lobby has
// a back room, with no field for it (task e2fb9fa0). They are on the Agent
// settings page's Access section (task 59538509).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { claudeAgent, openSection, room, settle, viewer } =
  await import("../test-support/claude-limits-fixture.tsx");
const { BACK_ROOM_SEATS, DESK_COUNT, firstFreeBackSeat } =
  await import("../../shared/desks.ts");

const { translatorFor } = await import("../../shared/i18n/translate.ts");
// The page loads the agent's memory and checks its folder on mount.
beforeEach(() => setApiShim(async () => ({})));
afterAll(() => setApiShim(null));
const EN = translatorFor("en");

const frontFull = { ...room, id: "r2", name: "Front Full" };
const allFull = { ...room, id: "r3", name: "All Full" };

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

const backFull = { ...room, id: "r4", name: "Back Full" };

function dialog(agent: ReturnType<typeof claudeAgent>, agents: unknown[]) {
  const view = render(
    onLanguage(
      "en",
      <EditAgentDialog
        onClose={() => {}}
        agent={agent}
        initialSection="access"
      />,
      {
        rooms: [room, frontFull, allFull, backFull],
        agents: [agent, ...agents] as never,
        hasReceivedInitialState: true,
      },
    ),
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
      setApiShim(async () => ({}));
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

// Task ee577900: Move stays enabled while a save runs. A move asked for then
// (or from the prompt, before Save) waits on the discard prompt; the save
// landing closes the page AND moves the agent. A failed save keeps the
// page, the prompt and the agent where they are.
describe("a move that races a save", () => {
  for (const order of ["save first", "move first"] as const)
    for (const outcome of ["saved", "failed"] as const)
      it(`${order}, ${outcome}`, async () => {
        const held: {
          resolve: (v: unknown) => void;
          reject: (e: unknown) => void;
        }[] = [];
        const moves: unknown[] = [];
        setApiShim(async (method, path, body) => {
          if (path === "/api/validate/cwd") return { ok: true };
          if (path.startsWith("/api/memory"))
            return { text: "", version: "v1", size: 0, cap: 5000 };
          // An instructions edit: a save the page awaits.
          if (method === "PATCH" && path === "/api/agents/a1")
            return new Promise((resolve, reject) =>
              held.push({ resolve, reject }),
            );
          if (method === "POST" && path.endsWith("/move")) moves.push(body);
          return {};
        });
        let closed = 0;
        const agent = claudeAgent("opus", "default", []);
        const view = render(
          onLanguage(
            "en",
            <EditAgentDialog
              onClose={() => closed++}
              agent={agent}
              initialSection="instructions"
            />,
            {
              rooms: [room, backFull],
              agents: [agent],
              hasReceivedInitialState: true,
              sessionContext: viewer([]),
            },
          ),
        );
        try {
          await settle();
          const instructions = view.getByPlaceholderText(
            EN.t("dialogs.agent.customInstructionsPlaceholder"),
          );
          await act(async () => {
            fireEvent.change(instructions, {
              target: { value: "Answer in one line." },
            });
          });
          const save = async () => {
            await act(async () => {
              fireEvent.click(
                view.container.querySelector("[data-agent-settings-save]")!,
              );
            });
          };
          // The move buttons are on Access.
          const move = async () => {
            await openSection(view.container, "access");
            await act(async () => {
              fireEvent.click(view.getByRole("button", { name: "Back Full" }));
            });
          };
          for (const step of order === "save first"
            ? [save, move]
            : [move, save])
            await step();
          const prompt = () =>
            view.queryByText(EN.t("common.discardPrompt")) !== null;
          expect(held).toHaveLength(1);
          expect(prompt()).toBe(true);
          expect(moves).toStrictEqual([]);

          await act(async () => {
            if (outcome === "saved") held[0]!.resolve({});
            else held[0]!.reject(new ApiError(500, "internal", "disk full"));
          });
          await settle();
          await settle();
          if (outcome === "saved") {
            expect(closed).toBe(1);
            // Desk 0 is free in Back Full.
            expect(moves).toStrictEqual([{ targetRoomId: "r4", desk: 0 }]);
          } else {
            expect(view.queryByText("disk full")).not.toBeNull();
            expect(closed).toBe(0);
            expect(prompt()).toBe(true);
            expect(moves).toStrictEqual([]);
          }
        } finally {
          view.unmount();
          setApiShim(async () => ({}));
        }
      });
});
