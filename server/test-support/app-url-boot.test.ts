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
  deleteApp,
  registerApp,
} from "./app-host-test-kit.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const APP_URL = `https://hello.${OFFICE_HOST}`;

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

describe("app URLs: an office with no app hostnames", () => {
  it("gives an app no address at all - in its unit or on the wire", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const token = await anAgentToken(srv);
    await registerApp(srv, token, "hello");

    // ABSENT, not empty: `if (process.env.ISOMUX_APP_URL)` has to be a
    // truthful test of whether this app is reachable at a hostname.
    expect(srv.appSupervisor.unitFiles.get("hello")).not.toContain(
      "ISOMUX_APP_URL",
    );
    const [app] = await appsList(srv, owner.rawSessionId);
    expect(app.name).toBe("hello");
    expect("url" in app).toBe(false);
  });
});

describe("app URLs: the office gains a domain", () => {
  it("re-renders the unit, restarts the running app once, and reports the address", async () => {
    const first = await startTestServer();
    server = first;
    const owner = await first.seedOwner("Boss");
    const token = await anAgentToken(first);
    await registerApp(first, token, "hello");
    expect(first.appSupervisor.unitFiles.get("hello")).not.toContain(
      "ISOMUX_APP_URL",
    );
    // Everything the registration did is behind us; what follows is the boot.
    first.appSupervisor.calls.length = 0;

    const srv = await goHttpsAndRestart(first, owner.rawSessionId);

    expect(urlPassEffects(srv)).toEqual(["regenerate:hello", "restart:hello"]);
    expect(srv.appSupervisor.unitFiles.get("hello")).toContain(
      `Environment="ISOMUX_APP_URL=${APP_URL}"`,
    );
    // The API and the app are told the same thing.
    const [app] = await appsList(srv, owner.rawSessionId);
    expect(app.url).toBe(APP_URL);
  });

  it("does nothing on the next boot", async () => {
    // Idempotence where it counts: no rewrite and no bounce every time the
    // office restarts.
    const first = await startTestServer();
    server = first;
    const owner = await first.seedOwner("Boss");
    const token = await anAgentToken(first);
    await registerApp(first, token, "hello");
    const converged = await goHttpsAndRestart(first, owner.rawSessionId);

    converged.appSupervisor.calls.length = 0;
    const again = await converged.restart();
    server = again;
    expect(urlPassEffects(again)).toEqual([]);
    expect(again.appSupervisor.unitFiles.get("hello")).toContain(
      `Environment="ISOMUX_APP_URL=${APP_URL}"`,
    );
  });

  it("reports the LABEL's address for a re-registered name, not the name's", async () => {
    // The ledger's whole point, seen from the API: `hello` is deleted and
    // registered again, so this app is `hello-g2` and the old origin stays
    // dead. Reporting `hello.office.example` here would point a user at an
    // address that belongs to nobody.
    const first = await startTestServer();
    server = first;
    const owner = await first.seedOwner("Boss");
    const token = await anAgentToken(first);
    await registerApp(first, token, "hello");
    await deleteApp(first, token, "hello");
    const label = await registerApp(first, token, "hello");
    expect(label).toBe("hello-g2");

    const srv = await goHttpsAndRestart(first, owner.rawSessionId);
    const [app] = await appsList(srv, owner.rawSessionId);
    expect(app.url).toBe(`https://hello-g2.${OFFICE_HOST}`);
    expect(srv.appSupervisor.unitFiles.get("hello")).toContain(
      `Environment="ISOMUX_APP_URL=https://hello-g2.${OFFICE_HOST}"`,
    );
  });

  it("gives a stopped app the new unit and leaves it stopped", async () => {
    const first = await startTestServer();
    server = first;
    const owner = await first.seedOwner("Boss");
    const token = await anAgentToken(first);
    await registerApp(first, token, "hello");
    const stop = await first.http("/api/apps/hello/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stop.status).toBe(200);
    first.appSupervisor.calls.length = 0;

    const srv = await goHttpsAndRestart(first, owner.rawSessionId);
    expect(urlPassEffects(srv)).toEqual(["regenerate:hello"]);
    expect(srv.appSupervisor.unitFiles.get("hello")).toContain(
      `Environment="ISOMUX_APP_URL=${APP_URL}"`,
    );
    // Still at rest, and now reporting the address it will come up on.
    const [app] = await appsList(srv, owner.rawSessionId);
    expect(app.state).toBe("stopped");
    expect(app.url).toBe(APP_URL);
  });
});
