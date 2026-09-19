import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mayUseExtension } from "../isomux-office";
import { getUserByName } from "../users";
import { startFlatOffice, raw, WS_UPGRADE_HEADERS } from "./app-host-test-kit";
import {
  memberRequest,
  ownedAgent,
  extensionSocket,
  origin,
} from "./browser-extension-route-fixture";
import { afterEach, test, expect } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { getAgentTokenRaw } from "../identity/tokens";
import { extensionUpgradeAllowed } from "../browser-extension-service";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("production routes pair, bind Origin, reject office credential use, persist and revoke", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const other = await server.seedMember("Other");
  expect(
    (await memberRequest(server, owner, "GET", "/api/me/browser")).status,
  ).toBe(200);
  expect(
    await (await memberRequest(server, other, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: false });
  const agent = await ownedAgent(server, owner, "browser agent");
  expect(mayUseExtension(getUserByName(owner.username)!.id, agent.id)).toBe(
    true,
  );
  expect(
    (
      await memberRequest(
        server,
        owner,
        "PUT",
        `/api/users/${other.username}/access`,
        { allowedRooms: [agent.roomId] },
      )
    ).status,
  ).toBe(200);
  expect(mayUseExtension(getUserByName(other.username)!.id, agent.id)).toBe(
    false,
  );
  const token = getAgentTokenRaw(agent.id)!;
  expect(
    (
      await server.http("/api/me/browser/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const { code } = await (
    await memberRequest(server, owner, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 3,
    code,
  });
  const paired = await socket.wait("paired");
  const ready = await socket.wait("ready");
  expect(typeof paired.credential).toBe("string");
  expect(
    (
      await server.http("/api/me/browser", {
        headers: { Authorization: `Bearer ${String(paired.credential)}` },
      })
    ).status,
  ).toBe(401);
  const duplicate = await extensionSocket(server, {
    kind: "hello",
    version: 3,
    credential: paired.credential,
  });
  await duplicate.wait("refused");
  expect(socket.closed()).toBe(false);
  const reused = await extensionSocket(server, {
    kind: "hello",
    version: 3,
    code,
  });
  await reused.wait("refused");
  const wrongOrigin = await extensionSocket(
    server,
    { kind: "hello", version: 3, credential: paired.credential },
    "chrome-extension://" + "b".repeat(32),
  );
  await wrongOrigin.wait("refused");
  const retired = await memberRequest(server, owner, "PATCH", "/api/me/browser", { backend: "headless" });
  expect(retired.status).toBe(404);
  expect(retired.headers.get("content-type")).toBe("application/json");
  expect(await retired.json()).toEqual({ error: "not found" });
  const anonymous = await server.http("/api/me/browser", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ backend: "headless" }),
  });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("content-type")).toBe("application/json");
  expect(await anonymous.json()).toEqual({ error: "unauthenticated" });
  server = await server.restart();
  const restored = await extensionSocket(server, {
    kind: "hello",
    version: 3,
    credential: paired.credential,
  });
  const next = await restored.wait("ready");
  expect(next.generation).not.toBe(ready.generation);
  expect(
    await (await memberRequest(server, owner, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: true, online: true });
  expect(
    (await memberRequest(server, owner, "DELETE", "/api/me/browser")).status,
  ).toBe(204);
  await restored.wait("refused");
  expect(
    await (await memberRequest(server, owner, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: false, online: false });
});

test("extension socket requires exact Origin and canonical office host", () => {
  const request = (url: string, host: string, o: string) =>
    new Request(url, { headers: { host, origin: o } });
  expect(
    extensionUpgradeAllowed(
      request(
        "https://office.example/browser-extension/ws",
        "office.example",
        origin,
      ),
      "https://office.example",
    ),
  ).toBe(true);
  for (const bad of [
    "null",
    "https://office.example",
    "",
    origin + "/",
    origin + ".evil",
  ])
    expect(
      extensionUpgradeAllowed(
        request(
          "https://office.example/browser-extension/ws",
          "office.example",
          bad,
        ),
        "https://office.example",
      ),
    ).toBe(false);
  expect(
    extensionUpgradeAllowed(
      request(
        "https://app.office.example/browser-extension/ws",
        "app.office.example",
        origin,
      ),
      "https://office.example",
    ),
  ).toBe(false);
  expect(
    extensionUpgradeAllowed(
      request(
        "http://office.example/browser-extension/ws",
        "office.example",
        origin,
      ),
      "http://office.example",
    ),
  ).toBe(false);
});

test("current manager room access loss actively detaches a pending agent action", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const member = await server.seedMember("Browser member");
  const room = server.agentManager.getOrdinaryRooms()[0].id;
  const access = async (rooms: string[]) =>
    server!.http(`/api/users/${encodeURIComponent(member.username)}/access`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: rooms }),
    });
  expect((await access([room])).status).toBe(200);
  const agent = await ownedAgent(server, member, "member browser agent");
  const { code } = await (
    await memberRequest(server, member, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 3,
    code,
  });
  await socket.wait("ready");
  const generation = (await socket.wait("ready")).generation;
  socket.ws.send(JSON.stringify({ kind: "offer", generation, durationMinutes: 0, assignment: crypto.randomUUID(), agent: agent.id }));
  const attach = await socket.wait("command");
  expect(attach.method).toBe("attach");
  socket.ws.send(JSON.stringify({ kind: "result", generation, id: attach.id,
    result: { targetInfo: { targetId: "owned", browserContextId: "context", type: "page", url: "https://example.com/" } } }));
  await socket.wait("offered");
  socket.messages.length = 0;
  const pending = server.http(`/api/agents/${agent.id}/browser`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "goto", url: "https://example.com" }),
  });
  const command = await socket.wait("command");
  expect(command.method).toBe("cdp");
  expect((await access([])).status).toBe(200);
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("browser_control_ended");
  for (let i = 0; i < 100 && !socket.messages.some(m => m.method === "detach"); i++) await Bun.sleep(5);
  expect(socket.messages.some(m => m.method === "detach")).toBe(true);
  expect(socket.closed()).toBe(false);
  socket.ws.close();
});

test("app host dispatch cannot reach pairing or browser sockets", async () => {
  server = await startFlatOffice((s) => {
    server = s;
  });
  for (const path of [
    "/api/me/browser/pair",
    "/browser-extension/ws",
    "/api/me/browser/extension.zip",
  ]) {
    const response = await raw(server.port, {
      host: "unknown.office.example",
      path,
      ...(path.endsWith("/ws")
        ? { headers: { ...WS_UPGRADE_HEADERS, Origin: origin } }
        : { method: path.endsWith(".zip") ? "GET" : "POST" }),
    });
    expect(response.status).toBe(404);
  }
});

test("corrupt browser state permits office startup and requires fresh Chrome pairing", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const agent = await ownedAgent(server, owner, "corrupt state browser");
  writeFileSync(join(server.stateRoot, "browser-connections.json"), "{");
  server = await server.restart();
  const status = await (await memberRequest(server, owner, "GET", "/api/me/browser")).json();
  expect(status).toMatchObject({ paired: false, online: false });
  expect(status).not.toHaveProperty("backend");
  const action = await server.http(`/api/agents/${agent.id}/browser`, {
    method: "POST", headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "snapshot" }),
  });
  expect((await action.json()).error.code).toBe("browser_not_paired");
  const pair = await memberRequest(server, owner, "POST", "/api/me/browser/pair", {});
  expect(pair.status).toBe(200);
  const extension = await extensionSocket(server, { kind: "hello", version: 3, code: (await pair.json()).code });
  await extension.wait("ready");
});

test("extension ZIP download is self-authenticated and metadata is the current member", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner("Package owner");
  const agent = await ownedAgent(server, owner, "Package agent");
  const path = "/api/me/browser/extension.zip";
  expect((await server.http(path)).status).toBe(401);
  expect(
    (
      await server.http(path, {
        headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}` },
      })
    ).status,
  ).toBe(403);
  const response = await memberRequest(server, owner, "GET", path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-type")).toBe("application/zip");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
  const status = await (
    await memberRequest(server, owner, "GET", "/api/me/browser")
  ).json();
  expect(status.member).toEqual({
    id: getUserByName(owner.username)!.id,
    name: owner.username,
  });
  expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
  // Safe GETs use the existing cookie/SameSite + no-CORS boundary, not the write CSRF gate.
  const foreign = await fetch(server.baseUrl + path, {
    headers: {
      Cookie: `isomux_session=${owner.rawSessionId}`,
      Origin: "https://foreign.example",
    },
  });
  expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
});
