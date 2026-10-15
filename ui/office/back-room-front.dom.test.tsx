// The front view with a back room (task 5b503e32): back agents get no desk,
// the header counts only what the front draws, and the trap door carries the
// back room's attention.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, shimEmit } = fixture;
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
    topicStale: false,
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

it("counts front agents in the header and shows back agents only through the trap door", async () => {
  const view = mount([room("first")]);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [
        agent("Front", 0, "waiting_for_response"),
        agent("BackA", deskOfBackSeat({ table: 0, stool: 0 }), "thinking"),
        agent("BackB", deskOfBackSeat({ table: 0, stool: 1 }), "error"),
      ],
      rooms: [room("first")],
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const text = view.container.textContent ?? "";
  // A desk and nameplate only for the front agent; the back agents have none.
  expect(text).toContain("Front");
  expect(text).not.toContain("BackA");
  expect(text).not.toContain("BackB");
  // The header's working and error counts would come only from back agents.
  const count = (n: number, key: Parameters<typeof EN.t>[0]) =>
    new RegExp(`${n}\\s*${EN.t(key as never)}`);
  expect(text).toMatch(count(1, "office.status.waiting"));
  expect(text).not.toMatch(count(1, "office.status.working"));
  // "1 error" shows once: the trap door's badge, not a header count.
  const errorText = EN.t("office.backRoom.error", { count: 1 });
  expect(text.split(errorText)).toHaveLength(2);
  // The trap door shows, with the back room's error.
  const hatch = view.container.querySelector("[data-trap-door]");
  expect(hatch).not.toBeNull();
  expect(hatch?.getAttribute("aria-label")).toContain("2");
});
