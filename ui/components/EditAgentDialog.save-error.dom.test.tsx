// A save the server refuses (task 6f802809; Nil, 2026-11-09: Save on Web
// "does nothing" and the dialog still asks to discard). The refusal shows
// once, as an alert next to Save, so it is in view where the member clicked;
// the field it is about is marked and scrolled into view, never focused, and
// carries no second copy. A folder refusal points to the working directory
// when the member may change it.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const { AGENT_PACK_PRESETS } = await import("../../shared/agent-access.ts");
const {
  REFUSAL,
  agentAt,
  cleanup,
  pick,
  renderEdit,
  renderSpawn,
  route,
  save,
  settle,
  shim,
  user,
  viewer,
} = await import("../test-support/access-slider-fixture.tsx");
const { room } = await import("../test-support/claude-limits-fixture.tsx");

function saveButton(container: HTMLElement) {
  return [...container.querySelectorAll("button")].at(-1)!;
}

function cwdInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    ".agent-directory-field input",
  );
  if (!input) throw new Error("no working directory input");
  return input;
}

function nameInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    ".agent-identity-section input",
  );
  if (!input) throw new Error("no name input");
  return input;
}

// The alerts that carry the server's refusal.
function refusalAlerts(container: HTMLElement) {
  return [...container.querySelectorAll('[role="alert"]')].filter((el) =>
    el.textContent?.includes(REFUSAL),
  );
}

function timesShown(container: HTMLElement) {
  return (container.textContent ?? "").split(REFUSAL).length - 1;
}

function lowestCommonAncestor(a: Element, b: Element): Element {
  let node: Element | null = a;
  while (node && !node.contains(b)) node = node.parentElement;
  if (!node) throw new Error("no common ancestor");
  return node;
}

// Where the refusal is, as plain values. `beside` is false when the alert
// and Save meet only at an element that also holds `field`, that is, the
// alert sits in the scrolling form, not next to Save.
function shown(container: HTMLElement, field: HTMLElement) {
  const alerts = refusalAlerts(container);
  return {
    alerts: alerts.length,
    times: timesShown(container),
    beside:
      alerts.length === 1 &&
      !lowestCommonAncestor(alerts[0], saveButton(container)).contains(field),
  };
}

const invalid = (el: HTMLElement) => el.getAttribute("aria-invalid") === "true";

// Records the elements scrolled into view and the element focused at each
// call, so a test can tell "scrolled" from "focused".
// The restore puts back the property as it was, own or inherited: an own
// property left behind would hide a later file's stub on Element.prototype.
function watchScrolls() {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  const scrolled: Element[] = [];
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  return {
    scrolled,
    restore: () => {
      if (original) Object.defineProperty(proto, "scrollIntoView", original);
      else Reflect.deleteProperty(proto, "scrollIntoView");
    },
  };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

describe("a refused save", () => {
  it("shows the folder refusal once, next to Save, and keeps the dialog open", async () => {
    let closed = 0;
    shim({ refuse: { route: "PUT :id/access", code: "folder_not_allowed" } });
    const view = renderEdit(agentAt("standard"), () => closed++);
    try {
      await settle();
      await pick(view.container, "web");
      await save(view.container);
      expect({
        closed,
        ...shown(view.container, cwdInput(view.container)),
      }).toEqual({ closed: 0, alerts: 1, times: 1, beside: true });
    } finally {
      cleanup(view);
    }
  });

  it("marks the working directory, scrolls it into view without focus, and points to it; editing the folder clears both, and the next Save stores the pick and closes", async () => {
    let closed = 0;
    const opts: Parameters<typeof shim>[0] = {
      refuse: { route: "PUT :id/access", code: "folder_not_allowed" },
    };
    const calls = shim(opts);
    const scrolls = watchScrolls();
    const view = renderEdit(agentAt("standard"), () => closed++);
    try {
      await settle();
      const cwd = cwdInput(view.container);
      // The enabling condition: nothing is marked before the save.
      expect({
        invalid: invalid(cwd),
        alerts: refusalAlerts(view.container).length,
      }).toEqual({ invalid: false, alerts: 0 });
      await pick(view.container, "web");
      const save1 = saveButton(view.container);
      save1.focus();
      await save(view.container);
      const [alert] = refusalAlerts(view.container);
      expect({
        invalid: invalid(cwd),
        scrolled: scrolls.scrolled.includes(cwd),
        focusOnField: document.activeElement === cwd,
        // The pointer to the folder is part of the alert, after the reason.
        pointer: (alert?.textContent ?? "").trim().length > REFUSAL.length,
      }).toEqual({
        invalid: true,
        scrolled: true,
        focusOnField: false,
        pointer: true,
      });

      await type(cwd, "/srv/own-folder");
      expect({
        invalid: invalid(cwd),
        alerts: refusalAlerts(view.container).length,
      }).toEqual({ invalid: false, alerts: 0 });

      opts.refuse = undefined;
      calls.length = 0;
      await save(view.container);
      // Web carries a pack too (EditAgentDialog.access.dom.test.tsx); the
      // stop is what this save must store.
      expect({
        closed,
        order: calls.map(route),
        access: (calls.at(-1)?.body as { access?: unknown } | undefined)
          ?.access,
      }).toEqual({
        closed: 1,
        order: ["PATCH :id", "PUT :id/access"],
        access: "web",
      });
    } finally {
      scrolls.restore();
      cleanup(view);
    }
  });

  // A member with a permission pack sets no folder (their agents work in
  // their room's folder): the field is not theirs to change, so the reason
  // stands alone.
  it("for a member who sets no folder: the reason next to Save, with no mark and no pointer", async () => {
    shim({ refuse: { route: "POST /api/agents", code: "folder_not_allowed" } });
    const packed = {
      ...user("packed", "Packed", "member"),
      pack: {
        areas: AGENT_PACK_PRESETS.asksOnly.areas!,
        agentCeiling: "web" as const,
      },
    };
    const scrolls = watchScrolls();
    const view = renderSpawn(
      { ...viewer([]), userId: "packed", username: "Packed", role: "member" },
      packed,
      { ...room, cwd: "/srv/studio" },
    );
    try {
      await settle();
      const cwd = cwdInput(view.container);
      // The enabling condition: the field is read-only for this member.
      expect(cwd.readOnly).toBe(true);
      await save(view.container);
      const [alert] = refusalAlerts(view.container);
      expect({
        ...shown(view.container, cwd),
        text: alert?.textContent?.trim(),
        invalid: invalid(cwd),
        scrolled: scrolls.scrolled.includes(cwd),
      }).toEqual({
        alerts: 1,
        times: 1,
        beside: true,
        text: REFUSAL,
        invalid: false,
        scrolled: false,
      });
    } finally {
      scrolls.restore();
      cleanup(view);
    }
  });

  it("a refusal about no field (the engine) shows the reason next to Save and marks no field", async () => {
    shim({
      refuse: { route: "PUT :id/access", code: "engine_below_standard" },
    });
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await pick(view.container, "folder");
      await save(view.container);
      const cwd = cwdInput(view.container);
      const [alert] = refusalAlerts(view.container);
      expect({
        ...shown(view.container, cwd),
        text: alert?.textContent?.trim(),
        cwd: invalid(cwd),
        name: invalid(nameInput(view.container)),
      }).toEqual({
        alerts: 1,
        times: 1,
        beside: true,
        text: REFUSAL,
        cwd: false,
        name: false,
      });
    } finally {
      cleanup(view);
    }
  });

  it("a taken name: the reason next to Save, the Name field marked and scrolled into view, and editing the name clears it", async () => {
    shim({ refuse: { route: "PATCH :id", code: "name_taken" } });
    const scrolls = watchScrolls();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      const name = nameInput(view.container);
      await type(name, "Taken");
      // A rename alone is fire-and-forget today; a cwd change makes the save
      // wait for the server, so the refusal can reach the dialog.
      await type(cwdInput(view.container), "/srv/elsewhere");
      await save(view.container);
      expect({
        ...shown(view.container, name),
        name: invalid(name),
        cwd: invalid(cwdInput(view.container)),
        scrolled: scrolls.scrolled.includes(name),
      }).toEqual({
        alerts: 1,
        times: 1,
        beside: true,
        name: true,
        cwd: false,
        scrolled: true,
      });
      await type(name, "Free");
      expect({
        name: invalid(name),
        alerts: refusalAlerts(view.container).length,
      }).toEqual({ name: false, alerts: 0 });
    } finally {
      scrolls.restore();
      cleanup(view);
    }
  });
});
