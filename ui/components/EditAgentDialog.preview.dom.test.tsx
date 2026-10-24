import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { DEFAULT_AGENT_CAPABILITIES } = await import("../../shared/types.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
const room = {
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
};
const agent: AgentInfo = {
  id: "a1",
  name: "Saved name",
  roomId: room.id,
  desk: 0,
  cwd: "~",
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: null,
    hat: "none",
  },
  permissionMode: "bypassPermissions",
  modelFamily: "sonnet",
  effort: "high",
  state: "idle",
  topic: null,
  topicGenerating: false,
  customInstructions: "Saved instructions",
  customInstructionsVersion: "v1",
  agentType: "claude",
  capabilities: DEFAULT_AGENT_CAPABILITIES,
  userId: "u1",
  manager: "Tester",
  queue: [],
  sessionSwapping: false,
  turnMemberIds: [],
};

// The select that holds an option with this value.
function selectWith(container: HTMLElement, value: string): HTMLSelectElement {
  const found = Array.from(container.querySelectorAll("select")).find(
    (select) => select.querySelector(`option[value="${value}"]`) !== null,
  );
  if (!found) throw new Error(`no select with option ${value}`);
  return found;
}

describe("agent form prompt preview", () => {
  for (const mode of ["spawn", "edit", "spawn-codex"] as const) {
    it(`${mode} sends the current form values without saving`, async () => {
      const writes: { method: string; path: string; body: unknown }[] = [];
      setApiShim(async (method, path, body) => {
        if (path === "/api/validate/cwd") return { ok: true };
        if (method === "GET" && path.startsWith("/api/memory"))
          return { text: "Saved memory", version: "v1", size: 12, cap: 5000 };
        // The Codex form lists its engine's models.
        if (method === "GET" && path.startsWith("/api/backends/"))
          return { models: [] };
        writes.push({ method, path, body });
        if (path === "/api/agents/system-prompt-preview")
          return { prompt: "Assembled draft" };
        throw new Error(`Unexpected request: ${method} ${path}`);
      });
      const view = render(
        onLanguage(
          "en",
          <EditAgentDialog
            onClose={() => {}}
            {...(mode === "edit"
              ? { agent }
              : {
                  deskIndex: 0,
                  roomId: room.id,
                  defaultCwd: "~",
                  spawnAgentType:
                    mode === "spawn-codex"
                      ? ("codex" as const)
                      : ("claude" as const),
                })}
          />,
          {
            rooms: [room],
            agents: mode === "edit" ? [agent] : [],
            hasReceivedInitialState: true,
          },
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      if (mode === "edit")
        await waitFor(() =>
          expect(
            (
              view.container.querySelector(
                ".agent-memory-field textarea",
              ) as HTMLTextAreaElement
            )?.value,
          ).toBe("Saved memory"),
        );
      await act(async () => {
        fireEvent.change(
          view.container.querySelector(".agent-identity-section input")!,
          { target: { value: "Draft name" } },
        );
        fireEvent.change(
          view.container.querySelector(".agent-instructions-section textarea")!,
          { target: { value: "Draft instructions" } },
        );
        if (mode === "edit")
          fireEvent.change(
            view.container.querySelector(".agent-memory-field textarea")!,
            { target: { value: "" } },
          );
        // A mode or sandbox changed in the form and not saved (task
        // 11e311db): the preview shows the form's.
        if (mode === "edit")
          fireEvent.change(selectWith(view.container, "acceptEdits"), {
            target: { value: "acceptEdits" },
          });
        if (mode === "spawn-codex")
          fireEvent.change(selectWith(view.container, "read-only"), {
            target: { value: "read-only" },
          });
      });
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", {
            name: translatorFor("en").t("dialogs.agent.showSystemPrompt"),
          }),
        );
      });
      await waitFor(() =>
        expect(view.queryByText("Assembled draft") !== null).toBe(true),
      );
      expect(writes).toEqual([
        {
          method: "POST",
          path: "/api/agents/system-prompt-preview",
          body: {
            ...(mode === "edit" ? { agentId: "a1" } : {}),
            roomId: "r1",
            name: "Draft name",
            agentType: mode === "spawn-codex" ? "codex" : "claude",
            instructions: "Draft instructions",
            privileged: false,
            ...(mode === "edit" ? { memory: "" } : {}),
            // The form's mode, and a Codex form's sandbox: they decide the
            // schedule line (task 11e311db). A new Claude agent's default
            // is auto.
            ...(mode === "edit"
              ? { permissionMode: "acceptEdits" }
              : mode === "spawn"
                ? { permissionMode: "auto" }
                : { permissionMode: "never", codexSandbox: "read-only" }),
          },
        },
      ]);
      view.unmount();
    });
  }
});

describe("spawn dialog focus", () => {
  it("opens on the selected template card", async () => {
    setApiShim(async (_method, path) =>
      path === "/api/validate/cwd" ? { ok: true } : {},
    );
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog
          onClose={() => {}}
          deskIndex={0}
          roomId={room.id}
          defaultCwd="~"
          spawnAgentType="claude"
        />,
        { rooms: [room], agents: [], hasReceivedInitialState: true },
      ),
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      const templates = view.container.querySelector(
        ".spawn-template-section",
      )!;
      expect(templates.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      view.unmount();
    }
  });
});

// Task 379ae5db: the dialog writes the agent's text with the new field names,
// in its one PATCH, and the spawn POST carries it the same way.
describe("agent form instructions fields", () => {
  for (const mode of ["spawn", "edit"] as const) {
    it(`${mode} sends the text as instructions`, async () => {
      const writes: { method: string; path: string; body: unknown }[] = [];
      setApiShim(async (method, path, body) => {
        if (path === "/api/validate/cwd") return { ok: true };
        if (method === "GET" && path.startsWith("/api/memory"))
          return { text: "", version: "v1", size: 0, cap: 5000 };
        if (method === "GET") return {};
        writes.push({ method, path, body });
        if (method === "POST" && path === "/api/agents")
          return { agent: { ...agent, id: "new-agent" } };
        return {};
      });
      const view = render(
        onLanguage(
          "en",
          <EditAgentDialog
            onClose={() => {}}
            {...(mode === "edit"
              ? { agent }
              : {
                  deskIndex: 0,
                  roomId: room.id,
                  defaultCwd: "~",
                  spawnAgentType: "claude" as const,
                })}
          />,
          {
            rooms: [room],
            agents: mode === "edit" ? [agent] : [],
            hasReceivedInitialState: true,
          },
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        if (mode === "spawn")
          fireEvent.change(
            view.container.querySelector(".agent-identity-section input")!,
            { target: { value: "New agent" } },
          );
        fireEvent.change(
          view.container.querySelector(".agent-instructions-section textarea")!,
          { target: { value: "New instructions" } },
        );
      });
      await act(async () => {
        fireEvent.click([...view.container.querySelectorAll("button")].at(-1)!);
      });
      await waitFor(() => expect(writes.length).toBeGreaterThan(0));
      const first = writes[0];
      expect(first.method).toBe(mode === "edit" ? "PATCH" : "POST");
      const body = first.body as Record<string, unknown>;
      expect(body.instructions).toBe("New instructions");
      expect(body).not.toHaveProperty("customInstructions");
      expect(body).not.toHaveProperty("customInstructionsVersion");
      if (mode === "edit") expect(body.instructionsVersion).toBe("v1");
      view.unmount();
    });
  }
});
