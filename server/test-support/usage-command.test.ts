import { describe, expect, it, mock } from "bun:test";
import { createCommandHandling } from "../command-handlers.ts";
import { logParts, type LogText } from "../../shared/i18n/log-message.ts";
import type { ManagedAgent } from "../internal-types.ts";

describe("/usage", () => {
  // Claude and Codex share the meter branch; OpenCode has no meter.
  for (const [agentType, pointer, absent] of [
    ["claude", "commands.usage.meter", "commands.usage.unavailable"],
    ["opencode", "commands.usage.unavailable", "commands.usage.meter"],
  ] as const) {
    it(`gives ${agentType} the matching usage pointer without terminal cards`, async () => {
      const entries: { kind: string; content: LogText }[] = [];
      const updateState = mock(() => {});
      const deps = {
        agents: new Map(),
        getRooms: () => [],
        addLogEntry: (_id: string, kind: string, content: LogText) => {
          entries.push({ kind, content });
        },
        updateState,
      } as unknown as Parameters<typeof createCommandHandling>[0];
      const { commandHandlers } = createCommandHandling(deps);
      const managed = { info: { agentType } } as ManagedAgent;
      expect(
        await commandHandlers.usage(
          "usage-agent",
          managed,
          [],
          "/usage",
          undefined,
          undefined,
        ),
      ).toBe(true);
      expect(entries.map((entry) => entry.kind)).toEqual([
        "user_message",
        "system",
      ]);
      // The reply is message parts each reader words (task c37a7365).
      const keys = logParts(entries[1].content).flatMap((part) =>
        typeof part === "string" ? [] : [part.key],
      );
      expect(keys).toContain(pointer);
      expect(keys).toContain("commands.usage.office");
      expect(keys).not.toContain(absent);
      expect(updateState).toHaveBeenCalledWith(
        "usage-agent",
        "waiting_for_response",
      );
    });
  }
});
