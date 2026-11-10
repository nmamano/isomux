// The access slider of the agent dialog (task e77304b1, merge B): what a save
// sends. A stop change is one PUT /access, never PUT /privileged; it runs
// before the PATCH when the target is Standard or above, after it when the
// target is below, and always before a manager transfer. The body is the
// stop alone (task 82da687b: no pack). What shows below Standard is in
// EditAgentDialog.pack.dom.test.tsx, and the engines in
// EditAgentDialog.access-slider.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const {
  REFUSAL,
  agentAt,
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

describe("the access slider saves", () => {
  it("each stop as exactly one PUT /access with its body, and never PUT /privileged", async () => {
    const targets: Array<[AgentAccess, AgentAccess, unknown]> = [
      ["standard", "chat", { access: "chat" }],
      ["privileged", "standard", { access: "standard" }],
      ["office", "standard", { access: "standard" }],
      ["standard", "office", { access: "office" }],
      ["office", "web", { access: "web" }],
    ];
    for (const [from, to, body] of targets) {
      const calls = shim();
      const view = renderEdit(agentAt(from));
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

  // Same stop, nothing to save: no PUT, and no note that saving restarts the
  // session. Each pair of stops shows the same lines under the slider, so
  // one more line is the note.
  it("nothing, and no restart note, when the slider comes back to the saved stop", async () => {
    const pairs = [
      ["office", "folder"],
      ["folder", "web"],
      ["standard", "privileged"],
    ] as const;
    for (const [saved, other] of pairs) {
      const calls = shim();
      const view = renderEdit(agentAt(saved));
      try {
        await settle();
        await settle();
        const lines = () =>
          view.container.querySelectorAll(".agent-access-field p").length;
        const atOpen = lines();
        await pick(view.container, other);
        // The enabling condition: a moved slider shows the note.
        expect({ saved, lines: lines() }).toEqual({ saved, lines: atOpen + 1 });
        await pick(view.container, saved);
        await save(view.container);
        expect({ saved, calls, lines: lines() }).toEqual({
          saved,
          calls: [],
          lines: atOpen,
        });
      } finally {
        cleanup(view);
      }
    }
  });

  it("a rename at an unchanged stop as the PATCH alone", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("folder"));
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
    const view = renderEdit(agentAt("folder"));
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
    const view = renderEdit(agentAt("office"), () => {}, {
      ...viewer([]),
      userId: "peer",
      username: "Peer",
      role: "member",
    });
    try {
      await settle();
      expect(view.container.querySelector("[data-access-stop]")).toBeNull();
    } finally {
      cleanup(view);
    }
  });
});
