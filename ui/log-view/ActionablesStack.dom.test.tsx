// The stack of open actionables above the chat input
// (internal-docs/actionables-design.md): one agent's entries for this member,
// oldest first, open on a desktop and collapsed on a phone, and an answer that
// posts to the member route and closes the card only when the server took it.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { ActionablesStack } = await import("./ActionablesStack.tsx");
type ActionableEntry = import("../../shared/types.ts").ActionableEntry;

const NOW = Date.now();
const entry = (
  id: string,
  agentId: string,
  prompt: string,
  ageMin: number,
): ActionableEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});
const ENTRIES = [
  entry("bbbb0002", "a1", "Second question?", 5),
  entry("aaaa0001", "a1", "First question?", 120),
  entry("cccc0003", "a2", "Another agent's question?", 1),
];

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; body: Record<string, unknown> }[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
      return answer(path);
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "actionables_loaded", entries: ENTRIES, revision: 0 });
  }, [dispatch]);
  return <>{children}</>;
}

function mount(isMobile: boolean) {
  return render(
    <StoreProvider>
      <Seed>
        <ActionablesStack agentId="a1" isMobile={isMobile} />
      </Seed>
    </StoreProvider>,
  );
}

const cards = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-actionable]")].map(
    (c) => c.dataset.actionable,
  );

it("shows this agent's actionables only, oldest first, open on a desktop", async () => {
  const view = mount(false);
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]),
  );
  expect(
    view.container
      .querySelector("[data-actionables-stack]")
      ?.getAttribute("data-actionables-stack"),
  ).toBe("open");
  view.unmount();
});

it("starts collapsed on a phone, with the count and the oldest prompt, and opens on a tap", async () => {
  const view = mount(true);
  await waitFor(() =>
    expect(view.container.querySelector("[data-actionables-stack]")).not.toBe(
      null,
    ),
  );
  const bar = view.container.querySelector<HTMLElement>(
    "[data-actionables-stack=collapsed] button",
  )!;
  expect(cards(view.container)).toEqual([]);
  expect(bar.textContent).toContain("2");
  expect(bar.textContent).toContain("First question?");
  expect(bar.textContent).not.toContain("Second question?");
  fireEvent.click(bar);
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
  view.unmount();
});

it("replies with the field's text and closes the card once the server took it", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve(undefined)));
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const card = view.container.querySelector<HTMLElement>(
    '[data-actionable="aaaa0001"]',
  )!;
  const field = card.querySelector("input")!;
  // Prefilled, so one click answers.
  expect(field.value.length).toBeGreaterThan(0);
  const prefilled = field.value;
  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([
    { path: "/api/actionables/aaaa0001/reply", body: { text: prefilled } },
  ]);
  // Still there while the request is open.
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(cards(view.container)).toEqual(["bbbb0002"]);
  view.unmount();
});

it("keeps the card with the reason when the server refuses a dismiss", async () => {
  answer = async () => {
    throw new ApiError(409, "agent_stopped", "agent_stopped");
  };
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const card = view.container.querySelector<HTMLElement>(
    '[data-actionable="bbbb0002"]',
  )!;
  const dismiss = card.querySelector<HTMLButtonElement>(
    "button[type=button]:last-of-type",
  )!;
  await act(async () => {
    fireEvent.click(dismiss);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts.map((p) => p.path)).toEqual([
    "/api/actionables/bbbb0002/dismiss",
  ]);
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain(
    "agent_stopped",
  );
  view.unmount();
});
