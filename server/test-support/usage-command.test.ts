import { describe, expect, it, mock } from "bun:test";
import { createCommandHandling } from "../command-handlers.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { renderLogText, type LogText } from "../../shared/i18n/log-message.ts";
import type { ManagedAgent } from "../internal-types.ts";

describe("/usage", () => {
  for (const agentType of ["claude", "codex", "opencode"] as const) {
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
      // The reply is message parts each reader words (task c37a7365); this
      // reads its English render.
      const { t } = translatorFor("en");
      expect(renderLogText(translatorFor("en"), entries[1].content)).toBe(
        [
          t(
            agentType === "opencode"
              ? "commands.usage.unavailable"
              : "commands.usage.meter",
          ),
          "",
          t("commands.usage.office"),
        ].join("\n"),
      );
      expect(updateState).toHaveBeenCalledWith(
        "usage-agent",
        "waiting_for_response",
      );
    });
  }
});
