// The cronjob dialog's monthly schedule and agent target (task a0c26f59): the
// monthly choice has a day input and saves {type:"monthly"}; "message an agent"
// hides the session fields and saves the target; an edit sends the target only
// when it changed, so a job whose agent is gone stays editable; and the switch
// back to a session sends target null. The agent select groups agents by
// room (task 899360d3).

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { GROUP_AGENTS, GROUP_ROOMS, GROUPED_SELECT, selectGroups } =
  await import("../test-support/agent-groups-fixture.ts");
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
  const save = async () => {
    const buttons = [...view.container.querySelectorAll("button")];
    await act(async () => {
      fireEvent.click(buttons.at(-1)!);
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(closed).toBe(true));
    return sent[0];
  };
  return { view, q, change, save };
}

function targetJob(agentId: string): CronjobListWire {
  return {
    id: "c0ffee01",
    name: "Health",
    schedule: { type: "monthly", day: 31, hour: 9, minute: 0 },
    prompt: "Run the health check.",
    target: { kind: "agent", agentId },
    cwd: "~",
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

it("offers monthly with a day of the month, and saves it", async () => {
  const { view, q, change, save } = open();
  const option = q('option[value="monthly"]');
  expect(option).not.toBeNull();
  change(option!.closest("select")!, "monthly");
  const day = q<HTMLInputElement>('[data-field="day"]');
  expect(day).not.toBeNull();
  change(day!, "31");
  change(q("textarea")!, "Send the invoices.");
  const { method, body } = await save();
  expect(method).toBe("POST");
  const schedule = (body as { schedule: Record<string, unknown> }).schedule;
  expect(schedule).toMatchObject({ type: "monthly", day: 31 });
  expect(typeof schedule.hour).toBe("number");
  expect(typeof schedule.minute).toBe("number");
  view.unmount();
});

it("message an agent hides the session fields and saves the target", async () => {
  const { view, q, change, save } = open();
  // A new schedule opens as a session, with its engine choice.
  expect(q('option[value="codex"]')).not.toBeNull();
  expect(q('[data-field="agentId"]')).toBeNull();
  act(() => {
    fireEvent.click(q('[data-target-kind="agent"]')!);
  });
  expect(q('option[value="codex"]')).toBeNull();
  change(q('[data-field="agentId"]')!, "a1");
  change(q("textarea")!, "Run the health check.");
  const { method, body } = await save();
  expect(method).toBe("POST");
  expect((body as { target?: unknown }).target).toEqual({
    kind: "agent",
    agentId: "a1",
  });
  view.unmount();
});

it("an edit of a job whose agent is gone keeps that agent selected and does not send the target", async () => {
  const { view, q, change, save } = open(targetJob("agent-gone"));
  expect(q<HTMLSelectElement>('[data-field="agentId"]')!.value).toBe(
    "agent-gone",
  );
  expect(q('option[value="codex"]')).toBeNull();
  change(q("textarea")!, "Run the health check, then report.");
  const { method, body } = await save();
  expect(method).toBe("PATCH");
  expect(body).toMatchObject({ prompt: "Run the health check, then report." });
  expect(Object.prototype.hasOwnProperty.call(body, "target")).toBe(false);
  view.unmount();
});

it("switching an agent-target job back to a new session sends target null", async () => {
  const { view, q, save } = open(targetJob("a1"));
  act(() => {
    fireEvent.click(q('[data-target-kind="session"]')!);
  });
  expect(q('option[value="codex"]')).not.toBeNull();
  const { method, body } = await save();
  expect(method).toBe("PATCH");
  expect((body as { target?: unknown }).target).toBeNull();
  view.unmount();
});

it("the target agent select groups agents by room, after the placeholder", () => {
  const view = render(
    onLanguage(null, createElement(CronjobDialog, { onClose: () => {} }), {
      rooms: GROUP_ROOMS as never,
      agents: GROUP_AGENTS as unknown as AgentInfo[],
      hasReceivedInitialState: true,
    }),
  );
  act(() => {
    fireEvent.click(
      view.container.querySelector('[data-target-kind="agent"]')!,
    );
  });
  const select = view.container.querySelector<HTMLSelectElement>(
    '[data-field="agentId"]',
  )!;
  expect(selectGroups(select)).toEqual(["", ...GROUPED_SELECT]);
  for (const group of select.querySelectorAll("optgroup"))
    expect(group.closest("[translate=no]")).not.toBeNull();
  view.unmount();
});
