// Task 7075171e: a value inside an ask card's sentence - a member's, an
// agent's, a room's or an app's name - is data (AGENTS.md "UI rules",
// ui/components/Data.tsx), one chip per value, the words around it plain.
// The action, step and secret cards keep theirs in their own files
// (ask-action*.dom.test.tsx, ask-step-block, SecretAskCard); this file has
// the card's header lines, the sudo card, the page line, the result card and
// the pinned read-only ask.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { dataChips, textOutsideData } from "../test-support/data-values.ts";

setUpDomTestFile();

const { render, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { AskResultCard } = await import("./AskResultCard.tsx");
const { PinnedAsk } = await import("../components/PinnedAsk.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AskResult = import("../store.tsx").AskResult;

const NOW = Date.now();

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let reads: Record<string, unknown> = {};
beforeEach(() => {
  reads = {};
  setApiShim(async (method, path) =>
    method === "GET" ? reads[path] : undefined,
  );
});
afterAll(() => setApiShim(null));

// Scout (a1) is Casey's agent in the Studio; Drifter (a2) has no manager.
const SCOUT = {
  id: "a1",
  name: "Scout",
  roomId: "r1",
  desk: 0,
  access: "standard",
  userId: "u2",
} as never;
const DRIFTER = {
  id: "a2",
  name: "Drifter",
  roomId: "r1",
  desk: 1,
  access: "standard",
} as never;
const ROOMS = [{ id: "r1", name: "Studio" }] as never[];
const MEMBERS = [
  { id: "u1", name: "Morgan" },
  { id: "u2", name: "Casey" },
].map((m) => ({
  ...m,
  role: "member",
  avatarColor: "#336699",
  avatarVariant: "classic",
  createdAt: NOW,
})) as never[];

function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "session_context",
      context: { userId: "u1", username: "Morgan", role: "owner" } as never,
    });
    dispatch({ type: "users_list", users: MEMBERS });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    for (const agent of [SCOUT, DRIFTER])
      dispatch({ type: "agent_added", agent });
    if (entries.length > 0)
      dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

const ask = (id: string, extra: Record<string, unknown>, agentId = "a1") =>
  ({
    id,
    agentId,
    memberUserId: "u1",
    prompt: "Ship it?",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  }) as AskEntry;

async function mountStack(entries: AskEntry[], agentId = "a1") {
  const view = render(
    <StoreProvider>
      <Seed entries={entries}>
        <AsksStack agentId={agentId} isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(
      entries.length,
    ),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
  return { view, card };
}

// The text of a line outside its chips: the words around the values.
const words = (line: Element | null | undefined) =>
  line ? textOutsideData(line) : "";

it("the header lines name the app, the member and the room as data", async () => {
  const { view, card } = await mountStack([
    ask("vals0001", { app: { name: "triage-bot", createdAt: NOW } }),
    ask("vals0002", { member: "Casey", members: ["Casey"] }),
    // A plain ask shared with others: the viewer is left out of the list.
    ask("vals0003", {
      memberUserId: undefined,
      members: ["Morgan", "Pat"],
    }),
    ask("vals0004", { memberUserId: undefined, room: true, members: [] }),
  ]);
  expect(dataChips(card("vals0001")?.querySelector("[data-ask-app]"))).toEqual([
    "triage-bot",
  ]);
  expect(dataChips(card("vals0002")?.querySelector("[data-ask-for]"))).toEqual([
    "Casey",
  ]);
  expect(
    dataChips(card("vals0003")?.querySelector("[data-ask-members]")),
  ).toEqual(["Pat"]);
  expect(
    dataChips(card("vals0004")?.querySelector("[data-ask-members]")),
  ).toEqual(["Studio"]);
  view.unmount();
});

// A list of names is one chip per name; the list's words (the commas and the
// "and" of the viewer's language) stay plain between them.
it("a list of members is one chip per name, with the list's words outside the chips", async () => {
  const names = ["Casey", "Pat", "Kim"];
  const others = ["Pat", "Kim", "Lee"];
  const { view, card } = await mountStack([
    ask("list0001", { member: "Casey", members: names }),
    ask("list0002", {
      memberUserId: undefined,
      members: ["Morgan", ...others],
    }),
  ]);
  const cases = [
    [card("list0001")?.querySelector("[data-ask-for]"), names],
    [card("list0002")?.querySelector("[data-ask-members]"), others],
  ] as const;
  for (const [line, list] of cases) {
    expect(dataChips(line)).toEqual([...list]);
    const around = words(line);
    // Every literal part of the list (", ", ", and ") is outside the chips.
    for (const part of new Intl.ListFormat("en", { type: "conjunction" })
      .formatToParts(list)
      .filter((p) => p.type === "literal"))
      expect(around).toContain(part.value);
  }
  view.unmount();
});

it("a sudo card names the agent and its manager as data", async () => {
  const sudo = {
    requestId: "sudo-1",
    command: "systemctl restart x",
    cwd: "/w",
  };
  const managed = await mountStack([ask("sudo0001", { sudo })]);
  expect(dataChips(managed.card("sudo0001"))).toEqual(["Scout", "Casey"]);
  managed.view.unmount();
  const alone = await mountStack([ask("sudo0002", { sudo }, "a2")], "a2");
  expect(dataChips(alone.card("sudo0002"))).toEqual(["Drifter"]);
  alone.view.unmount();
});

it("a paged ask's acked line names who acked it as data", async () => {
  const { view, card } = await mountStack([
    ask("page0001", { page: { state: "acked", ackedBy: "Casey" } }),
  ]);
  expect(
    dataChips(card("page0001")?.querySelector('[data-ask-page="acked"]')),
  ).toEqual(["Casey"]);
  view.unmount();
});

it("a result card names the member who answered first, the token and the member to send the link to as data", async () => {
  const results: [AskResult, string][] = [
    [{ kind: "answered-first", agentId: "a1", by: "Casey" }, "Casey"],
    [
      {
        kind: "api-token",
        agentId: "a1",
        target: "ci-bot",
        value: "isx_fake0000",
        forSelf: false,
      },
      "ci-bot",
    ],
    [
      {
        kind: "sign-in-link",
        agentId: "a1",
        target: "Casey",
        value: "https://office.example.com/signin#fake",
        forSelf: false,
      },
      "Casey",
    ],
  ];
  for (const [result, value] of results) {
    const view = render(
      <StoreProvider>
        <AskResultCard askId="rslt0001" result={result} isMobile={false} />
      </StoreProvider>,
    );
    expect({ kind: result.kind, chips: dataChips(view.container) }).toEqual({
      kind: result.kind,
      chips: [value],
    });
    view.unmount();
  }
});

// The pinned read of a closed ask: the member, the app that withdrew it and
// who answered are data; a member's own words (a reply) stay prose.
it("a pinned closed ask names the member, the app and who answered as data, and keeps a reply as prose", async () => {
  const closed = (id: string, close: Record<string, unknown>) => ({
    ...ask(id, {}),
    member: "Casey",
    members: ["Casey"],
    closed: { at: NOW, by: "Casey", ...close },
    events: [],
  });
  const mountPinned = async (id: string) => {
    const view = render(
      <StoreProvider>
        <Seed entries={[]}>
          <PinnedAsk
            id={id}
            entry={undefined}
            inStore={false}
            isMobile={false}
            undoMs={0}
            promptLines={3}
            onFocusAgent={() => {}}
            onClose={() => {}}
          />
        </Seed>
      </StoreProvider>,
    );
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(`[data-ask-readonly="${id}"]`).length,
      ).toBe(1),
    );
    return view;
  };
  reads["/api/asks/pinn0001"] = closed("pinn0001", {
    outcome: "withdrawn",
    app: "triage-bot",
  });
  const withdrawn = await mountPinned("pinn0001");
  // For Casey, withdrawn by triage-bot, answered by Casey.
  expect(dataChips(withdrawn.container)).toEqual([
    "Casey",
    "triage-bot",
    "Casey",
  ]);
  withdrawn.unmount();

  reads["/api/asks/pinn0002"] = closed("pinn0002", {
    outcome: "replied",
    answer: "Ship it on Monday",
  });
  const replied = await mountPinned("pinn0002");
  const outcome = replied.container.querySelector("[data-ask-outcome]");
  expect(outcome?.textContent).toContain("Ship it on Monday");
  expect(dataChips(outcome)).toEqual([]);
  replied.unmount();
});
