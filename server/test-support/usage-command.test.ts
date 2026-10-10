import { describe, expect, it, mock } from "bun:test";
import { createCommandHandling } from "../command-handlers.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import type { ManagedAgent } from "../internal-types.ts";

describe("/usage", () => {
  for (const agentType of ["claude", "codex", "opencode"] as const) {
    it(`gives ${agentType} the matching usage pointer without terminal cards`, async () => {
      const entries: { kind: string; content: string }[] = [];
      const updateState = mock(() => {});
      const deps = {
        agents: new Map(),
        getRooms: () => [],
        addLogEntry: (_id: string, kind: string, content: string) => {
          entries.push({ kind, content });
        },
        updateState,
      } as unknown as Parameters<typeof createCommandHandling>[0];
      const { commandHandlers } = createCommandHandling(deps);
      const managed = { info: { agentType } } as ManagedAgent;
      expect(await commandHandlers.usage(
        "usage-agent", managed, [], "/usage", undefined, undefined,
      )).toBe(true);
      expect(entries.map((entry) => entry.kind)).toEqual(["user_message", "system"]);
      const { t } = translatorFor("en");
      expect(entries[1].content).toBe([
        t(agentType === "opencode" ? "commands.usage.unavailable" : "commands.usage.meter"),
        "",
        t("commands.usage.office"),
      ].join("\n"));
      expect(updateState).toHaveBeenCalledWith("usage-agent", "waiting_for_response");
    });
  }
});
