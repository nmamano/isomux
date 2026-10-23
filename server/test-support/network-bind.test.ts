import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { networkInterfaces } from "os";
import { join } from "path";
import {
  buildPublicOrigin,
  isOutsideReachabilityBlocked,
  isProcessBoundLoopback,
} from "../auth.ts";
import { STATE_ROOT } from "../config.ts";
import { appHostDomain } from "../app-domain.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

function officeConfig(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(STATE_ROOT, "office-config.json"), "utf-8"),
  );
}

function writeOfficeConfig(patch: Record<string, unknown>): void {
  writeFileSync(
    join(STATE_ROOT, "office-config.json"),
    JSON.stringify({ ...officeConfig(), ...patch }, null, 2),
  );
}

async function bootClaimed(
  config: Record<string, unknown>,
): Promise<TestServer> {
  const first = await startTestServer();
  server = first;
  await first.seedOwner("Morgan");
  writeOfficeConfig(config);
  const restarted = await first.restart();
  server = restarted;
  return restarted;
}

describe("office network bind and origin-policy split", () => {
  it("keeps the deployment shapes on independent bind and origin policies", async () => {
    // A hosted, installer or Caddy office: https origin, loopback bind. A raw
    // tailnet port: no origin, and auto (explicit or absent) binds wide.
    const shapes = [
      ["hosted", "https://one.example", "loopback", true, "one.example"],
      ["raw tailnet port", null, "auto", false, null],
      ["raw tailnet port, bind absent", null, undefined, false, null],
    ] as const;

    for (const [
      name,
      publicOrigin,
      networkBind,
      expectedLoopback,
      expectedAppDomain,
    ] of shapes) {
      const srv = await bootClaimed({
        externalAccess: true,
        publicOrigin,
        ...(networkBind ? { networkBind } : {}),
      });
      expect(isOutsideReachabilityBlocked(), name).toBe(false);
      expect(isProcessBoundLoopback(), name).toBe(expectedLoopback);
      expect(buildPublicOrigin(), name).toEqual(
        publicOrigin
          ? { origin: publicOrigin, isHttps: true, source: "config" }
          : {
              origin: `http://localhost:${srv.port}`,
              isHttps: false,
              source: "localhost",
            },
      );
      expect(srv.server.hostname, name).toBe(
        expectedLoopback ? "127.0.0.1" : "localhost",
      );
      expect(appHostDomain(), name).toBe(expectedAppDomain);
      // A boot never writes a default for an absent bind.
      expect(officeConfig().networkBind, name).toBe(networkBind);
      await srv.stop();
      server = null;
    }

    const local = await startTestServer();
    server = local;
    expect(isOutsideReachabilityBlocked(), "local only").toBe(true);
    expect(isProcessBoundLoopback(), "local only").toBe(true);
    expect(buildPublicOrigin(), "local only").toEqual({
      origin: `http://localhost:${local.port}`,
      isHttps: false,
      source: "localhost",
    });
    expect(local.server.hostname, "local only").toBe("127.0.0.1");
    expect(appHostDomain(), "local only").toBe(null);
  });

  it("keeps pre-claim and external-access-off as loopback safety floors", async () => {
    const preClaim = await startTestServer();
    server = preClaim;
    writeOfficeConfig({ networkBind: "all" });
    const preClaimRestarted = await preClaim.restart();
    server = preClaimRestarted;
    expect(isOutsideReachabilityBlocked()).toBe(true);
    expect(isProcessBoundLoopback()).toBe(true);
    expect(preClaimRestarted.server.hostname).toBe("127.0.0.1");
    await preClaimRestarted.seedOwner("Morgan");
    writeOfficeConfig({ externalAccess: false, networkBind: "all" });
    const externalOff = await preClaimRestarted.restart();
    server = externalOff;
    expect(isOutsideReachabilityBlocked()).toBe(true);
    expect(isProcessBoundLoopback()).toBe(true);
    expect(externalOff.server.hostname).toBe("127.0.0.1");
  });

  it("refuses a non-loopback address only for the explicit loopback bind", async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (!address) throw new Error("test host has no non-loopback IPv4 address");

    const loopback = await bootClaimed({
      externalAccess: true,
      publicOrigin: "https://office.example",
      networkBind: "loopback",
    });
    // The OS refuses the connection: nothing listens on that address.
    const refusal = await fetch(`http://${address}:${loopback.port}/readyz`, {
      signal: AbortSignal.timeout(500),
    }).then(
      () => "answered",
      (error: { code?: string }) => error.code,
    );
    expect(refusal).toBe("ECONNREFUSED");
    await loopback.stop();
    server = null;

    const wildcard = await bootClaimed({
      externalAccess: true,
      publicOrigin: null,
      networkBind: "all",
    });
    const response = await fetch(`http://${address}:${wildcard.port}/readyz`, {
      signal: AbortSignal.timeout(500),
    });
    expect(response.status).toBe(200);
  });
});
