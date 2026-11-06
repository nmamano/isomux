// The Asks view's pure decisions (ui/components/AsksView.tsx): the order of
// the grouped ask runs in each sort and each direction (task 452cf482), asc
// and desc as one contract per sort, since the desc side is the asc side with
// its main key reversed - and never a naive comparator reverse: what a key
// does not place still stays last on both sides. The select's wiring and the
// direction's storage have their own owners: the AsksView.*.dom tests and the
// "asks sort direction" describe in ui/device-settings.test.ts.
// The asks with no agent (an office or app page) are runs of their own, by
// their source's name, in the same orders (task dcb409d4).
//
// Pure T0: no DOM, no server, no LLM.

import { describe, it, expect } from "bun:test";
import { askGroups, type AskFilter } from "./AsksView.tsx";
import type { AsksSort, AsksSortDir } from "../device-settings.ts";
import { FILTER_PRIORITIES } from "../task-priority.ts";
import type {
  AgentInfo,
  AskMemberWire,
  TaskPriority,
} from "../../shared/types.ts";

type Group = ReturnType<typeof askGroups>[number];
const head = (g: Group) => (g.agent === null ? `src:${g.source}` : g.agent.id);
const idsOf = (gs: Group[]) => gs.map(head);
const cardsOf = (g: Group) => g.entries.map((e) => e.id).join(",");
const order = (gs: Group[]) => gs.map((g) => `${head(g)}:${cardsOf(g)}`);

const SEC = 60_000;
const AGE = (ageMin: number) => 1_700_000_000_000 - ageMin * SEC;
const theAsk = (
  id: string,
  agentId: string,
  ageMin: number,
  priority?: TaskPriority,
): AskMemberWire => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: AGE(ageMin),
  updatedAt: AGE(ageMin),
  ...(priority ? { priority } : {}),
});

const ROOMS = [
  { id: "r2", name: "Room Two" },
  { id: "r1", name: "Room One" },
];
const AGENTS: AgentInfo[] = [
  { id: "a1", name: "Scout", roomId: "r1" },
  { id: "a2", name: "Ranger", roomId: "r2" },
  { id: "a3", name: "Pathfinder", roomId: "r1" },
  { id: "a4", name: "Tracker", roomId: "r2" },
  { id: "ea", name: "Extra", roomId: "rAbsent" },
] as AgentInfo[];
// Both sides of each flip case sit on one page: the roomless agent `ea`
// (not in ROOMS) holds the no-priority ask `ea`, so the room sort and the
// priority sort must keep that group last on both sides.
const ASKS: AskMemberWire[] = [
  theAsk("a1old", "a1", 100, "P2"),
  theAsk("a1top", "a1", 5, "P0"),
  theAsk("a2only", "a2", 60),
  theAsk("a3p1", "a3", 30, "P1"),
  theAsk("a4p1", "a4", 10, "P1"),
  theAsk("a4none", "a4", 200),
  theAsk("ea", "ea", 15),
];
const all = (): AskFilter => ({
  hiddenRooms: new Set(),
  hiddenAgents: new Set(),
  priorities: FILTER_PRIORITIES,
});
const sorted = (asks: AskMemberWire[], sort: AsksSort, dir: AsksSortDir) =>
  order(askGroups(asks, AGENTS, ROOMS, all(), sort, dir));

describe("askGroups direction (task 452cf482)", () => {
  // The agent sort keys runs by age: asc leads each run with its oldest
  // card, desc with its newest. Both sides of the agent-id run tie are met
  // by the head-heavy fixture a1 and a2 below.
  it("agent sort: runs by the flipped age of their lead, cards flipped inside a run, the agent-id tie unchanged", () => {
    expect(sorted(ASKS, "agent", "asc")).toEqual([
      "a4:a4none,a4p1",
      "a1:a1old,a1top",
      "a2:a2only",
      "a3:a3p1",
      "ea:ea",
    ]);
    // No roomless-last rule here: that rule is the room sort's main key, and
    // the agent sort places every run by age, `ea` by its 15 minutes.
    expect(sorted(ASKS, "agent", "desc")).toEqual([
      "a1:a1top,a1old",
      "a4:a4p1,a4none",
      "ea:ea",
      "a3:a3p1",
      "a2:a2only",
    ]);
    // Two runs whose leads share a birth: the agent-id tie order stands on
    // both sides.
    expect(
      idsOf(
        askGroups(
          [theAsk("t1", "a1", 40), theAsk("t2", "a2", 40)],
          AGENTS,
          ROOMS,
          all(),
          "agent",
          "asc",
        ),
      ),
    ).toEqual(["a1", "a2"]);
    expect(
      idsOf(
        askGroups(
          [theAsk("t1", "a1", 40), theAsk("t2", "a2", 40)],
          AGENTS,
          ROOMS,
          all(),
          "agent",
          "desc",
        ),
      ),
    ).toEqual(["a1", "a2"]);
  });

  it("age sort: the flat list runs backwards exactly, the ask-id tie-break backwards too", () => {
    const age = (id: string, agentId: string, ageMin: number) =>
      theAsk(id, agentId, ageMin);
    // A priority on a stand-in is inert: under "age" only the birth time and
    // the ask id place a card.
    const one = [
      age("a4old", "a4", 200),
      age("a1mid", "a1", 100),
      age("a2solo", "a2", 60),
      age("a3p1", "a3", 30),
      age("a4new", "a4", 10),
      age("a1top", "a1", 5),
    ];
    expect(sorted(one, "age", "asc")).toEqual([
      "a4:a4old",
      "a1:a1mid",
      "a2:a2solo",
      "a3:a3p1",
      "a4:a4new",
      "a1:a1top",
    ]);
    expect(sorted(one, "age", "desc").reverse()).toEqual(
      sorted(one, "age", "asc"),
    );
    // A birth-time tie is broken by ask id, so the desc's flat list is the
    // asc's stand-ins reversed: within one run the ids run backwards too.
    const ties = [
      age("tieB", "a1", 40),
      age("tieA", "a2", 40),
      age("tieC", "a1", 40),
    ] satisfies AskMemberWire[];
    expect(sorted(ties, "age", "asc")).toEqual(["a2:tieA", "a1:tieB,tieC"]);
    expect(sorted(ties, "age", "desc")).toEqual(["a1:tieC,tieB", "a2:tieA"]);
  });

  it("room sort: rooms reversed on desc, oldest inside a room kept, the roomless agent last on both sides", () => {
    expect(sorted(ASKS, "room", "asc")).toEqual([
      "a4:a4none,a4p1",
      "a2:a2only",
      "a1:a1old,a1top",
      "a3:a3p1",
      "ea:ea",
    ]);
    expect(sorted(ASKS, "room", "desc")).toEqual([
      "a1:a1old,a1top",
      "a3:a3p1",
      "a4:a4none,a4p1",
      "a2:a2only",
      "ea:ea",
    ]);
  });

  it("priority sort: levels reversed on desc, oldest inside a level kept, the no-priority group last on both sides", () => {
    expect(sorted(ASKS, "priority", "asc")).toEqual([
      "a1:a1top,a1old",
      "a3:a3p1",
      "a4:a4p1,a4none",
      "a2:a2only",
      "ea:ea",
    ]);
    // One comparator orders the cards and the runs: the level flips inside a
    // run too (a1's P2 heads its run over its P0), and the no-priority groups
    // keep the no-priority-last rule, older first between themselves.
    expect(sorted(ASKS, "priority", "desc")).toEqual([
      "a1:a1old,a1top",
      "a3:a3p1",
      "a4:a4p1,a4none",
      "a2:a2only",
      "ea:ea",
    ]);
  });
});

// Under "age" the filters run first, so a hidden ask between two of one
// agent's asks joins them into one run. The filter row's wiring is in
// ui/components/AsksView.filter-options.dom.test.tsx.
it("age sort: the filters run first, so a hidden ask joins the runs on each side of it", () => {
  const asks = [
    theAsk("aOld", "a1", 90, "P1"),
    theAsk("bMid", "a2", 60, "P2"),
    theAsk("aNew", "a1", 30, "P1"),
  ];
  const by = (filter: AskFilter) =>
    order(askGroups(asks, AGENTS, ROOMS, filter, "age", "asc"));
  expect(by(all())).toEqual(["a1:aOld", "a2:bMid", "a1:aNew"]);
  expect(by({ ...all(), priorities: ["P1"] })).toEqual(["a1:aOld,aNew"]);
  expect(by({ ...all(), hiddenRooms: new Set(["r2"]) })).toEqual([
    "a1:aOld,aNew",
  ]);
  expect(by({ ...all(), hiddenRooms: new Set(["r1"]) })).toEqual(["a2:bMid"]);
});

// The asks with no agent (task dcb409d4, Nil at sign-off: "confirm pages are
// sorted first by priority"): one run per source name, the cards in the same
// order as an agent's run. The priority and age sorts place them by their
// key among the agents' runs; the agent and room sorts have no key for them
// and keep them first, by name, on both sides.
describe("askGroups with asks that have no agent (task dcb409d4)", () => {
  const paged = (
    id: string,
    source: { office: string } | { app: string },
    ageMin: number,
    priority?: TaskPriority,
  ): AskMemberWire => ({
    ...theAsk(id, "", ageMin, priority),
    ...("office" in source
      ? {
          office: { feature: source.office.toLowerCase(), name: source.office },
        }
      : { app: { name: source.app, createdAt: AGE(500) } }),
  });
  // Discord's dc and Pathfinder's a3p1 share a level and a birth, so the
  // source-before-agent tie and the ask-id tie both meet. An ask of an agent
  // the client does not have (`ghost`) stays out in every sort.
  const PAGED: AskMemberWire[] = [
    theAsk("a1p0", "a1", 5, "P0"),
    theAsk("a3p1", "a3", 30, "P1"),
    paged("dc", { office: "Discord" }, 30, "P1"),
    paged("wa1", { office: "WhatsApp" }, 25, "P1"),
    paged("wa2", { office: "WhatsApp" }, 50, "P3"),
    paged("wa3", { office: "WhatsApp" }, 45, "P1"),
    paged("appNone", { app: "Deploys" }, 70),
    theAsk("a2none", "a2", 60),
    theAsk("ghost", "zz", 40, "P0"),
  ];

  it("priority sort: a page sits with the asks of its level, the source run before the agent run on a tie, no priority last", () => {
    expect(sorted(PAGED, "priority", "asc")).toEqual([
      "a1:a1p0",
      "src:WhatsApp:wa3,wa1,wa2",
      "src:Discord:dc",
      "a3:a3p1",
      "src:Deploys:appNone",
      "a2:a2none",
    ]);
    // The level flips inside a source run too (WhatsApp's P3 heads it); the
    // tie and the no-priority-last rule stay.
    expect(sorted(PAGED, "priority", "desc")).toEqual([
      "src:WhatsApp:wa2,wa3,wa1",
      "src:Discord:dc",
      "a3:a3p1",
      "a1:a1p0",
      "src:Deploys:appNone",
      "a2:a2none",
    ]);
  });

  it("age sort: pages join the one list by age, and a run ends where the source changes", () => {
    expect(sorted(PAGED, "age", "asc")).toEqual([
      "src:Deploys:appNone",
      "a2:a2none",
      "src:WhatsApp:wa2,wa3",
      "a3:a3p1",
      "src:Discord:dc",
      "src:WhatsApp:wa1",
      "a1:a1p0",
    ]);
    expect(sorted(PAGED, "age", "desc")).toEqual([
      "a1:a1p0",
      "src:WhatsApp:wa1",
      "src:Discord:dc",
      "a3:a3p1",
      "src:WhatsApp:wa3,wa2",
      "a2:a2none",
      "src:Deploys:appNone",
    ]);
  });

  it("agent and room sorts: the source runs first by name on both sides, their cards in the sort's card order", () => {
    expect(sorted(PAGED, "agent", "asc")).toEqual([
      "src:Deploys:appNone",
      "src:Discord:dc",
      "src:WhatsApp:wa2,wa3,wa1",
      "a2:a2none",
      "a3:a3p1",
      "a1:a1p0",
    ]);
    // Under "agent" desc the cards of a source run are newest first, as an
    // agent's are.
    expect(sorted(PAGED, "agent", "desc")).toEqual([
      "src:Deploys:appNone",
      "src:Discord:dc",
      "src:WhatsApp:wa1,wa3,wa2",
      "a1:a1p0",
      "a3:a3p1",
      "a2:a2none",
    ]);
    expect(sorted(PAGED, "room", "asc")).toEqual([
      "src:Deploys:appNone",
      "src:Discord:dc",
      "src:WhatsApp:wa2,wa3,wa1",
      "a2:a2none",
      "a3:a3p1",
      "a1:a1p0",
    ]);
    expect(sorted(PAGED, "room", "desc")).toEqual([
      "src:Deploys:appNone",
      "src:Discord:dc",
      "src:WhatsApp:wa2,wa3,wa1",
      "a3:a3p1",
      "a1:a1p0",
      "a2:a2none",
    ]);
  });

  it("only the priority filter hides a page: it has no room and no agent", () => {
    const by = (filter: AskFilter) =>
      order(askGroups(PAGED, AGENTS, ROOMS, filter, "priority", "asc"));
    expect(
      by({
        ...all(),
        hiddenRooms: new Set(["r1", "r2"]),
        hiddenAgents: new Set(AGENTS.map((a) => a.id)),
      }),
    ).toEqual([
      "src:WhatsApp:wa3,wa1,wa2",
      "src:Discord:dc",
      "src:Deploys:appNone",
    ]);
    expect(by({ ...all(), priorities: ["P1"] })).toEqual([
      "src:WhatsApp:wa3,wa1",
      "src:Discord:dc",
      "a3:a3p1",
    ]);
  });
});
