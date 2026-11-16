// Task 2b42971b: the owner's office-wide switch for the resume after a usage
// limit, on GET/PUT /api/office/settings. The route is owner-only as a whole
// (routes-office-settings-rest.test.ts covers who is refused); what the
// switch does to a stopped turn is in limit-resume.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../config.ts";
import {
  loadAgents,
  loadLimitResume,
  saveLimitResume,
} from "../persistence.ts";
import { getUserByName } from "../users.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  saveLimitResume(true);
});

const HOUR = 60 * 60 * 1000;

interface Settings {
  version: string;
  limitResume?: boolean;
}

// Each turn ends stopped by a usage limit that resets in five hours.
const limitedBackend = () =>
  new FakeBackend({
    session: {
      onSend: (_t, _a, s) => {
        s.push({ kind: "usage_limit_stop", resetsAtMs: Date.now() + 5 * HOUR });
        s.completeTurn();
      },
    },
  });

async function office(fakeBackend?: FakeBackend) {
  server = await startTestServer(fakeBackend ? { fakeBackend } : {});
  const srv = server;
  const owner = await srv.seedOwner("Morgan");
  const call = async (method: string, body?: unknown) => {
    const res = await srv.http("/api/office/settings", {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const read = async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    return res.body as Settings;
  };
  const put = async (fields: Record<string, unknown>) =>
    (await call("PUT", { version: (await read()).version, ...fields })).status;
  return { srv, owner, read, put, call };
}

const savedSwitch = () => {
  const file = join(STATE_ROOT, "office-config.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { limitResume?: unknown })
    .limitResume;
};

const persistedAt = (id: string) =>
  loadAgents()
    .flatMap((r) => r.agents)
    .find((a) => a.id === id)?.limitResumeAt;

describe("the resume-after-usage-limit office setting", () => {
  it("is on by default, turned off and on by the owner, saved, and kept by another field's save", async () => {
    const o = await office();
    const before = await o.read();
    expect(before.limitResume).toBe(true);
    expect(loadLimitResume()).toBe(true);

    expect(await o.put({ limitResume: false })).toBe(204);
    const off = await o.read();
    expect(off.limitResume).toBe(false);
    // The settings version covers it: a writer that read before is refused.
    expect(off.version).not.toBe(before.version);
    expect(savedSwitch()).toBe(false);
    expect(loadLimitResume()).toBe(false);

    expect(await o.put({ name: "Acme" })).toBe(204);
    expect((await o.read()).limitResume).toBe(false);

    expect(await o.put({ limitResume: true })).toBe(204);
    const on = await o.read();
    expect(on.limitResume).toBe(true);
    expect(on.version).not.toBe(off.version);
    expect(loadLimitResume()).toBe(true);
  });

  it("refuses a value that is not a boolean, and writes nothing", async () => {
    const o = await office();
    const { version } = await o.read();
    for (const bad of ["false", 0, null]) {
      const res = await o.call("PUT", { version, limitResume: bad });
      expect([bad, res.status, res.body?.error?.code]).toEqual([
        bad,
        400,
        "invalid_request",
      ]);
    }
    expect((await o.read()).version).toBe(version);
    expect(loadLimitResume()).toBe(true);
    expect(savedSwitch()).toBeUndefined();
  });

  it("turning it off drops the resume an agent waits for; a save that leaves it on keeps it", async () => {
    const o = await office(limitedBackend());
    const room = o.srv.agentManager.getRooms()[0].id;
    const ownerId = getUserByName(o.owner.username)!.id;
    const info = await o.srv.agentManager.spawn(
      "Stopped",
      o.srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      o.owner.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!info) throw new Error("spawn failed");
    void o.srv.agentManager.sendMessage(info.id, "work", o.owner.username);
    const deadline = Date.now() + 3000;
    while (persistedAt(info.id) === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    // The enabling condition: the stop armed a resume.
    expect(persistedAt(info.id)).toBeGreaterThan(Date.now());

    expect(await o.put({ name: "Acme", limitResume: true })).toBe(204);
    expect(persistedAt(info.id)).toBeGreaterThan(Date.now());

    expect(await o.put({ limitResume: false })).toBe(204);
    expect(persistedAt(info.id)).toBeUndefined();
  });
});
