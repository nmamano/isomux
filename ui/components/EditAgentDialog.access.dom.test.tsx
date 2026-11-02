// The access slider of the agent dialog (task e77304b1, merge B): what a save
// sends. A stop change is one PUT /access, never PUT /privileged; it runs
// before the PATCH when the target is Standard or above, after it when the
// target is below, and always before a manager transfer. The pack picker is
// in EditAgentDialog.pack.dom.test.tsx, and the engines in
// EditAgentDialog.access-slider.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const { AGENT_PACK_PRESETS } = await import("../../shared/agent-access.ts");
const {
  REFUSAL,
  agentAt,
  areaSelect,
  change,
  cleanup,
  pick,
  renderEdit,
  route,
  save,
  settle,
  shim,
  stopChecked,
  viewer,
} = await import("../test-support/access-slider-fixture.tsx");
type AgentAccess = import("../../shared/agent-access.ts").AgentAccess;
type ApiTokenLimits = import("../../shared/api-token-limits.ts").ApiTokenLimits;

describe("the access slider saves", () => {
  it("each stop as exactly one PUT /access with its body, and never PUT /privileged", async () => {
    const targets: Array<[AgentAccess, AgentAccess, unknown]> = [
      ["standard", "chat", { access: "chat" }],
      ["privileged", "standard", { access: "standard" }],
      ["office", "standard", { access: "standard" }],
    ];
    for (const [from, to, body] of targets) {
      const calls = shim();
      const view = renderEdit(
        agentAt(
          from,
          from === "office" ? AGENT_PACK_PRESETS.asksOnly : undefined,
        ),
      );
      try {
        await settle();
        expect({
          from,
          to,
          checked: stopChecked(view.container, from),
        }).toEqual({
          from,
          to,
          checked: true,
        });
        await pick(view.container, to);
        await save(view.container);
        expect({ from, to, calls }).toEqual({
          from,
          to,
          calls: [{ method: "PUT", path: "/api/agents/a1/access", body }],
        });
      } finally {
        cleanup(view);
      }
    }
  });

  it("nothing when the stop and the pack are the same in content", async () => {
    // Saved with the areas and rooms in another order than any preset.
    const saved: ApiTokenLimits = {
      areas: { tasks: "read", asks: "write" },
      rooms: ["r2", "r1"],
    };
    const calls = shim();
    const view = renderEdit(agentAt("office", saved));
    try {
      await settle();
      await settle();
      // Out to Chat and back.
      await pick(view.container, "chat");
      await pick(view.container, "office");
      // An area off and on, and a room off and on: the same content in
      // another order.
      await change(areaSelect(view.container, "tasks"), "none");
      await change(areaSelect(view.container, "tasks"), "read");
      const r2 = () =>
        view.container.querySelector<HTMLInputElement>(
          'input[data-room="r2"]',
        )!;
      await act(async () => {
        fireEvent.click(r2());
      });
      await act(async () => {
        fireEvent.click(r2());
      });
      expect(r2().checked).toBe(true);
      await save(view.container);
      expect(calls).toEqual([]);
    } finally {
      cleanup(view);
    }
  });

  it("a rename at an unchanged stop as the PATCH alone", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("folder", AGENT_PACK_PRESETS.tasksAndAsks));
    try {
      await settle();
      await change(view.container.querySelector("input")!, "Renamed");
      await save(view.container);
      expect(calls.map(route)).toEqual(["PATCH :id"]);
    } finally {
      cleanup(view);
    }
  });
});

describe("the save order", () => {
  it("below Standard: the PATCH first, so the folder rules see the new folder", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await change(
        view.container.querySelector<HTMLInputElement>(
          ".agent-directory-field input",
        )!,
        "/srv/triage",
      );
      await pick(view.container, "folder");
      await save(view.container);
      expect(calls.map(route)).toEqual(["PATCH :id", "PUT :id/access"]);
      expect(calls[0].body).toMatchObject({ cwd: "/srv/triage" });
    } finally {
      cleanup(view);
    }
  });

  it("Standard and above: the PUT /access first, so a switch to another engine is allowed", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("folder", AGENT_PACK_PRESETS.asksOnly));
    try {
      await settle();
      await pick(view.container, "standard");
      await change(
        view.container.querySelector<HTMLSelectElement>(
          ".agent-engine-control select",
        )!,
        "codex",
      );
      await save(view.container);
      expect(calls.map(route)).toEqual(["PUT :id/access", "PATCH :id"]);
      expect(calls[1].body).toMatchObject({ agentType: "codex" });
    } finally {
      cleanup(view);
    }
  });

  it("the PUT /access before a manager transfer, whichever way it goes", async () => {
    const cases: Array<[AgentAccess, string[]]> = [
      ["office", ["PATCH :id", "PUT :id/access", "PUT :id/manager"]],
      ["privileged", ["PUT :id/access", "PATCH :id", "PUT :id/manager"]],
    ];
    for (const [to, order] of cases) {
      const calls = shim();
      const view = renderEdit(agentAt("standard"));
      try {
        await settle();
        await change(view.container.querySelector("input")!, "Renamed");
        await change(
          view.container.querySelector<HTMLSelectElement>(
            ".agent-manager-field select",
          )!,
          "peer",
        );
        await pick(view.container, to);
        await save(view.container);
        expect({ to, order: calls.map(route) }).toEqual({ to, order });
      } finally {
        cleanup(view);
      }
    }
  });

  it("a refused PUT /access keeps the dialog open with the server's reason", async () => {
    let closed = 0;
    shim({ refuseAccess: true });
    const view = renderEdit(agentAt("standard"), () => closed++);
    try {
      await settle();
      await pick(view.container, "folder");
      await save(view.container);
      expect(closed).toBe(0);
      expect(view.container.textContent).toContain(REFUSAL);
    } finally {
      cleanup(view);
    }
  });
});

describe("the slider", () => {
  it("is not offered to a member who is neither the manager nor an owner", async () => {
    shim();
    const view = renderEdit(
      agentAt("office", AGENT_PACK_PRESETS.asksOnly),
      () => {},
      {
        ...viewer([]),
        userId: "peer",
        username: "Peer",
        role: "member",
      },
    );
    try {
      await settle();
      expect(view.container.querySelector("[data-access-stop]")).toBeNull();
    } finally {
      cleanup(view);
    }
  });
});
