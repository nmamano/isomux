import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
afterAll(() => setApiShim(null));

it("the member editor saves the office-owner checkbox through the user update", async () => {
  const calls: { path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (method === "PATCH") calls.push({ path, body });
    return {};
  });
  const member = {
    ...selfUserRecord("en"),
    id: "member-id",
    name: "Marc",
    role: "member" as const,
  };
  const view = render(
    onLanguage(
      "en",
      createElement(UserSettingsView, {
        initialUserId: member.id,
        onClose: () => {},
        onSwitchUser: () => {},
      }),
      {
        users: new Map([
          ["tester", selfUserRecord("en")],
          ["marc", member],
        ]),
      },
    ),
  );
  const checkbox = view.getByRole("checkbox", {
    name: "Office owner",
  }) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  await act(async () => {
    fireEvent.click(checkbox);
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe("/api/users/Marc");
  expect(calls[0]?.body).toMatchObject({ role: "owner" });
});
