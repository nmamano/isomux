// The front view with a back room: the header's working count takes in the
// back room (task 0cd2807f), on the phone and the desktop. Split from
// ui/office/back-room-front.dom.test.tsx, which holds the trap door and the
// moves between the back room and the front, because the 5 s cap is per file;
// the office bar's counts beside the sidebar are in
// ui/office/back-room-front-bar.dom.test.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, act, shimEmit } = fixture;
// A room as the server sends it: every room but the lobby has a back room,
// with no field for it (task e2fb9fa0).
const { room } = fixture;
const { deskOfBackSeat } = await import("../../shared/desks.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const EN = translatorFor("en");
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
// Each count is a dot followed by "<n> <label>".
function headerCounts(container: HTMLElement) {
  return [...container.querySelectorAll("div")]
    .filter(
      (d) =>
        d.firstElementChild?.tagName === "SPAN" &&
        d.firstElementChild.textContent === "" &&
        d.children.length === 1 &&
        /^\d+ \S/.test(d.textContent ?? ""),
    )
    .map((d) => d.textContent);
}
const chip = (n: number, key: Parameters<typeof EN.t>[0]) =>
  `${n} ${EN.t(key as never)}`;
const headerCases: { screen: string; mobile: boolean; want: string[] }[] = [
  {
    screen: "front",
    mobile: false,
    want: [chip(3, "office.status.working"), chip(1, "office.status.error")],
  },
  {
    screen: "back",
    mobile: false,
    want: [chip(2, "office.status.working"), chip(2, "office.status.error")],
  },
  {
    screen: "front",
    mobile: true,
    want: [chip(3, "office.status.working"), chip(1, "office.status.errShort")],
  },
  {
    screen: "back",
    mobile: true,
    want: [chip(2, "office.status.working"), chip(2, "office.status.errShort")],
  },
];
it.each(headerCases)(
  "the $screen header counts (phone: $mobile)",
  async ({ screen, mobile, want }) => {
    fixture.setBackRoomOpen(screen === "back");
    const view = mount([room("first")]);
    await act(async () => {
      fixture.dispatch({ type: "set_mobile", isMobile: mobile });
    });
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
    // The screen under test is drawn: front desks or back figures.
    const text = view.container.textContent ?? "";
    if (screen === "front") {
      expect(text).toContain("F0");
      expect(view.container.querySelector("[data-back-figure]")).toBeNull();
    } else {
      expect(
        view.container.querySelector('[data-back-figure="B0"]'),
      ).not.toBeNull();
    }
    expect(fixture.snapshot.isMobile).toBe(mobile);
    expect(headerCounts(view.container)).toEqual(want);
  },
);
