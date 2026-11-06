// projectBackRooms (task 5b503e32): the summary's counts, per room.

import { describe, it, expect } from "bun:test";
import { projectBackRooms } from "./discovery-back-room.ts";
import { deskOfBackSeat } from "../shared/desks.ts";

const entry = (
  name: string,
  roomId: string,
  desk: number,
  live: {
    inFlightTurn?: unknown;
    pendingPrompt?: unknown;
    backgroundTasks?: unknown;
  } = {},
) => ({
  name,
  roomId,
  roomName: roomId.toUpperCase(),
  room: 1,
  desk,
  inFlightTurn: live.inFlightTurn ?? null,
  pendingPrompt: live.pendingPrompt ?? null,
  backgroundTasks: live.backgroundTasks ?? null,
});

describe("projectBackRooms", () => {
  it("counts busy, pending-prompt and background-work back agents per room", () => {
    const out = projectBackRooms(
      [
        entry("Front", "r1", 0, { inFlightTurn: { startedAt: 1 } }),
        entry("Busy", "r1", deskOfBackSeat({ table: 0, stool: 0 }), {
          inFlightTurn: { startedAt: 1, activeTool: null },
        }),
        entry("Asking", "r1", deskOfBackSeat({ table: 0, stool: 1 }), {
          pendingPrompt: "permission",
          backgroundTasks: [{ kind: "command", startedAt: 1 }],
        }),
        entry("Pushing", "r1", deskOfBackSeat({ table: 0, stool: 2 }), {
          backgroundTasks: [
            { kind: "command", startedAt: 1 },
            { kind: "agent", startedAt: 2 },
          ],
        }),
        entry("Front work", "r1", 1, {
          backgroundTasks: [{ kind: "command", startedAt: 1 }],
        }),
        entry("Elsewhere", "r2", deskOfBackSeat({ table: 0, stool: 0 }), {
          inFlightTurn: { startedAt: 1 },
          pendingPrompt: "model",
        }),
      ],
      true,
    );
    const r1 = out.find((e) => e.roomId === "r1" && "agents" in e);
    const r2 = out.find((e) => e.roomId === "r2" && "agents" in e);
    expect(r1).toMatchObject({
      agents: 3,
      busy: 1,
      pendingPrompt: 1,
      background: 2,
    });
    expect(r2).toMatchObject({
      agents: 1,
      busy: 1,
      pendingPrompt: 1,
      background: 0,
    });
  });
});
