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
  expect(view.queryAllByRole("checkbox")).toEqual([]);
  expect(view.queryAllByRole("textbox")).toEqual([]);

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
