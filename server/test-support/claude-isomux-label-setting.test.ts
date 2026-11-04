// Task 11b5ef0c: the owner's switch that labels Claude agents as Isomux
// traffic, on GET/PUT /api/office/settings. The route is owner-only as a whole
// (routes-office-settings-rest.test.ts covers who is refused); what the switch
// does to a launch is in server/backends/claude.session.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../config.ts";
import {
  loadClaudeIsomuxLabel,
  saveClaudeIsomuxLabel,
} from "../persistence.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  saveClaudeIsomuxLabel(false);
});

interface Settings {
  version: string;
  claudeIsomuxLabel?: boolean;
}

async function office() {
  server = await startTestServer();
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
  return { read, put, call };
}

const savedSwitch = () =>
  (
    JSON.parse(
      readFileSync(join(STATE_ROOT, "office-config.json"), "utf8"),
    ) as {
      claudeIsomuxLabel?: boolean;
    }
  ).claudeIsomuxLabel;

describe("the Claude Isomux label setting", () => {
  it("is off by default, turned on and off by the owner, saved, and kept by another field's save", async () => {
    const o = await office();
    const before = await o.read();
    expect(before.claudeIsomuxLabel).toBe(false);
    expect(loadClaudeIsomuxLabel()).toBe(false);

    expect(await o.put({ claudeIsomuxLabel: true })).toBe(204);
    const on = await o.read();
    expect(on.claudeIsomuxLabel).toBe(true);
    expect(on.version).not.toBe(before.version);
    expect(savedSwitch()).toBe(true);
    // The backend's launch reads it back.
    expect(loadClaudeIsomuxLabel()).toBe(true);

    expect(await o.put({ name: "Acme" })).toBe(204);
    expect((await o.read()).claudeIsomuxLabel).toBe(true);

    expect(await o.put({ claudeIsomuxLabel: false })).toBe(204);
    const off = await o.read();
    expect(off.claudeIsomuxLabel).toBe(false);
    expect(off.version).not.toBe(on.version);
    expect(loadClaudeIsomuxLabel()).toBe(false);
  });

  it("refuses a value that is not a boolean, and writes nothing", async () => {
    const o = await office();
    const { version } = await o.read();
    for (const bad of ["true", 1, null]) {
      const res = await o.call("PUT", { version, claudeIsomuxLabel: bad });
      expect([bad, res.status, res.body?.error?.code]).toEqual([
        bad,
        400,
        "invalid_request",
      ]);
    }
    expect((await o.read()).version).toBe(version);
    expect(loadClaudeIsomuxLabel()).toBe(false);
  });
});
