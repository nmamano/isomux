import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { InvitesPane } = await import("./InvitesPane.tsx");
afterAll(() => setApiShim(null));

// An invite is a sign-in link for an existing member (task ec1724a8): the pane
// picks a member and sends only their id - no name, role or profile fields.
it("mints a sign-in link for the picked existing member by id, with no profile form", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return { url: "https://example.com/i/test", invite: {} };
  });
  const view = render(
    onLanguage("en", createElement(InvitesPane), {
      invitesList: [],
      invitesLoaded: true,
    }),
  );
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(view.queryAllByRole("checkbox")).toHaveLength(0);
  expect(view.queryAllByRole("textbox")).toHaveLength(0);

  const [create] = view.getAllByRole("button") as HTMLButtonElement[];
  expect(create.disabled).toBe(true);
  const member = view.getByRole("combobox") as HTMLSelectElement;
  fireEvent.change(member, { target: { value: "u1" } });
  expect(create.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(create);
  });
  expect(calls).toEqual([
    { method: "POST", path: "/api/invites", body: { userId: "u1" } },
  ]);
  expect(view.container.textContent).toContain("https://example.com/i/test");
  expect(member.value).toBe("");
});

// Extend (task 1492af52): an owner gives a link another 3 days from the Sign-in
// links pane, live or expired, with one click (no confirm: Revoke undoes it).
// Only rows the server marks extendable get it. My devices lists the owner's
// own links from the same store list, and stays live-only there: no expired
// row and no Extend.
type InviteWire = import("../../shared/types.ts").InviteWire;
const { MyDevicesPane } = await import("./MyDevicesPane.tsx");
const DAY = 86_400_000;
const row = (
  tokenPrefix: string,
  username: string,
  extra: Partial<InviteWire> = {},
): InviteWire => ({
  tokenPrefix,
  username,
  role: "member",
  createdBy: "Tester",
  createdAt: 1,
  expiresAt: Date.now() + DAY,
  ...extra,
});
const ROWS: InviteWire[] = [
  row("live0000", "Ann"),
  row("live1111", "Dan", { extendable: true }),
  row("expd2222", "Eve", {
    expiresAt: Date.now() - DAY,
    expired: true,
    extendable: true,
  }),
  // The owner's own links: one live, one expired.
  // Made by another owner, so the server marks it extendable.
  row("mine3333", "Tester", { createdBy: "Morgan", extendable: true }),
  row("mine4444", "Tester", {
    createdBy: "Morgan",
    expiresAt: Date.now() - DAY,
    expired: true,
    extendable: true,
  }),
];
const rowOf = (root: HTMLElement, prefix: string) =>
  [...root.querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes(prefix),
  ) ?? null;

it("Extend sends one extend call per click on an extendable row, live or expired, and no other row has it", async () => {
  const calls: string[] = [];
  setApiShim(async (method, path) => {
    calls.push(`${method} ${path}`);
    return {};
  });
  const view = render(
    onLanguage("en", createElement(InvitesPane), {
      invitesList: ROWS,
      invitesLoaded: true,
    }),
  );
  const root = view.container;
  const buttonCounts = ROWS.map(
    (r) =>
      `${r.tokenPrefix}:${rowOf(root, r.tokenPrefix)?.querySelectorAll("button").length ?? "missing"}`,
  );
  expect(buttonCounts).toEqual([
    "live0000:1",
    "live1111:2",
    "expd2222:2",
    "mine3333:2",
    "mine4444:2",
  ]);
  // One click on every button of the row: Revoke only arms, Extend sends.
  for (const prefix of ["live1111", "expd2222"]) {
    for (const b of rowOf(root, prefix)!.querySelectorAll("button"))
      await act(async () => {
        fireEvent.click(b);
      });
  }
  expect(calls).toEqual([
    "POST /api/invites/live1111/extend",
    "POST /api/invites/expd2222/extend",
  ]);
  view.unmount();
});

it("an owner's My devices shows only their own live links, with Revoke alone", async () => {
  setApiShim(async () => ({}));
  const view = render(
    onLanguage("en", createElement(MyDevicesPane), {
      invitesList: ROWS,
      invitesLoaded: true,
      activeSessions: [],
      activeSessionsLoaded: true,
    }),
  );
  const root = view.container;
  const shown = ROWS.filter((r) => rowOf(root, r.tokenPrefix) !== null).map(
    (r) => r.tokenPrefix,
  );
  expect(shown).toEqual(["mine3333"]);
  expect(rowOf(root, "mine3333")!.querySelectorAll("button")).toHaveLength(1);
  view.unmount();
});
