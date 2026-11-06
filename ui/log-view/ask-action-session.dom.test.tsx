// Action asks (task 43b67f3a): the card of one session of a member revoked.
// It reads the session from the sessions the office keeps live, loaded by the
// card when no page has yet. The other kinds' cards are in
// ask-action.dom.test.tsx and ask-action-office.dom.test.tsx; this file keeps
// those under the DOM time cap.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, waitFor } = await import("@testing-library/react");
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
  userId: "u2",
} as never;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let read: (path: string) => unknown = () => undefined;
beforeEach(() => {
  read = () => undefined;
  setApiShim(async (method, path) =>
    method === "GET" ? read(path) : undefined,
  );
});
afterAll(() => setApiShim(null));

// Morgan (u1, the member the asks are for) is an office owner; Casey (u2) is
// a member.
const member = (id: string, name: string, role: "owner" | "member") =>
  ({
    id,
    name,
    role,
    allowedRooms: [],
    notifRooms: [],
    pushRooms: [],
    hidden: [],
    order: [],
    tucked: [],
    memberPrompt: null,
    language: "en",
    createdAt: NOW,
    avatarColor: "#336699",
    avatarVariant: "classic",
  }) as never;
const MEMBERS = [
  member("u1", "Morgan", "owner"),
  member("u2", "Casey", "member"),
];

let seeded: ReturnType<typeof useDispatch> = () => {};
function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    seeded = dispatch;
    dispatch({ type: "agent_added", agent: ASKER });
    dispatch({ type: "users_admin_list", users: MEMBERS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(entries: AskEntry[]) {
  const view = render(
    <StoreProvider>
      <Seed entries={entries}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(
      entries.length,
    ),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  const block = (id: string) =>
    card(id).querySelector<HTMLElement>("[data-ask-action]");
  const apply = (id: string) =>
    card(id).querySelector<HTMLButtonElement>("[data-ask-action-apply]");
  return { view, block, apply };
}

const revokeAsk = (id: string, userId: string, sessionPrefix: string) =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Revoke this session?",
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "session-revoke", userId, sessionPrefix },
  }) as AskEntry;

const session = (
  sessionPrefix: string,
  userId: string,
  username: string,
  device: string | null,
  userAgent: string | null,
) => ({
  sessionPrefix,
  userId,
  username,
  device,
  userAgent,
  createdAt: NOW - 86400000,
  lastSeenAt: NOW - 60000,
  expiresAt: NOW + 86400000,
  absoluteExpiresAt: NOW + 86400000,
});

// Morgan is signed in on HEREhere.
it("a session-revoke card names the session by its device, else its user agent, else its prefix, shows the prefix, says whose it is, and says Apply signs the member out here only for the session they are on, not for their other one", async () => {
  read = (path) =>
    path === "/api/sessions"
      ? {
          sessions: [
            session("HEREhere", "u1", "Morgan", "Laptop", "Mozilla/5.0 (X11)"),
            session("7Tqn6nKy", "u2", "Casey", null, "curl/8.5.0"),
            session("de05uI--", "u2", "Casey", null, null),
            // Morgan's other session: not the one they apply from.
            session(
              "OTHERone",
              "u1",
              "Morgan",
              "Phone",
              "Mozilla/5.0 (iPhone)",
            ),
          ],
        }
      : undefined;
  const { view, block, apply } = await mount([
    revokeAsk("ses00001", "u2", "7Tqn6nKy"),
    revokeAsk("ses00002", "u1", "HEREhere"),
    revokeAsk("ses00003", "u2", "de05uI--"),
    revokeAsk("ses00005", "u1", "OTHERone"),
    // A member the office no longer has.
    revokeAsk("ses00004", "u9", "Gone1234"),
  ]);
  await act(async () => {
    seeded({
      type: "session_context",
      context: {
        userId: "u1",
        username: "Morgan",
        role: "owner",
        currentSessionPrefix: "HEREhere",
        connectionId: "c1",
      },
    } as never);
  });
  await waitFor(() =>
    expect(block("ses00001")!.textContent).toContain("curl/8.5.0"),
  );
  const text = (id: string) => block(id)!.textContent!;
  expect({
    prefix: text("ses00001").includes("7Tqn6nKy"),
    whose: text("ses00001").includes("Casey"),
  }).toEqual({ prefix: true, whose: true });
  expect(text("ses00002")).toContain("Laptop");
  expect(text("ses00003")).toContain("de05uI--");
  expect(
    ["ses00001", "ses00002", "ses00003", "ses00005"].map((id) => [
      id,
      block(id)!.hasAttribute("data-ask-action-signs-you-out"),
      block(id)!.hasAttribute("data-ask-action-gone"),
      apply(id) !== null,
    ]),
  ).toEqual([
    ["ses00001", false, false, true],
    ["ses00002", true, false, true],
    ["ses00003", false, false, true],
    ["ses00005", false, false, true],
  ]);
  expect(block("ses00004")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("ses00004")).toBe(null);
  view.unmount();
});
