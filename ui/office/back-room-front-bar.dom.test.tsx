// The front view with a back room: the desktop sidebar counts the office's
// working agents in its header, so while it shows, the office bar leaves out
// its own working count (task a539eaae). Split from
// ui/office/back-room-front.dom.test.tsx, which holds the trap door and the
// moves between the back room and the front, because the 5 s cap is per file;
// the header's counts are in ui/office/back-room-front-counts.dom.test.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, act, shimEmit } = fixture;
// A room as the server sends it: every room but the lobby has a back room,
// with no field for it (task e2fb9fa0).
const { room } = fixture;
const { deskOfBackSeat } = await import("../../shared/desks.ts");
fixture.setupRoomDoorTests({ decorations: false });

function agent(id: string, desk: number, state: string) {
  return {
    id,
    name: id,
    desk,
    roomId: "first",
    cwd: "~",
    state,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    topic: null,
    topicState: null,
    customInstructions: null,
    customInstructionsVersion: "0",
    permissionMode: "default",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  };
}

// The header's counts (task 0cd2807f): on the front, working takes in the
// back room's working agents, while error stays the front's; the back room's
// screen counts its own agents. Only working and error get a count, on the
// phone and the desktop alike (task 10748724): idle and stopped agents are in
// the fixture to prove they get none.
const backDesk = (stool: number) => deskOfBackSeat({ table: 0, stool });
const countedAgents = [
  agent("F0", 0, "thinking"),
  agent("F1", 1, "waiting_for_response"),
  agent("F2", 2, "error"),
  agent("F3", 3, "idle"),
  agent("B0", backDesk(0), "thinking"),
  agent("B1", backDesk(1), "tool_executing"),
  agent("B2", backDesk(2), "waiting_for_response"),
  agent("B3", backDesk(3), "error"),
  agent("B4", backDesk(4), "error"),
  agent("B5", backDesk(5), "idle"),
  agent("B6", backDesk(6), "stopped"),
];
// The desktop sidebar counts the office's working agents in its header, so
// while it shows, the office bar leaves out its own working count and keeps
// the error count, which the sidebar has no total for (task a539eaae).
it("the office bar has no working count while the sidebar shows", async () => {
  const pills = (view: ReturnType<typeof mount>) =>
    Object.fromEntries(
      [...view.container.querySelectorAll("[data-bar-count]")].map((p) => [
        p.getAttribute("data-bar-count"),
        (p.textContent ?? "").replace(/\D/g, ""),
      ]),
    );
  for (const sidebar of [false, true])
    for (const back of [false, true]) {
      fixture.setSidebarOpen(sidebar);
      fixture.setBackRoomOpen(back);
      const view = mount([room("first")]);
      await act(async () =>
        shimEmit({
          type: "full_state",
          agents: countedAgents,
          rooms: [room("first")],
          office: { name: "Back room test", prompt: null },
          recentCwds: [],
          killedAgents: [],
          interactions: [],
        } as never),
      );
      expect(fixture.snapshot.isMobile).toBe(false);
      // The screen under test is drawn.
      expect(
        view.container.querySelector('[data-back-figure="B0"]') !== null,
      ).toBe(back);
      const working = back ? "2" : "3";
      const error = back ? "2" : "1";
      expect({ sidebar, back, pills: pills(view) }).toEqual({
        sidebar,
        back,
        pills: sidebar ? { error } : { working, error },
      });
      view.unmount();
    }
});
