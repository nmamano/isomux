// The strip in a back agent's log (task 5b503e32): it names the room's front
// agents, each chip opens that agent, and it hides for a front agent and for a
// room with no front agent.
import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { AgentInfo } from "../../shared/types.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { BackRoomStrip } = await import("./BackRoomStrip.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { deskOfBackSeat } = await import("../../shared/desks.ts");

afterEach(cleanup);

const agent = (id: string, desk: number, roomId = "r1") =>
  ({
    id,
    name: id,
    desk,
    roomId,
    state: "idle",
    modelFamily: "opus",
  }) as unknown as AgentInfo;
const ROOMS = [{ id: "r1", name: "Akido", prompt: null }] as never;

function show(focused: AgentInfo, agents: AgentInfo[]) {
  const opened: string[] = [];
  const view = render(
    onLanguage(
      "en",
      <BackRoomStrip
        agent={focused}
        agents={agents}
        rooms={ROOMS}
        onOpenAgent={(id) => opened.push(id)}
      />,
    ),
  );
  const strip = () => view.container.querySelector("[data-back-room-strip]");
  return { view, opened, strip };
}

describe("BackRoomStrip", () => {
  const worker = agent("Worker", deskOfBackSeat({ table: 0, stool: 0 }));

  it("names each front agent of the room, and a chip opens that agent", () => {
    const lead = agent("Lead", 0);
    const pm = agent("PM", 1);
    const elsewhere = agent("Elsewhere", 2, "r2");
    const { strip, opened } = show(worker, [worker, pm, lead, elsewhere]);
    const chips = [...strip()!.querySelectorAll("button")];
    expect(chips.map((c) => c.textContent)).toEqual(["Lead", "PM"]);
    fireEvent.click(chips[1]);
    expect(opened).toEqual(["PM"]);
  });

  it("hides for a front agent", () => {
    const lead = agent("Lead", 0);
    expect(show(lead, [lead, worker]).strip()).toBeNull();
  });

  it("hides when the room has no front agent", () => {
    expect(show(worker, [worker]).strip()).toBeNull();
  });
});
