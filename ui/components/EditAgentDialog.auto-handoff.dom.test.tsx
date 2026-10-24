// The usage switches in the agent edit dialog: automatic handoff and resume
// after a usage limit. Each shows for an engine that reports what it needs,
// and is sent on save.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent } = await import("@testing-library/react");
const { claudeAgent, renderEdit, settle, shimRequests } =
  await import("../test-support/claude-limits-fixture.tsx");
const { AUTO_HANDOFF_DEFAULT_TOKENS } =
  await import("../../shared/auto-handoff.ts");

const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-auto-handoff");
const limitResumeToggle = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-limit-resume");
const field = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-auto-handoff-tokens");

async function save(container: HTMLElement) {
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

describe("edit dialog usage switches", () => {
  it("each switch shows only when the agent's engine reports what it needs", async () => {
    for (const [autoHandoff, limitResume] of [
      [false, true],
      [true, false],
    ]) {
      shimRequests();
      const base = claudeAgent("opus", "default", []);
      const agent = {
        ...base,
        capabilities: { ...base.capabilities, autoHandoff, limitResume },
      };
      const { view } = renderEdit(agent, []);
      try {
        await settle();
        expect({
          autoHandoff: toggle(view.container) !== null,
          limitResume: limitResumeToggle(view.container) !== null,
        }).toEqual({ autoHandoff, limitResume });
      } finally {
        view.unmount();
      }
    }
  });
});

describe("edit dialog automatic handoff switch", () => {
  it("is on with the default threshold for an agent with no stored value, and saving it off sends autoHandoff false and no threshold", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(true);
      expect(field(view.container)?.value).toBe(
        String(AUTO_HANDOFF_DEFAULT_TOKENS / 1000),
      );
      fireEvent.click(box);
      await settle();
      expect(field(view.container)).toBeNull();
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: false }]);
    } finally {
      view.unmount();
    }
  });

  it("shows an agent's switch off with no threshold; switching it on shows the default and sends autoHandoff true", async () => {
    const patches = shimRequests();
    const agent = { ...claudeAgent("opus", "default", []), autoHandoff: false };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(false);
      expect(field(view.container)).toBeNull();
      fireEvent.click(box);
      await settle();
      expect(field(view.container)?.value).toBe(
        String(AUTO_HANDOFF_DEFAULT_TOKENS / 1000),
      );
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: true }]);
    } finally {
      view.unmount();
    }
  });
});

describe("edit dialog resume-after-usage-limit switch", () => {
  it("is on for an agent with no stored value, and saving it off sends limitResume false", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      const box = limitResumeToggle(view.container)!;
      expect(box.checked).toBe(true);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ limitResume: false }]);
    } finally {
      view.unmount();
    }
  });

  it("shows an agent's switch off and sends it on", async () => {
    const patches = shimRequests();
    const agent = { ...claudeAgent("opus", "default", []), limitResume: false };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      const box = limitResumeToggle(view.container)!;
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ limitResume: true }]);
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

function typeTokens(container: HTMLElement, value: string) {
  fireEvent.change(field(container)!, { target: { value } });
}

describe("edit dialog automatic handoff threshold", () => {
  const withSwitch = (autoHandoffTokens?: number) => ({
    ...claudeAgent("opus", "default", []),
    autoHandoff: true,
    ...(autoHandoffTokens === undefined ? {} : { autoHandoffTokens }),
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
    // One render for every value: the DOM file has a wall-clock cap.
    const patches = shimRequests();
    const { view } = renderEdit(withSwitch(), []);
    try {
      await settle();
      // A valid edit elsewhere, so a save would otherwise send something.
      const name = view.container.querySelector("input") as HTMLInputElement;
      fireEvent.change(name, { target: { value: "Renamed" } });
      const invalid = () =>
        field(view.container)?.getAttribute("aria-invalid") ?? null;
      for (const bad of ["", "abc", "49", "10001", "123.4567"]) {
        // A valid value first clears the last value's error.
        typeTokens(view.container, "300");
        await settle();
        const before = invalid();
        typeTokens(view.container, bad);
        await save(view.container);
        expect({ bad, before, after: invalid(), patches }).toEqual({
          bad,
          before: "false",
          after: "true",
          patches: [],
        });
      }
    } finally {
      view.unmount();
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
      expect(toggle(view.container)!.checked).toBe(true);
      typeTokens(view.container, "abc");
      fireEvent.click(toggle(view.container)!);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: false }]);
    } finally {
      view.unmount();
    }
  });
});

describe("spawn dialog automatic handoff", () => {
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

  // The switch starts on; the follow-up edit carries only what differs from
  // the defaults, and a spawn at the defaults sends none.
  for (const [name, act, expected] of [
    ["at the defaults", () => {}, null],
    [
      "with the switch left on and the threshold at 300k",
      (c: HTMLElement) => typeTokens(c, "300"),
      { autoHandoffTokens: 300_000 },
    ],
    [
      "with the switch off",
      (c: HTMLElement) => fireEvent.click(toggle(c)!),
      { autoHandoff: false },
    ],
  ] as const) {
    it(`spawns ${name}`, async () => {
      const writes = shimSpawn();
      const view = renderSpawn();
      try {
        await settle();
        expect(toggle(view.container)!.checked).toBe(true);
        act(view.container);
        await settle();
        await save(view.container);
        expect(writes.map((w) => w.method)).toEqual(
          expected === null ? ["POST"] : ["POST", "PATCH"],
        );
        expect(writes[0].body).not.toHaveProperty("autoHandoff");
        expect(writes[0].body).not.toHaveProperty("autoHandoffTokens");
        if (expected !== null) expect(writes[1].body).toEqual(expected);
      } finally {
        view.unmount();
      }
    });
  }
});
