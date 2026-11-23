// The register route warms the new app's certificate (task f75f570e): on an
// office with app hostnames, POST /api/apps opens a TLS handshake for
// <label>.<domain> and answers only after it. Seam: startTestServer() with
// startServer.warmAppCertificate; the harness default is a stand-in, so these
// tests pass their own. No test opens a real :443 or looks up a name in DNS.

import { afterEach, describe, expect, it } from "bun:test";
import { createSecureContext, createServer, type Server } from "tls";

import { warmAppCertificate } from "../app-cert-warm.ts";
import { appHostDomain } from "../app-domain.ts";
import { appRegistry } from "../app-registry.ts";
import {
  createCertificateAuthority,
  createLeafIssuer,
} from "../secret-proxy/x509.ts";
import {
  HTTPS_ORIGIN,
  OFFICE_HOST,
  anAgentToken,
  registerApp,
  startFlatOffice,
} from "./app-host-test-kit.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
let tlsServer: Server | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  const s = tlsServer;
  tlsServer = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
});

function track(srv: TestServer): void {
  server = srv;
}

function deferred(): {
  promise: Promise<boolean>;
  resolve: (v: boolean) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: boolean) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function postApp(srv: TestServer, token: string, name: string) {
  return srv.http("/api/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      command: "bun run serve.ts",
      cwd: srv.workDir,
    }),
  });
}

describe("register warms the app certificate", () => {
  it("opens a handshake for <label>.<domain> before it answers", async () => {
    const leaf = createLeafIssuer(
      createCertificateAuthority(),
      () => true,
    ).issue("api.example-stub.test");
    // Read in the SNI callback: Bun's TLS server does not call its connection
    // listener for a client that hangs up right after the handshake.
    const sni: string[] = [];
    const context = createSecureContext({
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    tlsServer = createServer({
      cert: leaf.certPem,
      key: leaf.keyPem,
      SNICallback: (name, cb) => {
        sni.push(name);
        cb(null, context);
      },
    });
    const port = await new Promise<number>((resolve) => {
      tlsServer!.listen(0, "127.0.0.1", () => {
        resolve((tlsServer!.address() as { port: number }).port);
      });
    });

    const srv = await startFlatOffice(track, {
      startServer: {
        warmAppCertificate: (hostname) =>
          warmAppCertificate(hostname, {
            targets: [{ host: "127.0.0.1", port }],
            timeoutMs: 5_000,
          }),
      },
    });
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    // Read the moment the 201 is in: the handshake already happened.
    expect(sni).toEqual([`${label}.${OFFICE_HOST}`]);
  });

  it("holds the 201 until the warm-up finishes", async () => {
    const warm = deferred();
    const calls: string[] = [];
    const srv = await startFlatOffice(track, {
      startServer: {
        warmAppCertificate: (hostname) => {
          calls.push(hostname);
          return warm.promise;
        },
      },
    });
    const token = await anAgentToken(srv);
    let settled = false;
    const res = postApp(srv, token, "hello").then((r) => {
      settled = true;
      return r;
    });
    // The warm-up has started and has not finished.
    for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(20);
    expect(calls).toEqual([`hello.${OFFICE_HOST}`]);
    await Bun.sleep(200);
    expect(settled).toBe(false);

    warm.resolve(true);
    expect((await res).status).toBe(201);
  });

  // The warm-up takes seconds, and the app can change in that time. What the
  // office was told last must be the app's real state, so the register
  // announcement may not land after a delete that came during the warm-up.
  it("does not announce an app deleted during its warm-up", async () => {
    const warm = deferred();
    let called = false;
    // startFlatOffice's steps, kept here for the owner's session: the
    // owner watches the office socket.
    const first = await startTestServer({
      startServer: {
        warmAppCertificate: () => {
          called = true;
          return warm.promise;
        },
      },
    });
    track(first);
    const owner = await first.seedOwner("Morgan");
    const access = await first.http("/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalAccess: true,
        publicOrigin: HTTPS_ORIGIN,
      }),
    });
    expect(access.status).toBe(200);
    const srv = await first.restart();
    track(srv);
    expect(appHostDomain()).toBe(OFFICE_HOST);
    const ws = await srv.connectWs(owner.rawSessionId);
    const token = await anAgentToken(srv);
    const res = postApp(srv, token, "hello");
    for (let i = 0; i < 100 && !called; i++) await Bun.sleep(20);
    expect(called).toBe(true);

    const del = await srv.http("/api/apps/hello", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);
    warm.resolve(true);
    expect((await res).status).toBe(201);
    await Bun.sleep(100);

    const events = (
      ws.messages as { type?: string; name?: string; app?: { name?: string } }[]
    )
      .filter(
        (m) =>
          (m.type === "app_upserted" && m.app?.name === "hello") ||
          (m.type === "app_deleted" && m.name === "hello"),
      )
      .map((m) => m.type);
    // The deletion was heard, and it is the last word on the app.
    expect(events).toContain("app_deleted");
    expect(events.at(-1)).toBe("app_deleted");
  });

  it("still answers 201 when the warm-up throws", async () => {
    let calls = 0;
    const srv = await startFlatOffice(track, {
      startServer: {
        warmAppCertificate: async () => {
          calls++;
          throw new Error("warm-up exploded");
        },
      },
    });
    const token = await anAgentToken(srv);
    const res = await postApp(srv, token, "hello");
    expect(calls).toBe(1);
    expect(res.status).toBe(201);
    expect(appRegistry.get("hello")).not.toBeNull();
  });

  it("does not run on an office without app hostnames", async () => {
    const calls: string[] = [];
    const srv = await startTestServer({
      startServer: {
        warmAppCertificate: async (hostname) => {
          calls.push(hostname);
          return true;
        },
      },
    });
    track(srv);
    expect(appHostDomain()).toBeNull();
    const token = await anAgentToken(srv);
    const res = await postApp(srv, token, "hello");
    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
  });
});
