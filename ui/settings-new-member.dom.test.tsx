import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { InviteWire } from "../shared/types.ts";

// Task ec1724a8: an owner creates a member from the Members list with the
// member editor, before any sign-in link exists.
setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");

const calls: { method: string; path: string; body: unknown }[] = [];
function reply(method: string, path: string): unknown {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (method === "POST" && path === "/api/users") return { user: { id: "u9" } };
  return {};
}
beforeEach(() => {
  calls.length = 0;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return reply(method, path);
  });
});
afterAll(() => setApiShim(null));

function settings(over = {}, initialUserId?: string) {
  return onLanguage(
    "en",
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
      initialUserId,
    }),
    over,
  );
}

// The page with the Members group open: it starts collapsed (task db800fd8),
// and the device keeps it open after the first case.
function renderSettings(over = {}) {
  const view = render(settings(over));
  const members = view.container.querySelector(
    '[data-sidebar-group-toggle="members"][aria-expanded="false"]',
  );
  if (members) fireEvent.click(members);
  return view;
}

it("marks a member who never signed in on the owner's roster", () => {
  const pending = {
    ...selfUserRecord(null),
    id: "u2",
    name: "Pia",
    role: "member" as const,
    pendingSignIn: true as const,
  };
  const users = new Map([
    ["tester", selfUserRecord("en")],
    ["pia", pending],
  ]);
  const view = renderSettings({ users });
  const neverSignedIn = en["settings.members.neverSignedIn"];
  const piaRow = view.getByText("Pia").closest("button")!;
  expect(within(piaRow).queryByText(neverSignedIn)).not.toBeNull();
  const selfRow = view.getAllByText("Tester")[0].closest("button")!;
  expect(within(selfRow).queryByText(neverSignedIn)).toBeNull();
});

it("creates a member from the editor with only record fields, then leaves create mode", async () => {
  const view = renderSettings();
  // The page opens on the owner's own editor, which loads their memory.
  await act(async () => {});
  calls.length = 0;
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: en["settings.members.newMember"] }),
    );
  });
  const detail = view.getByTestId("settings-content");
  // No stored record yet: no delete button and no memory load for an empty id.
  expect(
    within(detail).queryByRole("button", { name: en["common.delete"] }),
  ).toBeNull();
  expect(calls.some((c) => c.path.startsWith("/api/memory"))).toBe(false);

  const name = detail.querySelector("input")!;
  fireEvent.change(name, { target: { value: "  Pia " } });
  fireEvent.change(detail.querySelector("textarea")!, {
    target: { value: "Explain each step." },
  });
  await act(async () => {
    fireEvent.click(
      within(detail).getByRole("button", {
        name: en["settings.members.create"],
      }),
    );
  });
  expect(calls.filter((c) => c.method === "POST")).toEqual([
    {
      method: "POST",
      path: "/api/users",
      body: {
        name: "Pia",
        role: "member",
        instructions: "Explain each step.",
        avatarColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
        avatarVariant: "classic",
      },
    },
  ]);
  // onCreated moved the selection to the new member's id: the create form
  // is gone.
  expect(
    view.queryByRole("button", { name: en["settings.members.create"] }),
  ).toBeNull();
  // Task 4860c373: once the broadcast brings the record, the new member's
  // page offers their sign-in link.
  view.rerender(
    settings({
      users: new Map([
        ["tester", selfUserRecord("en")],
        ["pia", pia({ id: "u9" })],
      ]),
      invitesList: [],
      invitesLoaded: true,
    }),
  );
  expect(signInLink(view)?.querySelector(CREATE) != null).toBe(true);
});

// Task 4860c373: an owner on the page of a member who never signed in gets
// the button that mints that member's sign-in link in place, unless an
// unused link for them is already out (a new one would replace it).
const CREATE = "button[data-member-sign-in-link-create]";
const DAY = 24 * 60 * 60 * 1000;

function pia(over = {}) {
  return {
    ...selfUserRecord(null),
    id: "u2",
    name: "Pia",
    role: "member" as const,
    pendingSignIn: true as const,
    ...over,
  };
}

function invite(username: string, expiresAt: number): InviteWire {
  return {
    tokenPrefix: "abcd1234",
    username,
    role: "member",
    createdBy: "u1",
    createdAt: 0,
    expiresAt,
  };
}

function piaState(over: Record<string, unknown> = {}, record = pia()) {
  return {
    users: new Map([
      ["tester", selfUserRecord("en")],
      ["pia", record],
    ]),
    invitesList: [] as InviteWire[],
    invitesLoaded: true,
    ...over,
  };
}

function signInLink(view: { container: HTMLElement }) {
  return view.container.querySelector<HTMLElement>(
    "[data-member-sign-in-link]",
  );
}

// Pia's page is mounted: the heading carries her name.
function onPiaPage(view: { getByTestId: (id: string) => HTMLElement }) {
  const heading = view.getByTestId("settings-content").querySelector("h4");
  return heading?.textContent === "Pia";
}

// "enabled", "disabled" (the invites list is still loading: the page keeps
// its layout, AGENTS.md UI rules) or null (no button).
it.each([
  ["pending, no link out", piaState(), "enabled"],
  ["pending, no link out, phone", piaState({ isMobile: true }), "enabled"],
  [
    "pending, only an expired link",
    piaState({ invitesList: [invite("Pia", Date.now() - 1000)] }),
    "enabled",
  ],
  [
    "pending, another member's link out",
    piaState({ invitesList: [invite("Ana", Date.now() + DAY)] }),
    "enabled",
  ],
  [
    "pending, an unused link out",
    piaState({ invitesList: [invite("Pia", Date.now() + DAY)] }),
    null,
  ],
  [
    "pending, links not loaded yet",
    piaState({ invitesLoaded: false }),
    "disabled",
  ],
  [
    "signed in",
    piaState({}, { ...pia(), pendingSignIn: undefined } as never),
    null,
  ],
])("sign-in link button on a member's page: %s", async (_, state, button) => {
  const view = render(settings(state, "u2"));
  await act(async () => {});
  expect(onPiaPage(view)).toBe(true);
  const create =
    signInLink(view)?.querySelector<HTMLButtonElement>(CREATE) ?? null;
  expect(create && (create.disabled ? "disabled" : "enabled")).toBe(button);
  view.unmount();
});

it("mints the member's link once by id, shows it in place, and keeps it when the link is listed", async () => {
  let resolve!: (v: unknown) => void;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/api/invites")
      return new Promise((r) => (resolve = r));
    return reply(method, path);
  });
  const view = render(settings(piaState(), "u2"));
  await act(async () => {});
  const create = signInLink(view)!.querySelector<HTMLButtonElement>(CREATE)!;
  await act(async () => {
    fireEvent.click(create);
  });
  // A second click while the first is in flight mints nothing more.
  expect(create.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(create);
  });
  await act(async () => {
    resolve({ url: "https://example.com/i/pia", invite: {} });
  });
  expect(calls.filter((c) => c.path === "/api/invites")).toEqual([
    { method: "POST", path: "/api/invites", body: { userId: "u2" } },
  ]);
  expect(signInLink(view)!.textContent).toContain("https://example.com/i/pia");
  expect(signInLink(view)!.querySelector(CREATE)).toBeNull();

  // The invites_list broadcast now lists Pia's unused link: the URL, shown
  // once, stays on the page.
  view.rerender(
    settings(
      piaState({ invitesList: [invite("Pia", Date.now() + DAY)] }),
      "u2",
    ),
  );
  expect(signInLink(view)?.textContent).toContain("https://example.com/i/pia");
  view.unmount();
});

it("shows a failed mint's error and keeps the button", async () => {
  setApiShim(async (method, path) => {
    if (method === "POST" && path === "/api/invites")
      throw new ApiError(404, "not_found", "No member u2");
    return reply(method, path);
  });
  const view = render(settings(piaState(), "u2"));
  await act(async () => {});
  await act(async () => {
    fireEvent.click(signInLink(view)!.querySelector(CREATE)!);
  });
  expect(signInLink(view)!.textContent).toContain("No member u2");
  const create = signInLink(view)!.querySelector<HTMLButtonElement>(CREATE);
  expect(create?.disabled).toBe(false);
  view.unmount();
});
