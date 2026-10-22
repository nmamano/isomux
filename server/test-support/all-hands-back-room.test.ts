// /isomux-all-hands with a back room (task 5b503e32): front agents are listed
// one by one, and each room's back room is one line with its count.

import { describe, it, expect } from "bun:test";
import { createCommandHandling } from "../command-handlers.ts";
import { deskOfBackSeat } from "../../shared/desks.ts";
import {
  renderLogText,
  type LogMessage,
  type LogText,
} from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";

function agent(id: string, name: string, roomId: string, desk: number) {
  return {
    info: {
      id,
      name,
      roomId,
      desk,
      cwd: "/work",
      topic: null,
      agentType: "claude",
      modelFamily: "opus",
    },
  };
}

describe("/isomux-all-hands", () => {
  it("lists front agents and one line per back room", async () => {
    let report = "";
    let parts: readonly unknown[] = [];
    const agents = new Map(
      [
        agent("a1", "Lead", "r1", 0),
        agent("a2", "Worker 1", "r1", deskOfBackSeat({ table: 0, stool: 0 })),
        agent("a3", "Worker 2", "r1", deskOfBackSeat({ table: 0, stool: 1 })),
        agent("a4", "Solo", "r2", 1),
      ].map((a) => [a.info.id, a]),
    );
    const deps = {
      agents,
      getRooms: () => [],
      globalRoomIndexOf: (roomId: string) => (roomId === "r1" ? 0 : 1),
      // The reply is message parts each reader words (task c37a7365); this
      // reads its English render.
      addLogEntry: (_id: string, kind: string, content: LogText) => {
        if (kind === "system") {
          report = renderLogText(translatorFor("en"), content);
          parts = Array.isArray(content) ? content : [content];
        }
      },
      updateState: () => {},
    } as unknown as Parameters<typeof createCommandHandling>[0];
    const { commandHandlers } = createCommandHandling(deps);
    await commandHandlers.isomuxAllHands(
      "a1",
      {} as never,
      [],
      "/isomux-all-hands",
      undefined,
      undefined,
    );
    // Names are fixture data; the back-room line is read as its message key.
    expect(report).toContain("**Lead**");
    expect(report).toContain("**Solo**");
    expect(report).not.toContain("Worker 1");
    expect(report).not.toContain("Worker 2");
    const backRoomLines = parts.filter(
      (part): part is LogMessage =>
        typeof part === "object" &&
        part !== null &&
        (part as LogMessage).key === "commands.isomuxAllHands.backRoom",
    );
    expect(backRoomLines.map((line) => line.params)).toEqual([{ count: 2 }]);
  });
});
