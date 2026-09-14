import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { InvitesPane } = await import("./InvitesPane.tsx");
afterAll(() => setApiShim(null));

it("creates an unnamed invite and sends optional profile defaults without treating the suggested name as an account", async () => {
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
  const issue = view.getByRole("button", {
    name: "Issue invite",
  }) as HTMLButtonElement;
  expect(issue.disabled).toBe(false);
  fireEvent.change(view.getByLabelText("Member name (optional)"), {
    target: { value: "Tester" },
  });
  expect(issue.disabled).toBe(false);
  fireEvent.change(view.getByLabelText("Language"), {
    target: { value: "ca" },
  });
  fireEvent.click(view.getByRole("checkbox", { name: "Office owner" }));
  const prompt = view.container.querySelector("textarea")!;
  fireEvent.change(prompt, { target: { value: "Explain each step." } });
  await act(async () => {
    fireEvent.click(issue);
  });
  expect(calls).toEqual([
    {
      method: "POST",
      path: "/api/invites",
      body: {
        role: "owner",
        label: "Tester",
        language: "ca",
        memberPrompt: "Explain each step.",
      },
    },
  ]);
  expect(
    (view.getByLabelText("Member name (optional)") as HTMLInputElement).value,
  ).toBe("");
  expect((view.getByLabelText("Language") as HTMLSelectElement).value).toBe("");
  expect(prompt.value).toBe("");
});
