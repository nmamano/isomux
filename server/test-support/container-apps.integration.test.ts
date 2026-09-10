import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerAppSupervisor } from "../container-app-supervisor.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  anAgentToken,
  signIn,
  raw,
  OFFICE_HOST,
  HTTPS_ORIGIN,
  wsConnect,
  withAppCookie,
} from "./app-host-test-kit.ts";
import { buildPublicOrigin } from "../auth.ts";
import type { AppWire } from "../../shared/types.ts";

let office: TestServer | undefined;
let daemon: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  await office?.stop();
  office = undefined;
  if (daemon && daemon.exitCode === null) {
    const stopped = new Promise<void>((resolve) =>
      daemon!.once("exit", () => resolve()),
    );
    daemon.kill("SIGTERM");
    await stopped;
  }
  if (root) rmSync(root, { force: true, recursive: true });
});

test("office API starts a real app, authenticates its hostname, relays WS, and preserves it on office restart", async () => {
  root = mkdtempSync(join(tmpdir(), "container-office-test-"));
  const socket = join(root, "runtime", "control.sock");
  const adapter = createContainerAppSupervisor(socket, () => OFFICE_HOST);
  daemon = spawn(
    "python3",
    [
      fileURLToPath(
        new URL("../../deploy/render/supervisor.py", import.meta.url),
      ),
      "serve",
      join(root, "runtime"),
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      adapter.reloadUnits();
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error("container supervisor did not start");
      await Bun.sleep(30);
    }
  }
  office = await startTestServer({ startServer: { appSupervisor: adapter } });
  const owner = await office.seedOwner("Boss");
  const configured = await office.http("/api/office/access", {
    method: "PUT",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalAccess: true, publicOrigin: HTTPS_ORIGIN }),
  });
  expect(configured.status).toBe(200);
  office = await office.restart();
  expect(buildPublicOrigin().origin).toBe(HTTPS_ORIGIN);
  writeFileSync(
    join(root, "web.ts"),
    `
Bun.serve({hostname: process.env.ISOMUX_APP_HOST, port: Number(process.env.PORT),
fetch(req, server) { if (server.upgrade(req)) return; return Response.json({pid: process.pid, message: "generated-app"}); },
websocket: {message(ws, message) { ws.send(message); }} });
`,
  );
  const token = await anAgentToken(office);
  const registered = await office.http("/api/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "generated",
      cwd: root,
      command: `${process.execPath} web.ts`,
    }),
  });
  expect(registered.status).toBe(201);
  const app = (await registered.json()) as AppWire;
  expect(app.url).toBe(`https://generated.${OFFICE_HOST}`);
  const cookie = await signIn(office, "generated", owner.rawSessionId);
  let read = await raw(office.port, {
    host: `generated.${OFFICE_HOST}`,
    headers: withAppCookie(cookie),
  });
  const readyAt = Date.now() + 3000;
  while (read.status !== 200 && Date.now() < readyAt) {
    await Bun.sleep(50);
    read = await raw(office.port, {
      host: `generated.${OFFICE_HOST}`,
      headers: withAppCookie(cookie),
    });
  }
  expect(read.status).toBe(200);
  expect(read.body).toContain("generated-app");
  const pid = (JSON.parse(read.body) as { pid: number }).pid;
  const denied = await raw(office.port, { host: `generated.${OFFICE_HOST}` });
  expect(denied.status).toBe(302);
  expect(denied.headers.location).toStartWith(`${HTTPS_ORIGIN}/auth/app?`);
  const ws = await wsConnect(office.port, {
    host: `generated.${OFFICE_HOST}`,
    path: "/echo",
    cookie,
    headers: { Origin: `https://generated.${OFFICE_HOST}` },
  });
  expect(ws.ok).toBe(true);
  if (ws.ok) {
    try {
      ws.client.send("synthetic-echo");
      expect(await ws.client.next()).toEqual({
        kind: "text",
        text: "synthetic-echo",
      });
    } finally {
      ws.client.drop();
    }
  }
  office = await office.restart();
  const renewedCookie = await signIn(office, "generated", owner.rawSessionId);
  const afterRestart = await raw(office.port, {
    host: `generated.${OFFICE_HOST}`,
    headers: withAppCookie(renewedCookie),
  });
  expect(afterRestart.status).toBe(200);
  expect((JSON.parse(afterRestart.body) as { pid: number }).pid).toBe(pid);
  const deleted = await office.http("/api/apps/generated", {
    method: "DELETE",
    rawSessionId: owner.rawSessionId,
  });
  expect(deleted.status).toBe(204);
  const missing = await raw(office.port, {
    host: `generated.${OFFICE_HOST}`,
    headers: withAppCookie(cookie),
  });
  expect(missing.status).toBe(404);
}, 30000);
