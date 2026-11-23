// The Re-enable button on a sign-in-links page (task 1492af52), through the
// real App and store. Split from App.inbox-office-ask.dom.test.tsx, which sits
// near the DOM file cap. Markers: [data-ask], button[data-ask-renew-link].

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, boot, inboxButton, setAsks, setExtraApi, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskMemberWire = import("../shared/types.ts").AskMemberWire;

setUpInboxTests();

const officeAsk = (id: string, t: number): AskMemberWire => ({
  ...ask(id, ""),
  prompt: "WhatsApp stopped\n\nThe bridge exited.",
  createdAt: t,
  updatedAt: t,
  members: ["member"],
  priority: "P1",
  office: { feature: "whatsapp", name: "WhatsApp" },
  page: { state: "ringing" },
});

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);

async function openInbox() {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  return view;
}

// A guest asked to re-enable an expired sign-in link (task 1492af52): the
// office page carries the link on the wire (signInLinkRenewal), and its card
// has a Re-enable button (button[data-ask-renew-link]) that extends that link.
// The server closes the page once the link is extended. Another office page
// has no such button.
it("Re-enable on a sign-in-links page extends its link once; a WhatsApp page has no Re-enable", async () => {
  setAsks([
    {
      ...officeAsk("q1", 3_000),
      prompt: "Someone opened Dan's sign-in link after it expired.",
      office: { feature: "sign-in-links", name: "Sign-in links" },
      signInLinkRenewal: { tokenPrefix: "abcd1234" },
    },
    officeAsk("q2", 2_000),
  ]);
  const extendCalls: string[] = [];
  setExtraApi((method, path) => {
    if (!path.startsWith("/api/invites")) return undefined;
    extendCalls.push(`${method} ${path}`);
    return Promise.resolve({ invite: {} });
  });
  const view = await openInbox();
  expect(
    card(view, "q2")?.querySelector("button[data-ask-renew-link]") ?? null,
  ).toBeNull();
  const reEnable =
    card(view, "q1")?.querySelector<HTMLButtonElement>(
      "button[data-ask-renew-link]",
    ) ?? null;
  expect(reEnable).not.toBeNull();
  await act(async () => fireEvent.click(reEnable!));
  await act(async () => {});
  expect(extendCalls).toEqual(["POST /api/invites/abcd1234/extend"]);
});
