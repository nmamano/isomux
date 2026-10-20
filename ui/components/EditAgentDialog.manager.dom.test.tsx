// The Manager field of the agent edit dialog (task 6a9deaba): an office owner
// picks any member, a member sees the manager read-only. Saving a new manager
// is its own PUT, after the PATCH and before the privilege PUT, and a member
// without access to the agent's room gets a hint, never a block.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { claudeAgent, room, settle, viewer } =
  await import("../test-support/claude-limits-fixture.tsx");

type Role = "owner" | "member";

function user(id: string, name: string, role: Role, allowedRooms: string[]) {
  return { ...selfUserRecord(null), id, name, role, allowedRooms };
}

// The agent's manager is Member; Peer reaches the agent's room, Other does not.
const users = new Map(
  [
    user("owner", "Owner", "owner", []),
    user("member", "Member", "member", [room.id]),
    user("peer", "Peer", "member", [room.id]),
    user("other", "Other", "member", []),
  ].map((u) => [u.name.toLowerCase(), u]),
);

function renderAs(
  role: Role,
  agent: ReturnType<typeof claudeAgent> = claudeAgent("opus", "default", []),
) {
  const sessionContext =
    role === "owner"
      ? viewer([])
      : { ...viewer([]), userId: "member", username: "Member", role };
  return render(
    onLanguage("en", <EditAgentDialog onClose={() => {}} agent={agent} />, {
      rooms: [room],
      agents: [agent],
      users,
      hasReceivedInitialState: true,
      sessionContext,
    }),
  );
}

const field = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".agent-manager-field")!;
const managerSelect = (container: HTMLElement) =>
  field(container).querySelector("select");
// The owner's control; the test fails here, not in fireEvent, without one.
function chosen(container: HTMLElement): HTMLSelectElement {
  const select = managerSelect(container);
  expect(select).not.toBeNull();
  return select!;
}

// The field's text outside the select, where a hint would be.
function hintText(container: HTMLElement): string {
  const f = field(container);
  return (f.textContent ?? "").replace(
    managerSelect(container)?.textContent ?? "",
    "",
  );
}

function shim(): { method: string; path: string; body: unknown }[] {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    // The dialog validates the agent's cwd when it opens; not a save.
    if (method !== "GET" && path !== "/api/validate/cwd")
      calls.push({ method, path, body });
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    return {};
  });
  return calls;
}

async function save(container: HTMLElement) {
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

describe("edit dialog manager field", () => {
  it("offers an office owner every member, with the current manager chosen", async () => {
    shim();
    const view = renderAs("owner");
    try {
      await settle();
      const select = chosen(view.container);
      expect(select.value).toBe("member");
      expect(new Set([...select.options].map((o) => o.value))).toEqual(
        new Set(["owner", "member", "peer", "other"]),
      );
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });

  // A manager with no member record (removed before a deletion passed
  // agents on): the select must not show another member as the manager.
  it("keeps a manager who is no longer a member as the chosen value", async () => {
    shim();
    const agent = {
      ...claudeAgent("opus", "default", []),
      userId: "gone",
      username: "Gone",
    };
    const view = renderAs("owner", agent);
    try {
      await settle();
      const select = chosen(view.container);
      expect(select.value).toBe("gone");
      expect(select.selectedOptions[0]?.textContent).toContain("Gone");
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });

  it("shows a member the manager without a control", async () => {
    shim();
    const view = renderAs("member");
    try {
      await settle();
      expect(managerSelect(view.container)).toBeNull();
      expect(field(view.container).textContent).toContain("Member");
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });

  it("saves a new manager with its own PUT", async () => {
    const calls = shim();
    const view = renderAs("owner");
    try {
      await settle();
      fireEvent.change(chosen(view.container), {
        target: { value: "peer" },
      });
      await save(view.container);
      expect(calls).toEqual([
        {
          method: "PUT",
          path: "/api/agents/a1/manager",
          body: { userId: "peer" },
        },
      ]);
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });

  it("orders a combined save: the PATCH, then the manager, then privilege", async () => {
    const calls = shim();
    const view = renderAs("owner");
    try {
      await settle();
      const name = view.container.querySelector("input") as HTMLInputElement;
      fireEvent.change(name, { target: { value: "Renamed" } });
      fireEvent.change(chosen(view.container), {
        target: { value: "peer" },
      });
      fireEvent.click(
        view.container.querySelector<HTMLInputElement>("#agent-privileged")!,
      );
      await save(view.container);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "PATCH /api/agents/a1",
        "PUT /api/agents/a1/manager",
        "PUT /api/agents/a1/privileged",
      ]);
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });

  it("names a chosen member who has no access to the agent's room", async () => {
    shim();
    const view = renderAs("owner");
    try {
      await settle();
      fireEvent.change(chosen(view.container), {
        target: { value: "peer" },
      });
      await settle();
      expect(hintText(view.container)).not.toContain("Peer");
      fireEvent.change(chosen(view.container), {
        target: { value: "other" },
      });
      await settle();
      expect(hintText(view.container)).toContain("Other");
    } finally {
      view.unmount();
      setApiShim(null);
    }
  });
});
