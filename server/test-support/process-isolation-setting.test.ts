// Task 8db21c8b: the owner's switch for one PID namespace per agent on
// GET/PUT /api/office/settings, and the status the read gives next to it. The
// route is owner-only as a whole (routes-office-settings-rest.test.ts covers
// who is refused). The probe result is set, never run; afterEach puts it back
// to "no result" (off).
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../config.ts";
import { loadProcessIsolation } from "../persistence.ts";
import {
  processIsolationNow,
  setProcessIsolationProbe,
  setProcessIsolationSwitch,
} from "../process-isolation-state.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  setProcessIsolationProbe(null);
  setProcessIsolationSwitch(() => true);
});

interface Settings {
  version: string;
  processIsolation?: boolean;
  processIsolationStatus?: string;
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

describe("the process isolation setting", () => {
  it("is on by default, turned off and on by the owner, saved, and read by the next session start", async () => {
    setProcessIsolationProbe({ available: true });
    const o = await office();
    const before = await o.read();
    expect([before.processIsolation, before.processIsolationStatus]).toEqual([
      true,
      "on",
    ]);
    expect(processIsolationNow()).toEqual({ state: "on" });

    expect(await o.put({ processIsolation: false })).toBe(204);
    const off = await o.read();
    expect([off.processIsolation, off.processIsolationStatus]).toEqual([
      false,
      "turned_off",
    ]);
    expect(off.version).not.toBe(before.version);
    expect(processIsolationNow()).toEqual({
      state: "off",
      reason: "turned_off",
    });
    const config = JSON.parse(
      readFileSync(join(STATE_ROOT, "office-config.json"), "utf8"),
    ) as { processIsolation?: boolean };
    expect(config.processIsolation).toBe(false);
    // A boot reads it back.
    expect(loadProcessIsolation()).toBe(false);

    // Another field's save keeps it.
    expect(await o.put({ name: "Acme" })).toBe(204);
    expect((await o.read()).processIsolation).toBe(false);

    expect(await o.put({ processIsolation: true })).toBe(204);
    expect((await o.read()).processIsolationStatus).toBe("on");
    expect(processIsolationNow()).toEqual({ state: "on" });
  });

  it("refuses a value that is not a boolean, and writes nothing", async () => {
    const o = await office();
    const { version } = await o.read();
    for (const bad of ["no", 0, null]) {
      const res = await o.call("PUT", { version, processIsolation: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect((await o.read()).version).toBe(version);
  });

  it("gives the host's reason in the status when the probe failed, whatever the switch", async () => {
    setProcessIsolationProbe({
      available: false,
      reason: "no_bwrap",
      detail: "spawn bwrap ENOENT",
    });
    const o = await office();
    expect((await o.read()).processIsolationStatus).toBe("no_bwrap");
    expect(await o.put({ processIsolation: false })).toBe(204);
    expect((await o.read()).processIsolationStatus).toBe("no_bwrap");
  });
});
