import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./components/EditAgentDialog.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { RECEPTIONIST_INSTRUCTIONS, RECEPTIONIST_PROFILE_KEY } =
  await import("../shared/receptionist-profile.ts");

const capture: { submitted: Record<string, unknown> | null } = {
  submitted: null,
};
setApiShim(async (method, path, body) => {
  if (path === "/api/validate/cwd") return { ok: true };
  if (method === "POST" && path === "/api/agents") {
    capture.submitted = body as Record<string, unknown>;
    return { agent: { id: "new-agent" } };
  }
  throw new Error(`Unexpected route ${path}`);
});
afterAll(() => setApiShim(null));

function submission(): Record<string, unknown> {
  if (!capture.submitted) throw new Error("The dialog did not submit");
  return capture.submitted;
}

const room = {
  id: "r1",
  name: "Room 1",
  prompt: null,
  canCloseWhenEmpty: false,
};

describe("receptionist profile dialog", () => {
  // The profile's name is the catalog's label in the member's language.
  for (const language of [null, "es"] as const) {
    const label = translatorFor(language ?? "en").t(
      "templates.receptionist.label",
    );
    it(`shows the profile in ${language ?? "en"}`, async () => {
      const view = render(
        onLanguage(
          language,
          createElement(EditAgentDialog, {
            onClose() {},
            deskIndex: 2,
            roomId: "r1",
            defaultCwd: "/work",
            spawnAgentType: "claude",
          }),
          { rooms: [room], hasReceivedInitialState: true },
        ),
      );
      await act(async () =>
        fireEvent.click(view.getByRole("button", { name: new RegExp(label) })),
      );
      expect(view.getByDisplayValue(label)).toBeTruthy();
      expect(view.getByDisplayValue("~")).toBeTruthy();
      if (language === null) {
        capture.submitted = null;
        await act(async () =>
          fireEvent.click(view.getByRole("button", { name: /^Spawn$/ })),
        );
        expect(submission()).toMatchObject({
          profileKey: RECEPTIONIST_PROFILE_KEY,
          cwd: "~",
          permissionMode: "bypassPermissions",
          name: label,
          instructions: RECEPTIONIST_INSTRUCTIONS,
        });
        expect(submission()).not.toHaveProperty("customInstructions");
      }
      view.unmount();
    });
  }
});
