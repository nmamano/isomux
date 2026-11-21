// The card of the rule ask of "... and automate" (task 33891b5b): an
// instructions-line step names whose instructions get the line and shows
// the line. Apply sends the scope and the line the card shows, so the
// server can refuse a rule the agent changed since (409 step_changed); after
// the agent's edit reaches the card, Apply sends the new one.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, waitFor, act } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const ASKER = {
  id: "a1",
  name: "Asker",
  roomId: "r1",
  desk: 0,
  access: "standard",
  userId: "u1",
} as never;
const MEMBERS = [{ id: "u1", name: "Morgan" }].map((m) => ({
  ...m,
  role: "owner",
  avatarColor: "#336699",
  avatarVariant: "classic",
  createdAt: NOW,
})) as never[];

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; body: unknown }[] = [];
beforeEach(() => {
  posts = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST") posts.push({ path, body });
    return undefined;
  });
});
afterAll(() => setApiShim(null));

const RULE = "Tab order and copy changes: go with your pick, tell me after.";
const ID = "rule0001";
const entryWith = (step: Record<string, unknown>) =>
  ({
    id: ID,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Quick stamp: save this rule?",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  }) as AskEntry;

let push: ((entry: AskEntry) => void) | null = null;
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
      context: {
        userId: "u1",
        username: "Morgan",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as never,
    });
    dispatch({ type: "agent_added", agent: ASKER });
    dispatch({ type: "users_list", users: MEMBERS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
    push = (entry) => dispatch({ type: "ask_upserted", entry } as never);
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(step: Record<string, unknown>) {
  const view = render(
    <StoreProvider>
      <Seed entries={[entryWith(step)]}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(`[data-ask="${ID}"] [data-ask-action]`)
        .length,
    ).toBe(1),
  );
  const block = () =>
    view.container.querySelector<HTMLElement>(
      `[data-ask="${ID}"] [data-ask-action]`,
    )!;
  const apply = () =>
    block().querySelector<HTMLButtonElement>("[data-ask-action-apply]");
  return { view, block, apply };
}

const lineStep = (scope: string, line: string, targetId: string) => ({
  kind: "instructions-line",
  scope,
  line,
  targetId,
});

it("names the agent or the member whose instructions get the line, shows the line, and Apply sends the scope and the line", async () => {
  for (const [scope, targetId, name] of [
    ["agent", "a1", "Asker"],
    ["member", "u1", "Morgan"],
    ["room", "r1", null],
  ] as const) {
    posts = [];
    const m = await mount(lineStep(scope, RULE, targetId));
    const text = m.block().textContent ?? "";
    expect({ scope, line: text.includes(RULE) }).toEqual({ scope, line: true });
    if (name)
      expect({ scope, name: text.includes(name) }).toEqual({
        scope,
        name: true,
      });
    fireEvent.click(m.apply()!);
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts).toEqual([
      { path: `/api/asks/${ID}/action`, body: { scope, line: RULE } },
    ]);
    m.view.unmount();
  }
});

it("after the agent's edit reaches the card, shows and applies the new line", async () => {
  const m = await mount(lineStep("agent", RULE, "a1"));
  const tuned = "Copy changes only: go with your pick.";
  await act(async () => {
    push!(entryWith(lineStep("room", tuned, "r1")));
  });
  await waitFor(() =>
    expect((m.block().textContent ?? "").includes(tuned)).toBe(true),
  );
  expect((m.block().textContent ?? "").includes(RULE)).toBe(false);
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].body).toEqual({ scope: "room", line: tuned });
});
