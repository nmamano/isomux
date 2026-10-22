// An app learning its own address, through the REAL boot path (phase 3, slice
// 8).
//
// The pure matrices live in app-url-reconcile.test.ts. What this file adds is
// the wiring nothing else can prove: that the office's own transition - an
// operator turning it into an HTTPS deployment and restarting - is what makes
// every registered app's unit carry ISOMUX_APP_URL, that the API reports the
// same address it injected, and that the boot AFTER that one does nothing at
// all.
//
// The supervisor is the harness's fake (the suite never touches systemd), and
// it is carried across the restart on purpose: systemd outlives the isomux
// process, so units written by one boot are what the next boot inspects.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  HTTPS_ORIGIN,
  OFFICE_HOST,
  anAgentToken,
  registerApp,
} from "./app-host-test-kit.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const appUrl = (name: string) => `https://${name}.${OFFICE_HOST}`;

// Turn the office into an HTTPS deployment through the real Access route, then
// cold-restart the same install - the only way the derived domain changes,
// since it is frozen at boot.
async function goHttpsAndRestart(
  srv: TestServer,
  ownerSessionId: string,
): Promise<TestServer> {
  const r = await srv.http("/api/office/access", {
    method: "PUT",
    rawSessionId: ownerSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalAccess: true, publicOrigin: HTTPS_ORIGIN }),
  });
  expect(r.status).toBe(200);
  const next = await srv.restart();
  server = next;
  return next;
}

// What the URL pass itself did. The token pass ahead of it asks systemd to
// re-read its units on every boot that has apps, and both passes read state -
// neither is a change to anything, and neither belongs in these assertions.
const urlPassEffects = (srv: TestServer): string[] =>
  srv.appSupervisor.calls.filter(
    (c) =>
      c.startsWith("regenerate:") ||
      c.startsWith("restart:") ||
      c.startsWith("restoreUnitFile:"),
  );

// Listed as the owner, not as the agent that registered the app: agent tokens
// are minted per process and a cold restart is a new one, while the office
// session on disk is exactly what a person's browser carries across a restart.
const appsList = async (srv: TestServer, rawSessionId: string) => {
  const res = await srv.http("/api/apps", { rawSessionId });
  expect(res.status).toBe(200);
  return (await res.json()) as { name: string; state: string; url?: string }[];
};

describe("app URLs: the office gains a domain", () => {
  it("re-renders every unit, restarts only the running app once, reports the address, and does nothing on the next boot", async () => {
    const first = await startTestServer();
    server = first;
    const owner = await first.seedOwner("Morgan");
    const token = await anAgentToken(first);
    await registerApp(first, token, "hello");
    await registerApp(first, token, "idle");
    const stop = await first.http("/api/apps/idle/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stop.status).toBe(200);

    // An office with no app hostnames gives an app no address at all, in its
    // unit or on the wire. ABSENT, not empty: `if (process.env.ISOMUX_APP_URL)`
    // has to be a truthful test of whether this app is reachable at a
    // hostname.
    for (const name of ["hello", "idle"]) {
      const unit = first.appSupervisor.unitFiles.get(name);
      expect({ name, written: typeof unit }).toEqual({
        name,
        written: "string",
      });
      expect(unit).not.toContain("ISOMUX_APP_URL");
    }
    const plain = await appsList(first, owner.rawSessionId);
    expect(plain.map((app) => [app.name, "url" in app]).sort()).toEqual([
      ["hello", false],
      ["idle", false],
    ]);
    // Everything the registration did is behind us; what follows is the boot.
    first.appSupervisor.calls.length = 0;

    const srv = await goHttpsAndRestart(first, owner.rawSessionId);

    // Both units are rewritten; only the running app is bounced, and once.
    expect(urlPassEffects(srv).sort()).toEqual([
      "regenerate:hello",
      "regenerate:idle",
      "restart:hello",
    ]);
    for (const name of ["hello", "idle"]) {
      expect(srv.appSupervisor.unitFiles.get(name)).toContain(
        `Environment="ISOMUX_APP_URL=${appUrl(name)}"`,
      );
    }
    // The API and the app are told the same thing, and the stopped app stays
    // at rest, reporting the address it will come up on.
    const apps = (await appsList(srv, owner.rawSessionId)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(apps.map((app) => [app.name, app.url])).toEqual([
      ["hello", appUrl("hello")],
      ["idle", appUrl("idle")],
    ]);
    expect(apps[1].state).toBe("stopped");

    // Idempotence where it counts: no rewrite and no bounce every time the
    // office restarts.
    srv.appSupervisor.calls.length = 0;
    const again = await srv.restart();
    server = again;
    expect(urlPassEffects(again)).toEqual([]);
    expect(again.appSupervisor.unitFiles.get("hello")).toContain(
      `Environment="ISOMUX_APP_URL=${appUrl("hello")}"`,
    );
  });
});
