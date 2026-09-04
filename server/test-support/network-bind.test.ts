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
  await first.seedOwner("Boss");
  writeOfficeConfig(config);
  const restarted = await first.restart();
  server = restarted;
  return restarted;
}

describe("office network bind and origin-policy split", () => {
  it("wires the 120-second idle timeout into Bun.serve", () => {
    const source = readFileSync(
      new URL("../isomux-office.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("export const OFFICE_IDLE_TIMEOUT_SECONDS = 120;");
    expect(source).toContain("idleTimeout: OFFICE_IDLE_TIMEOUT_SECONDS,");
  });

  it("keeps the seven deployment shapes on independent bind and origin policies", async () => {
    const shapes = [
      ["1 hosted new", "https://one.example", "loopback", true, "one.example"],
      [
        "2 hosted existing",
        "https://two.example",
        "loopback",
        true,
        "two.example",
      ],
      [
        "3 installer VPS",
        "https://three.example",
        "loopback",
        true,
        "three.example",
      ],
      [
        "4 hand-provisioned Caddy",
        "https://four.example",
        "loopback",
        true,
        "four.example",
      ],
      ["5 raw tailnet port", null, "auto", false, null],
      [
        "6 Tailscale Serve",
        "https://auntie.example.ts.net",
        "loopback",
        true,
        null,
      ],
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
        networkBind,
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
      await srv.stop();
      server = null;
    }

    const local = await startTestServer();
    server = local;
    expect(isOutsideReachabilityBlocked(), "7 local only").toBe(true);
    expect(isProcessBoundLoopback(), "7 local only").toBe(true);
    expect(buildPublicOrigin(), "7 local only").toEqual({
      origin: `http://localhost:${local.port}`,
      isHttps: false,
      source: "localhost",
    });
    expect(local.server.hostname, "7 local only").toBe("127.0.0.1");
    expect(appHostDomain(), "7 local only").toBe(null);
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
    await preClaimRestarted.seedOwner("Boss");
    writeOfficeConfig({ externalAccess: false, networkBind: "all" });
    const externalOff = await preClaimRestarted.restart();
    server = externalOff;
    expect(isOutsideReachabilityBlocked()).toBe(true);
    expect(isProcessBoundLoopback()).toBe(true);
    expect(externalOff.server.hostname).toBe("127.0.0.1");
  });

  it("treats absent and explicit auto alike without materializing absence", async () => {
    const absent = await bootClaimed({
      externalAccess: true,
      publicOrigin: null,
    });
    expect(isOutsideReachabilityBlocked()).toBe(false);
    expect(isProcessBoundLoopback()).toBe(false);
    expect("networkBind" in officeConfig()).toBe(false);
    await absent.stop();
    server = null;

    await bootClaimed({
      externalAccess: true,
      publicOrigin: null,
      networkBind: "auto",
    });
    expect(isOutsideReachabilityBlocked()).toBe(false);
    expect(isProcessBoundLoopback()).toBe(false);
    expect(officeConfig().networkBind).toBe("auto");
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
    const refusalStarted = performance.now();
    let refused = false;
    try {
      await fetch(`http://${address}:${loopback.port}/readyz`, {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(performance.now() - refusalStarted).toBeLessThan(250);
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
