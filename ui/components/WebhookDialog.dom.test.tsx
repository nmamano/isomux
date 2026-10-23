// The webhook dialog: an edit sends only what changed and never the scheme,
// a target the viewer cannot pick stays selected until the member changes
// it, and a new hook posts only once a target is chosen.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { WebhookDialog } = await import("./WebhookDialog.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { hookWire, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

let sent: { method: string; path: string; body: unknown }[] = [];
setApiShim(async (method, path, body) => {
  sent.push({ method, path, body });
  return {};
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  sent = [];
});

it("an edit of the name sends only the name", async () => {
  let closed = false;
  const view = render(
    onLanguage(
      "en",
      <WebhookDialog
        webhook={hookWire({
          target: { kind: "agent", agentId: "agent-gone", note: "Look." },
        })}
        onClose={() => {
          closed = true;
        }}
      />,
      { agents: [] },
    ),
  );
  // The unavailable agent stays the selected target.
  const agent = view.container.querySelector<HTMLSelectElement>(
    '[data-field="agentId"]',
  )!;
  expect(agent.value).toBe("agent-gone");
  const name = view.container.querySelector<HTMLInputElement>(
    '[data-field="name"]',
  )!;
  act(() => {
    fireEvent.change(name, { target: { value: "pr-review-2" } });
  });
  await act(async () =>
    view.container.querySelector<HTMLElement>("[data-webhook-save]")!.click(),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].method).toBe("PATCH");
  expect(sent[0].path).toBe(`/api/webhooks/${HOOK_ID}`);
  expect(sent[0].body).toEqual({ name: "pr-review-2" });
  await waitFor(() => expect(closed).toBe(true));
  view.unmount();
});

it("a new hook cannot be saved before a target is chosen, and then posts it", async () => {
  const agents = [{ id: "a1", name: "Bot" } as unknown as AgentInfo];
  const view = render(
    onLanguage("en", <WebhookDialog onClose={() => {}} />, { agents }),
  );
  const save = view.container.querySelector<HTMLButtonElement>(
    "[data-webhook-save]",
  )!;
  expect(save.disabled).toBe(true);
  await act(async () => save.click());
  expect(sent).toHaveLength(0);
  // Once an agent is chosen, the click creates the hook.
  const agent = view.container.querySelector<HTMLSelectElement>(
    '[data-field="agentId"]',
  )!;
  act(() => {
    fireEvent.change(agent, { target: { value: "a1" } });
  });
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(sent).toHaveLength(1);
  expect(sent[0].method).toBe("POST");
  expect(sent[0].path).toBe("/api/webhooks");
  const body = sent[0].body as { scheme: string; target: unknown };
  expect(body.scheme).toBe("github-hmac-sha256");
  expect(body.target).toEqual({ kind: "agent", agentId: "a1" });
  view.unmount();
});
