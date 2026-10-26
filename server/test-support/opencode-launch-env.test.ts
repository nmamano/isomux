// A member's OpenCode server is shared by all of their OpenCode work, and
// whichever call reaches a cold profile first starts it with the env it was
// given. Every path that hands the OpenCode backend a launch env therefore
// passes the same one: the agent session, the topic label, the history read
// and fork of an edit, the office model list and a schedule run. The skill
// folders are part of the server's config (task 30dd196e), so each path passes
// the same list too: one that passed none would start the server without
// them, and the next agent session would replace it. The saved-settings push
// is held to the same env in opencode-settings-push.test.ts.
import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { STATE_ROOT } from "../config.ts";
import { opencodeBackend } from "../backends/opencode/adapter.ts";
import type { ListModelsOptions, OneShotOptions } from "../backends/types.ts";
import { loadLog } from "../persistence.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import { getUserByName } from "../users.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
let userId: string | null = null;
afterEach(async () => {
  if (userId) removeManagedUserEnv(userId);
  userId = null;
  await server?.stop();
  server = null;
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

// The env holds the test process's own variables, so it is compared without
// printing it, and without the agent token the server start drops.
const launchEnv = (env: Record<string, string | undefined> | undefined) =>
  JSON.stringify(
    Object.entries(env ?? {})
      .filter(([name]) => name !== "ISOMUX_AGENT_TOKEN")
      .sort(([a], [b]) => a.localeCompare(b)),
  );

interface LaunchInput {
  env?: Record<string, string | undefined>;
  environmentKey?: string;
  environmentRevision?: string;
  skillPaths?: string[];
}

describe("OpenCode launch env", () => {
  it("is the same on every path that can start the member's server", async () => {
    const oneShots: OneShotOptions[] = [];
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      oneShot: (_prompt, opts) => {
        oneShots.push(opts);
        return "Topic";
      },
      sessionMessages: [
        { uuid: "u-first", role: "user", text: "[Morgan] first" },
        { uuid: "a-1", role: "assistant", text: "ok" },
      ],
      forkResult: {
        kind: "fork",
        sessionId: "forked-launch-env",
        forkedFromSessionId: "fake-session-1",
      },
    });
    const listed: ListModelsOptions[] = [];
    const listModels = spyOn(opencodeBackend, "listModels").mockImplementation(
      async (opts) => {
        listed.push(opts);
        return [];
      },
    );
    try {
      const srv = await startTestServer({ fakeBackend: fake });
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      userId = getUserByName(owner.username)!.id;
      // A saved variable gives the member an environment of their own.
      writeManagedUserEnv(userId, { TZ: "Europe/Madrid" });
      const room = srv.agentManager.getRooms()[0];
      const info = await srv.agentManager.spawn(
        "Launch",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        room.id,
        undefined,
        "gate/model",
        undefined,
        owner.username,
        "opencode",
        undefined,
        userId,
      );
      if (!info) throw new Error("spawn returned null");
      srv.agentManager.enqueueMessage(info.id, {
        sender: { kind: "user", username: owner.username },
        text: "first",
      });
      await waitUntil(
        () => fake.sessionForAgent(info.id) !== undefined,
        "session created",
      );
      const session: LaunchInput = fake.sessionForAgent(info.id)!.opts;
      expect(session.env?.TZ === "Europe/Madrid", "the saved variable").toBe(
        true,
      );
      // A list to compare: undefined on both sides would prove nothing.
      expect((session.skillPaths ?? []).length).toBeGreaterThan(0);

      // The first reply asks for a topic label.
      await waitUntil(() => oneShots.length > 0, "topic one-shot");
      await waitUntil(
        () =>
          srv.agentManager.getAgent(info.id)?.state === "waiting_for_response",
        "turn settled",
      );

      const sessionId = srv.agentManager.getCurrentSessionId(info.id)!;
      const first = loadLog(info.id, sessionId).find(
        (entry) => entry.kind === "user_message" && entry.content === "first",
      )!;
      await srv.agentManager.editMessage(info.id, first.id, "edited");
      await waitUntil(
        () => fake.lastForkAccess !== undefined,
        "edit forked the session",
      );

      const res = await srv.http("/api/backends/opencode/models", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: STATE_ROOT, includeHidden: true }),
      });
      expect(res.status).toBe(200);
      expect(listed[0]).toMatchObject({ cwd: STATE_ROOT, includeHidden: true });

      const before = fake.sessions.length;
      const job = srv.cronjobManager.addCronjob({
        name: "Launch run",
        schedule: { type: "interval", minutes: 60 },
        prompt: "do the thing",
        cwd: STATE_ROOT,
        agentType: "opencode",
        modelFamily: "gate/model",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username: owner.username,
      });
      expect(
        srv.cronjobManager.runCronjobNow(job.id, owner.username),
      ).not.toBeNull();
      await waitUntil(() => fake.sessions.length > before, "run session");
      const run: LaunchInput = fake.sessions[before].opts;

      const paths: Array<[string, LaunchInput | undefined]> = [
        ["topic label", oneShots[0]],
        ["edit history read", fake.lastMessagesAccess],
        ["edit fork", fake.lastForkAccess],
        ["office model list", listed[0]],
        ["schedule run", run],
      ];
      for (const [path, input] of paths) {
        expect(input, path).toBeDefined();
        expect(launchEnv(input!.env) === launchEnv(session.env), path).toBe(
          true,
        );
        expect(input!.environmentKey, path).toBe(session.environmentKey);
        expect(input!.environmentRevision, path).toBe(
          session.environmentRevision,
        );
        expect(input!.skillPaths, path).toEqual(session.skillPaths);
      }
    } finally {
      listModels.mockRestore();
      fake.sessions.forEach((s) => s.close());
    }
  });
});
