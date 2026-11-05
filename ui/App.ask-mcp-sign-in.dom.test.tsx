// Back from an MCP sign-in started in an ask card (task e3d1bc63, part 6):
// the server sends the browser to /inbox/asks/<askId>?mcpSignIn=<code>. The
// code is that ask's: its card shows a failure with the Sign in again, and no
// other card shows it. The card's controls are in
// ui/log-view/ask-step-block.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { ask, boot, setAsks, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskEntry = import("../shared/types.ts").AskEntry;

setUpInboxTests();

const { t } = translatorFor("en");

const mcpStep = (id: string, name: string): AskEntry => ({
  ...ask(id, "a1", "/integrations/mcp"),
  step: { kind: "mcp-sign-in", name, scope: "personal", ownerUserId: "u1" },
});
const TARGET = mcpStep("0000ee01", "mail");
const OTHER = mcpStep("0000ee02", "notes");

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => {});
}

const resultsIn = (view: View, id: string) => [
  ...view.container.querySelectorAll<HTMLElement>(
    `[data-ask="${id}"] [data-ask-mcp-sign-in-result]`,
  ),
];

it("shows a failed sign-in in the card of the ask it came back to, with the Sign in again", async () => {
  setAsks([TARGET, OTHER]);
  const view = await boot(`/inbox/asks/${TARGET.id}?mcpSignIn=denied`);
  await settle();
  // The code is read once: the address no longer carries it.
  expect(window.location.search).toBe("");
  const notes = resultsIn(view, TARGET.id);
  expect(
    notes.map((n) => n.getAttribute("data-ask-mcp-sign-in-result")),
  ).toEqual(["denied"]);
  // The Integrations page's words for the same code.
  expect(notes[0].textContent).toBe(
    t("settings.mcpServers.signInError.denied"),
  );
  expect(
    view.container.querySelector(
      `[data-ask="${TARGET.id}"] [data-ask-mcp-sign-in]`,
    ),
  ).not.toBeNull();
  // Not on the other ask with the same step kind.
  expect(resultsIn(view, OTHER.id)).toEqual([]);
  expect(
    view.container.querySelector(
      `[data-ask="${OTHER.id}"] [data-ask-mcp-sign-in]`,
    ),
  ).not.toBeNull();
});
