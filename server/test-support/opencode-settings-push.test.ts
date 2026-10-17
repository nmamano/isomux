// Task d4a7031e: a save hands the member's OpenCode server the same inputs
// the next session start passes, so the session start requests no second
// replacement. An office save reaches every member's server, and a push that
// fails never fails the save.
import { afterEach, describe, expect, it } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import { createMember, deleteUserById } from "../users.ts";
import type { Backend } from "../backends/types.ts";
import { FakeBackend } from "./fake-backend.ts";

const USER = "user-opencode-push";

afterEach(() => {
  removeManagedUserEnv(USER);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const rooms = (): RoomWire[] => [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];

const launchEnv = (env: Record<string, string | undefined> | undefined) =>
  JSON.stringify(
    Object.entries(env ?? {})
      .filter(([name]) => name !== "ISOMUX_AGENT_TOKEN")
      .sort(([a], [b]) => a.localeCompare(b)),
  );

type SavedSettings = Parameters<NonNullable<Backend["updateSavedSettings"]>>[0];

function setup() {
  const fake = new FakeBackend();
  const pushes: SavedSettings[] = [];
  let fails = false;
  Object.assign(fake, {
    updateSavedSettings: (opts: SavedSettings) => {
      pushes.push(opts);
      if (fails) throw new Error("push failed");
    },
  });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms() }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  // An OpenCode agent of USER with a live session.
  const start = async (name: string) => {
    const info = await mgr.spawn(
      name,
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
      undefined,
      undefined,
      undefined,
      "Owner",
      "opencode",
      undefined,
      USER,
    );
    if (!info) throw new Error("spawn returned null");
    mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "Boss" },
      text: "hi",
    });
    await waitUntil(
      () => fake.sessionForAgent(info.id) !== undefined,
      "session created",
    );
    return fake.sessionForAgent(info.id)!.opts;
  };
  return {
    mgr,
    pushes,
    start,
    failPushes: () => {
      fails = true;
    },
  };
}

describe("an OpenCode settings push", () => {
  it("passes the inputs the next session start passes", async () => {
    const { mgr, pushes, start } = setup();
    await start("First");
    writeManagedUserEnv(USER, { TZ: "Europe/Madrid" });
    mgr.pushOpenCodeSettings({ kind: "user", userId: USER });
    expect(pushes).toHaveLength(1);
    const next = await start("Second");
    const { env, ...rest } = pushes[0];
    expect(rest).toEqual({
      environmentKey: next.environmentKey!,
      environmentRevision: next.environmentRevision!,
      mcpServers: next.mcpServers!,
    });
    // The env holds the test process's own variables: compared without
    // printing them, and without the agent token the supervisor drops.
    expect(
      launchEnv(env) === launchEnv(next.env),
      "the env the session start passes",
    ).toBe(true);
    expect(env?.TZ === "Europe/Madrid", "the saved variable").toBe(true);
  });

  it("never throws when the backend's push fails", async () => {
    const { mgr, pushes, failPushes } = setup();
    failPushes();
    expect(() =>
      mgr.pushOpenCodeSettings({ kind: "user", userId: USER }),
    ).not.toThrow();
    expect(pushes).toHaveLength(1);
  });

  it("reaches every environment once for an office save, a member's own included", async () => {
    const { mgr, pushes } = setup();
    const made = createMember("Push Member", { role: "member" });
    if (!made.ok) throw new Error(made.error);
    const member = made.user.id;
    try {
      // A member variable gives the member an environment of their own.
      writeManagedUserEnv(member, { TZ: "UTC" });
      const memberKey = environmentSourceKeyForUserId(member);
      const officeKey = environmentSourceKeyForUserId(null);
      expect(memberKey, "the member's own environment").not.toBe(officeKey);
      mgr.pushOpenCodeSettings({ kind: "office" });
      const keys = pushes.map((push) => push.environmentKey);
      expect(keys).toContain(officeKey);
      expect(keys).toContain(memberKey);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      removeManagedUserEnv(member);
      deleteUserById(member);
    }
  });
});
