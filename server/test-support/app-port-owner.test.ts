// Who listens on an app's port (app-port-owner.ts, slice 3b of task
// b94dfd25). The relay sends a request, and the app's proxy secret, only
// when every listening socket on the app's port belongs to the uid that runs
// the app, and one accepts 127.0.0.1. The properties:
// - the rule: another uid on any address of the port refuses, a v4-mapped
//   or wildcard socket of the owner covers 127.0.0.1, no covering socket
//   refuses;
// - the socket tables are read at every request, never held;
// - a table that cannot be read refuses;
// - the kernel's two sources (sock_diag and /proc) agree on a real socket;
// - through the office: an isolated member's app whose port is held by
//   another uid gets no request, and the same app on her uid is relayed.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppPortCheck,
  parseListeners,
  portOwnerVerdict,
  readListeners,
  type PortListener,
} from "../app-port-owner.ts";
import {
  NAVIGATION_HEADERS,
  HTTPS_ORIGIN,
  appHost,
  raw,
  signIn,
  withAppCookie,
  wsConnect,
  TEST_APP_RESPONSE_HEADERS,
} from "./app-host-test-kit.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { buildPublicOrigin } from "../auth.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { fakeMemberAppSupervisor } from "./fake-member-runner.ts";
import type { AgentInfo } from "../../shared/types.ts";

const OWNER = 4711;
const OTHER = 4712;
const PORT = 21005;
const row = (address: string, uid: number, port = PORT): PortListener => ({
  address,
  port,
  uid,
});

describe("the rule", () => {
  // MUTANT: only the most specific row counts (dies on the wildcard rows).
  it("refuses another uid on any address of the port, next to the owner's 127.0.0.1", () => {
    const verdicts = ["0.0.0.0", "::", "::ffff:127.0.0.1", "10.0.0.5"].map(
      (other) =>
        portOwnerVerdict(
          [row("127.0.0.1", OWNER), row(other, OTHER)],
          PORT,
          OWNER,
        ).ok,
    );
    expect(verdicts).toEqual([false, false, false, false]);
  });

  it("relays a port the owner holds on 127.0.0.1, the wildcards or v4-mapped", () => {
    const verdicts = [
      "127.0.0.1",
      "0.0.0.0",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:0.0.0.0",
    ].map((address) => portOwnerVerdict([row(address, OWNER)], PORT, OWNER).ok);
    expect(verdicts).toEqual([true, true, true, true, true]);
  });

  it("refuses when no socket of the owner accepts 127.0.0.1, or the uid is not known", () => {
    expect([
      portOwnerVerdict([], PORT, OWNER).ok,
      portOwnerVerdict([row("10.0.0.5", OWNER)], PORT, OWNER).ok,
      portOwnerVerdict([row("127.0.0.1", OWNER)], PORT, null).ok,
      // Another port's sockets do not count, either way.
      portOwnerVerdict(
        [row("127.0.0.1", OWNER), row("127.0.0.1", OTHER, PORT + 1)],
        PORT,
        OWNER,
      ).ok,
    ]).toEqual([false, false, false, true]);
  });

  it("reads LISTEN rows of /proc/net/tcp and tcp6, with their addresses and uids", () => {
    const header =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    // 127.0.0.1:21005 LISTEN uid 4711; 0.0.0.0:21005 ESTABLISHED (not a
    // listener); [::ffff:127.0.0.1]:21005 LISTEN uid 4712.
    const tcp = [
      header,
      "   0: 0100007F:520D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  4711        0 1 1 0 100 0 0 10 0",
      "   1: 00000000:520D 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  4712        0 2 1 0 100 0 0 10 0",
    ].join("\n");
    const tcp6 = [
      header,
      "   0: 0000000000000000FFFF00000100007F:520D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  4712        0 3 1 0 100 0 0 10 0",
    ].join("\n");
    expect([...parseListeners(tcp), ...parseListeners(tcp6)]).toEqual([
      row("127.0.0.1", OWNER),
      row("::ffff:127.0.0.1", OTHER),
    ]);
  });
});

describe("the check at each request", () => {
  const table = (uid: number) =>
    `header\n   0: 0100007F:520D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 1 1 0 100 0 0 10 0\n`;

  // MUTANT: the check holds its first answer (dies on the second request).
  it("asks the tables again for every request: a socket that changes hands is refused at once", () => {
    let uid = OWNER;
    const check = createAppPortCheck({
      appUid: () => OWNER,
      platform: "linux",
      anyIsolated: () => true,
      read: (path) => (path.endsWith("tcp") ? table(uid) : "header\n"),
      log: () => {},
    });
    const app = { name: "hello", port: PORT };
    const first = check(app).ok;
    uid = OTHER;
    expect([first, check(app).ok]).toEqual([true, false]);
  });

  it("refuses when the tables cannot be read", () => {
    const check = createAppPortCheck({
      appUid: () => OWNER,
      platform: "linux",
      anyIsolated: () => true,
      read: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      log: () => {},
    });
    expect(check({ name: "hello", port: PORT }).ok).toBe(false);
  });

  it("finds a real listening socket with this process's uid, in sock_diag and in /proc alike", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("x"),
    });
    try {
      const port = server.port!;
      const mine = (rows: PortListener[] | null) =>
        (rows ?? []).filter((r) => r.port === port);
      const diag = mine(readListeners());
      const proc = mine(readListeners((path) => readFileSync(path, "utf8")));
      expect([diag, proc]).toEqual([
        [row("127.0.0.1", process.getuid!(), port)],
        [row("127.0.0.1", process.getuid!(), port)],
      ]);
    } finally {
      void server.stop(true);
    }
  });
});

// Through the office: the front door, the app host, the relay and the
// router's appUid. Alice is isolated; her app's host says her uid, and the
// app itself listens as this process (the office's uid): the squat.
describe("the relay to an isolated member's app", () => {
  let server: TestServer | null = null;
  let iso: IsolatedMember | null = null;
  let app: ReturnType<typeof Bun.serve> | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    void app?.stop(true);
    app = null;
    await server?.stop();
    server = null;
    iso?.dispose();
    iso = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function aliceApp(hostUid: number) {
    const opts = {
      startServer: {
        memberAppSupervisor: fakeMemberAppSupervisor({ uid: hostUid }),
      },
    };
    const first = await startTestServer(opts);
    server = first;
    const owner = await first.seedOwner("Morgan");
    const r = await first.http("/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalAccess: true,
        publicOrigin: HTTPS_ORIGIN,
      }),
    });
    if (r.status !== 200) throw new Error(`access PUT failed: ${r.status}`);
    const srv = await first.restart();
    server = srv;
    if (buildPublicOrigin().origin !== HTTPS_ORIGIN)
      throw new Error("expected the HTTPS origin after restart");
    const alice = await srv.seedMember("PortAlice");
    const aliceId = getUserByName("PortAlice")!.id;
    const room = srv.agentManager.getRooms()[0]!.id;
    if (!updateUserById(aliceId, { allowedRooms: [room] }).ok)
      throw new Error("allowedRooms");
    iso = await isolateMember(aliceId);
    const cwd = mkdtempSync(join(tmpdir(), "port-owner-"));
    dirs.push(cwd);
    const agent = (await srv.agentManager.spawn(
      "Alice app bot",
      cwd,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      "PortAlice",
      "claude",
      undefined,
      aliceId,
    )) as AgentInfo;
    const token = mintAgentToken(agent.id, aliceId);
    const reg = await srv.http("/api/apps", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "alice-app",
        command: "bun run serve.ts",
        cwd,
      }),
    });
    if (reg.status !== 201)
      throw new Error(`register: ${reg.status} ${await reg.text()}`);
    const record = appRegistry.get("alice-app")!;
    const seen: string[] = [];
    app = Bun.serve({
      port: record.port,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return new Response("the app", { headers: TEST_APP_RESPONSE_HEADERS });
      },
    });
    const cookie = await signIn(srv, record.hostLabel, alice.rawSessionId);
    const res = await raw(srv.port, {
      host: appHost(record.hostLabel),
      path: "/page",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    const ws = await wsConnect(srv.port, {
      host: appHost(record.hostLabel),
      path: "/ws",
      cookie,
    });
    if (ws.ok) ws.client.drop();
    return {
      res,
      ws: ws.ok ? 101 : ws.response.status,
      seen,
      owner: record.userId === aliceId,
    };
  }

  // MUTANT: relayToApp or relayWsToApp without proveAppPortOwner (dies
  // on that leg's status and on what the app saw).
  it("sends nothing to a port that another uid holds, on HTTP or a WebSocket upgrade", async () => {
    const got = await aliceApp(process.getuid!() + 1);
    expect([got.owner, got.res.status, got.ws, got.seen]).toEqual([
      true,
      502,
      502,
      [],
    ]);
  });

  it("relays the same app when its port is held by her uid", async () => {
    const got = await aliceApp(process.getuid!());
    // The app answers the upgrade with a page, so the upgrade fails after
    // it reached the app.
    expect([got.owner, got.res.status, got.seen]).toEqual([
      true,
      200,
      ["/page", "/ws"],
    ]);
  });
});
