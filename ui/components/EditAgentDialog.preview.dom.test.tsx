import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { DEFAULT_AGENT_CAPABILITIES } = await import("../../shared/types.ts");
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
  topicStale: false,
  customInstructions: "Saved instructions",
  customInstructionsVersion: "v1",
  agentType: "claude",
  capabilities: DEFAULT_AGENT_CAPABILITIES,
  userId: "u1",
  username: "Tester",
  queue: [],
  sessionSwapping: false,
  turnHadHumanInput: false,
};

describe("agent form prompt preview", () => {
  for (const mode of ["spawn", "edit"] as const) {
    it(`${mode} sends the current form values without saving`, async () => {
      const writes: { method: string; path: string; body: unknown }[] = [];
      setApiShim(async (method, path, body) => {
        if (path === "/api/validate/cwd") return { ok: true };
        if (method === "GET" && path.startsWith("/api/memory"))
          return { text: "Saved memory", version: "v1", size: 12, cap: 5000 };
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
      });
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: "Show full system prompt" }),
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
            agentType: "claude",
            customInstructions: "Draft instructions",
            privileged: false,
            ...(mode === "edit" ? { memory: "" } : {}),
          },
        },
      ]);
      view.unmount();
    });
  }
});
