import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

// Task ec1724a8: an owner creates a member from the Members list with the
// member editor, before any sign-in link exists.
setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");

const calls: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (method === "POST" && path === "/api/users")
      return { user: { id: "u9" } };
    return {};
  });
});
afterAll(() => setApiShim(null));

function renderSettings(over = {}) {
  return render(
    onLanguage(
      "en",
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
      }),
      over,
    ),
  );
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
        memberPrompt: "Explain each step.",
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
});
