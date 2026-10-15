// The "Move to room" buttons with back rooms (task 5b503e32): a room whose
// front is full still takes an agent (it goes to a back room seat), so its
// button stays enabled; only a room with a full front AND a full back room
// is disabled. No button shows an agent count.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { claudeAgent, room } =
  await import("../test-support/claude-limits-fixture.tsx");
const { BACK_ROOM_SEATS, DESK_COUNT, firstFreeBackSeat } =
  await import("../../shared/desks.ts");

const { translatorFor } = await import("../../shared/i18n/translate.ts");
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

describe("Move to room buttons", () => {
  it("enable a room with a full front and disable one with a full front and back", () => {
    const agent = claudeAgent("opus", "default", []);
    const view = render(
      onLanguage("en", <EditAgentDialog onClose={() => {}} agent={agent} />, {
        rooms: [room, frontFull, allFull],
        agents: [
          agent,
          ...fill("r2", DESK_COUNT, 0),
          ...fill("r3", DESK_COUNT, BACK_ROOM_SEATS),
        ],
        hasReceivedInitialState: true,
      }),
    );
    try {
      const button = (name: string) =>
        [...view.container.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === name,
        );
      expect(button("Front Full")?.disabled).toBe(false);
      expect(button("All Full")?.disabled).toBe(true);
    } finally {
      view.unmount();
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
