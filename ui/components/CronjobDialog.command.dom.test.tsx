// The schedule dialog's command choice (task ab6851f2): "run a command" shows
// a command, a folder and the agent to message, hides the engine fields, and
// saves {command, target, cwd}; an edit of a command job opens on it; a switch
// away from it sends command null.
//
// Hooks: [data-target-kind="command"] (the choice), [data-field="command"],
// [data-field="cwd"], [data-field="agentId"].

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;

let sent: { method: string; path: string; body: unknown }[] = [];
setApiShim(async (method, path, body) => {
  if (path === "/api/validate/cwd") return { ok: true };
  if (path.startsWith("/api/cronjobs")) {
    sent.push({ method, path, body });
    return {};
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  sent = [];
});

const AGENTS = [{ id: "a1", name: "Pat" } as unknown as AgentInfo];
const COMMAND = "./scripts/check-main.sh";

function open(cronjob?: CronjobListWire) {
  let closed = false;
  const view = render(
    onLanguage(
      null,
      createElement(CronjobDialog, {
        ...(cronjob ? { cronjob } : {}),
        onClose: () => {
          closed = true;
        },
      }),
      { rooms: [], agents: AGENTS, hasReceivedInitialState: true },
    ),
  );
  const q = <T extends Element>(selector: string) =>
    view.container.querySelector<T>(selector);
  const change = (el: Element, value: string) =>
    act(() => {
      fireEvent.change(el, { target: { value } });
    });
  const pick = (kind: string) =>
    act(() => {
      fireEvent.click(q(`[data-target-kind="${kind}"]`)!);
    });
  const save = async () => {
    const buttons = [...view.container.querySelectorAll("button")];
    await act(async () => {
      fireEvent.click(buttons.at(-1)!);
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(closed).toBe(true));
    return sent[0]!;
  };
  return { view, q, change, pick, save };
}

function commandJob(): CronjobListWire {
  return {
    id: "c0ffee02",
    name: "Main check",
    schedule: { type: "interval", minutes: 60 },
    prompt: "",
    target: { kind: "agent", agentId: "a1" },
    command: COMMAND,
    cwd: "/srv/repo",
    agentType: "claude",
    modelFamily: "opus",
    effort: "high",
    permissionMode: "bypassPermissions",
    enabled: true,
    createdBy: "Nil",
    userId: "u-1",
    username: "Nil",
    createdAt: 1,
    lastFireAt: null,
    nextFireAt: 2,
    canManage: true,
  };
}

it("run a command shows the command, folder and agent fields, hides the engine, and saves them with no prompt", async () => {
  const { view, q, change, pick, save } = open();
  expect(q('[data-field="command"]') === null).toBe(true);
  pick("command");
  expect(q('.engine-options button[data-engine="codex"]') === null).toBe(true);
  const command = q<HTMLTextAreaElement>('[data-field="command"]');
  const cwd = q<HTMLInputElement>('[data-field="cwd"]');
  const agent = q<HTMLSelectElement>('[data-field="agentId"]');
  expect([command !== null, cwd !== null, agent !== null]).toEqual([
    true,
    true,
    true,
  ]);
  change(command!, COMMAND);
  change(cwd!, "/srv/repo");
  change(agent!, "a1");
  const { method, body } = await save();
  expect(method).toBe("POST");
  expect(body).toMatchObject({
    command: COMMAND,
    cwd: "/srv/repo",
    target: { kind: "agent", agentId: "a1" },
  });
  expect((body as { prompt?: unknown }).prompt ?? "").toBe("");
  view.unmount();
});

it("an edit of a command job opens on the command choice and does not resend what did not change", async () => {
  const { view, q, change, save } = open(commandJob());
  expect(q<HTMLInputElement>('[data-target-kind="command"]')!.checked).toBe(
    true,
  );
  expect(q<HTMLTextAreaElement>('[data-field="command"]')!.value).toBe(COMMAND);
  expect(q<HTMLInputElement>('[data-field="cwd"]')!.value).toBe("/srv/repo");
  change(q('[data-field="command"]')!, `${COMMAND} --strict`);
  const { method, body } = await save();
  expect(method).toBe("PATCH");
  expect(body).toMatchObject({ command: `${COMMAND} --strict` });
  expect(Object.prototype.hasOwnProperty.call(body, "target")).toBe(false);
  view.unmount();
});

it("switching a command job to message an agent sends command null and keeps the target", async () => {
  const { view, q, change, pick, save } = open(commandJob());
  pick("agent");
  expect(q('[data-field="command"]') === null).toBe(true);
  // A job that only messages needs a prompt.
  change(q("textarea")!, "Run the health check.");
  const { body } = await save();
  expect((body as { command?: unknown }).command).toBeNull();
  expect(Object.prototype.hasOwnProperty.call(body, "target")).toBe(false);
  view.unmount();
});

it("switching a command job to a new session sends command null and target null", async () => {
  const { view, pick, change, q, save } = open(commandJob());
  pick("session");
  expect(q('.engine-options button[data-engine="codex"]') !== null).toBe(true);
  change(q("textarea")!, "Run the health check.");
  const { body } = await save();
  expect(body).toMatchObject({ command: null, target: null });
  view.unmount();
});
