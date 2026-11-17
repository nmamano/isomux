// Settings > Usage keeps its layout while GET /api/usage loads (task 3755fad4,
// the UI rule in AGENTS.md): its tables are drawn with blank rows before the
// report answers, as many as this device saw last, or, on a first visit, as
// many agents and rooms as the office shows the reader. A member's report is
// scoped to their rooms, and its line is drawn before the answer too.
//
// happy-dom lays nothing out: blockShape compares the block tree drawn while
// the report waits with the tree drawn once it answered.
//
// Seam: UsagePane over setApiShim, under the state of the language fixture.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { blockShape, deferred } from "../test-support/held-shape.ts";
import type {
  UsageBucketWire,
  UsageReportWire,
} from "../../shared/contract-shapes.ts";
import type { AgentInfo, RoomWire } from "../../shared/types.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UsagePane } = await import("./UsagePane.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");

const BUCKET: UsageBucketWire = {
  totalIn: 120_000,
  cacheRead: 90_000,
  cacheCreation: 10_000,
  totalOut: 4_000,
  costUSD: 1.25,
};

const room = (n: number): RoomWire =>
  ({
    type: "office",
    id: `room000${n}`,
    name: `Room ${n}`,
    prompt: null,
    canCloseWhenEmpty: true,
  }) as RoomWire;
const agent = (n: number, roomId: string): AgentInfo =>
  ({ id: `agent-${n}`, name: `Agent ${n}`, roomId }) as unknown as AgentInfo;

function report(
  agents: number,
  rooms: number,
  schedules: number,
  scoped: boolean,
): UsageReportWire {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  return {
    scoped,
    agents: range(agents).map((i) => ({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      roomId: "room0001",
      roomName: "Room 1",
      session: BUCKET,
      lifetime: BUCKET,
    })),
    rooms: range(rooms).map((i) => ({
      id: `room000${i}`,
      name: `Room ${i}`,
      deleted: false,
      session: BUCKET,
      lifetime: BUCKET,
    })),
    ...(scoped
      ? {}
      : {
          cronjobs: range(schedules).map((i) => ({
            id: `cron-${i}`,
            name: `Schedule ${i}`,
            deleted: false,
            lifetime: BUCKET,
          })),
        }),
    total: { session: BUCKET, lifetime: BUCKET },
  };
}

// GET /api/usage answers with `answer` when the returned function runs; with
// `now`, at once.
function serve(answer: UsageReportWire, now = false) {
  const read = deferred<UsageReportWire>();
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/usage")
      return now ? answer : read.promise;
    throw new Error(`no shim for ${method} ${path}`);
  });
  return () => read.resolve(answer);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The office the reader sees: two agents in three rooms, and `schedules`
// schedules.
async function mount(role: "owner" | "member" = "owner", schedules = 0) {
  const session = stateWithSelfUser(null).sessionContext!;
  const view = render(
    onLanguage(null, createElement(UsagePane), {
      rooms: [room(1), room(2), room(3)],
      agents: [agent(1, "room0001"), agent(2, "room0002")],
      cronjobs: Array.from(
        { length: schedules },
        (_, i) => ({ id: `cron-${i + 1}`, name: `Schedule ${i + 1}` }) as never,
      ),
      sessionContext: { ...session, role },
    }),
  );
  await settle();
  return view;
}

// Shape while the report waits, then once it answered.
async function shapes(
  answer: () => void,
  role: "owner" | "member",
  schedules = 0,
) {
  const view = await mount(role, schedules);
  const busy = () => view.container.querySelector('[aria-busy="true"]');
  expect(busy()).not.toBeNull();
  const held = blockShape(view.container);
  await act(async () => answer());
  await settle();
  expect(busy()).toBeNull();
  return { held, shown: blockShape(view.container) };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());
afterAll(() => setApiShim(null));

describe("Usage while the report loads", () => {
  it("draws a row per agent and room the office shows, on a device that never loaded it", async () => {
    const { held, shown } = await shapes(
      serve(report(2, 3, 0, false)),
      "owner",
    );
    expect(held).toBe(shown);
  });

  it("holds the rows of the last report, schedules included", async () => {
    // A first visit shows a report longer than the office in view.
    serve(report(5, 4, 2, false), true);
    (await mount("owner")).unmount();

    const { held, shown } = await shapes(
      serve(report(5, 4, 2, false)),
      "owner",
    );
    expect(held).toBe(shown);
  });

  // Task 69c5f413: the report lists the schedules to an owner only.
  it("draws a row per schedule the office shows an owner, on a device that never loaded it", async () => {
    const { held, shown } = await shapes(
      serve(report(2, 3, 2, false)),
      "owner",
      2,
    );
    expect(shown).toContain("TR(TD()TD()TD()TD())");
    expect(held).toBe(shown);
  });

  it("draws no schedule table for a member who sees schedules in the office", async () => {
    const { held, shown } = await shapes(
      serve(report(2, 3, 0, true)),
      "member",
      2,
    );
    expect(shown).not.toContain("TR(TD()TD()TD()TD())");
    expect(held).toBe(shown);
  });

  // Task 69c5f413: the number columns keep their width when the numbers come;
  // the name column takes the rest of the table.
  it("gives each number column a fixed width and the name column the rest, held and loaded", async () => {
    const answer = serve(report(2, 3, 2, false));
    const view = await mount("owner", 2);
    const widths = () =>
      [...view.container.querySelectorAll("table")].map((table) => {
        const heads = table.querySelectorAll("thead th").length;
        const cols = [...table.querySelectorAll("col")].map(
          (col) => (col as HTMLElement).style.width,
        );
        expect(cols.length).toBe(heads);
        return cols;
      });
    const held = widths();
    // The agent, room, schedule and office total tables.
    expect(held.length).toBe(4);
    for (const cols of held) {
      expect(cols[0]).toBe("");
      for (const width of cols.slice(1))
        expect(width).toMatch(/^\d+(\.\d+)?(px|em|rem|ch)$/);
    }
    await act(async () => answer());
    await settle();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(widths()).toEqual(held);
  });

  it("draws the scoped line for a member before the report answers", async () => {
    const { held, shown } = await shapes(
      serve(report(2, 3, 0, true)),
      "member",
    );
    expect(held).toBe(shown);
  });
});
