// The automatic-handoff switch in the agent edit dialog: shown for an engine
// that reports the measure, sent as autoHandoff on save, absent otherwise.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent } = await import("@testing-library/react");
const { claudeAgent, renderEdit, settle, shimRequests } =
  await import("../test-support/claude-limits-fixture.tsx");

const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-auto-handoff");

async function save(container: HTMLElement) {
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

describe("edit dialog automatic handoff switch", () => {
  it("is off for an agent without the setting, and saving it on sends autoHandoff", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: true }]);
    } finally {
      view.unmount();
    }
  });

  it("shows an agent's setting and sends the switch off", async () => {
    const patches = shimRequests();
    const agent = { ...claudeAgent("opus", "default", []), autoHandoff: true };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(true);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: false }]);
    } finally {
      view.unmount();
    }
  });

  it("is hidden when the agent's engine cannot report the measure", async () => {
    shimRequests();
    const base = claudeAgent("opus", "default", []);
    const agent = {
      ...base,
      capabilities: { ...base.capabilities, autoHandoff: false },
    };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      expect(toggle(view.container)).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

// The threshold field under the switch: in thousands of tokens, shown and sent
// only while the switch is on, and never rewriting a value it did not change.
const { render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { room, viewer } =
  await import("../test-support/claude-limits-fixture.tsx");

const field = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-auto-handoff-tokens");

function typeTokens(container: HTMLElement, value: string) {
  fireEvent.change(field(container)!, { target: { value } });
}

describe("edit dialog automatic handoff threshold", () => {
  const withSwitch = (autoHandoffTokens?: number) => ({
    ...claudeAgent("opus", "default", []),
    autoHandoff: true,
    ...(autoHandoffTokens === undefined ? {} : { autoHandoffTokens }),
  });

  it("shows only while the switch is on, at the default for an agent without a value", async () => {
    shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      expect(field(view.container)).toBeNull();
      fireEvent.click(toggle(view.container)!);
      await settle();
      expect(field(view.container)?.value).toBe("500");
    } finally {
      view.unmount();
    }
  });

  it("shows the agent's value in thousands and sends a changed one in tokens", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(withSwitch(300_000), []);
    try {
      await settle();
      expect(field(view.container)?.value).toBe("300");
      typeTokens(view.container, "250");
      await save(view.container);
      expect(patches).toEqual([{ autoHandoffTokens: 250_000 }]);
    } finally {
      view.unmount();
    }
  });

  it("takes a fraction of a thousand that is a whole number of tokens", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(withSwitch(), []);
    try {
      await settle();
      typeTokens(view.container, "123.5");
      await save(view.container);
      expect(patches).toEqual([{ autoHandoffTokens: 123_500 }]);
    } finally {
      view.unmount();
    }
  });

  it("leaves a value set through the API alone when another field is saved", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(withSwitch(123_456), []);
    try {
      await settle();
      const name = view.container.querySelector("input") as HTMLInputElement;
      fireEvent.change(name, { target: { value: "Renamed" } });
      await save(view.container);
      expect(patches).toHaveLength(1);
      expect(patches[0]).not.toHaveProperty("autoHandoffTokens");
      expect(patches[0]).toMatchObject({ name: "Renamed" });
    } finally {
      view.unmount();
    }
  });

  it("blocks Save on a value that is empty, not a number, out of range or not a whole number of tokens", async () => {
    for (const bad of ["", "abc", "49", "10001", "123.4567"]) {
      const patches = shimRequests();
      const { view } = renderEdit(withSwitch(), []);
      try {
        await settle();
        // A valid edit elsewhere, so a save would otherwise send something.
        const name = view.container.querySelector("input") as HTMLInputElement;
        fireEvent.change(name, { target: { value: "Renamed" } });
        typeTokens(view.container, bad);
        await save(view.container);
        expect({ bad, patches }).toEqual({ bad, patches: [] });
      } finally {
        view.unmount();
      }
    }
  });

  it("accepts both ends of the range", async () => {
    for (const [typed, tokens] of [
      ["50", 50_000],
      ["10000", 10_000_000],
    ] as const) {
      const patches = shimRequests();
      const { view } = renderEdit(withSwitch(), []);
      try {
        await settle();
        typeTokens(view.container, typed);
        await save(view.container);
        expect(patches).toEqual([{ autoHandoffTokens: tokens }]);
      } finally {
        view.unmount();
      }
    }
  });

  it("a hidden value neither blocks Save nor is sent", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(withSwitch(), []);
    try {
      await settle();
      typeTokens(view.container, "abc");
      fireEvent.click(toggle(view.container)!);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: false }]);
    } finally {
      view.unmount();
    }
  });
});

describe("spawn dialog automatic handoff threshold", () => {
  // Records the spawn POST and the follow-up PATCH.
  function shimSpawn(): { method: string; body: unknown }[] {
    const writes: { method: string; body: unknown }[] = [];
    setApiShim(async (method, path, body) => {
      if (method === "POST" && path === "/api/agents") {
        writes.push({ method, body });
        return { agent: { id: "new-agent" } };
      }
      if (method === "PATCH") writes.push({ method, body });
      if (path === "/api/validate/cwd") return { ok: true };
      if (path.startsWith("/api/memory"))
        return { text: "", version: "v1", size: 0, cap: 5000 };
      if (path.includes("/sessions"))
        return { sessions: [], currentSessionId: null };
      if (path.startsWith("/api/backends/")) return { models: [] };
      return {};
    });
    return writes;
  }

  function renderSpawn() {
    return render(
      onLanguage(
        "en",
        <EditAgentDialog
          onClose={() => {}}
          deskIndex={0}
          roomId={room.id}
          defaultCwd="~"
          spawnAgentType="claude"
        />,
        {
          rooms: [room],
          agents: [],
          hasReceivedInitialState: true,
          sessionContext: viewer([]),
        },
      ),
    );
  }

  for (const [typed, expected] of [
    ["300", { autoHandoff: true, autoHandoffTokens: 300_000 }],
    ["500", { autoHandoff: true }],
  ] as const) {
    it(`sends ${typed}k in the follow-up edit only when it is not the default`, async () => {
      const writes = shimSpawn();
      const view = renderSpawn();
      try {
        await settle();
        fireEvent.click(toggle(view.container)!);
        await settle();
        typeTokens(view.container, typed);
        await save(view.container);
        expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
        expect(writes[0].body).not.toHaveProperty("autoHandoffTokens");
        expect(writes[1].body).toEqual(expected);
      } finally {
        view.unmount();
      }
    });
  }
});
