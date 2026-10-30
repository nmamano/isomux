// Shared fixture for the back room screen's DOM tests: back agents seated
// in the order firstFreeBackSeat fills the room, and the screen rendered with
// recording callbacks. Import it after setUpDomTestFile().
const { render } = await import("@testing-library/react");
const { BackRoomScreen } =
  await import("../office/back-room/BackRoomScreen.tsx");
const { onLanguage } = await import("./language-fixture.tsx");
const { firstFreeBackSeat } = await import("../../shared/desks.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

const OUTFIT = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short",
  skin: "#FFD5B8",
  beard: "none",
  accessory: null,
  hat: "none",
};

export function backAgents(n: number) {
  const taken: number[] = [];
  return Array.from({ length: n }, (_, i) => {
    const desk = firstFreeBackSeat(taken)!;
    taken.push(desk);
    return {
      id: `w${i}`,
      name: `W${i}`,
      desk,
      roomId: "r1",
      state: "idle",
      outfit: OUTFIT,
      pendingPrompt: null,
    } as unknown as AgentInfo;
  });
}

export function screenFor(
  agents: ReturnType<typeof backAgents>,
  unread = new Set<string>(),
  frontFull = false,
  askCounts?: ReadonlyMap<string, number>,
  calls: string[] = [],
) {
  return onLanguage(
    "en",
    <BackRoomScreen
      roomName="Studio"
      agents={agents}
      needsAttention={unread}
      askCounts={askCounts}
      isMobile={false}
      onBack={() => calls.push("back")}
      onSpawn={() => calls.push("spawn")}
      onOpenAgent={(id) => calls.push(`open:${id}`)}
      onContextMenu={(_x, _y, a) => calls.push(`menu:${a.id}`)}
      frontFull={frontFull}
      onDropToFront={(a) => calls.push(`front:${a.id}`)}
    />,
  );
}

export function show(
  agents: ReturnType<typeof backAgents>,
  unread = new Set<string>(),
  frontFull = false,
  askCounts?: ReadonlyMap<string, number>,
) {
  const calls: string[] = [];
  const view = render(screenFor(agents, unread, frontFull, askCounts, calls));
  return { view, calls };
}

export const figures = (el: HTMLElement) => [
  ...el.querySelectorAll("[data-back-figure]"),
];
