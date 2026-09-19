import { startFlatOffice, raw, WS_UPGRADE_HEADERS } from "./app-host-test-kit";
import { memberRequest, ownedAgent, extensionSocket, origin } from "./browser-extension-route-fixture";
import { afterEach, test, expect } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { getAgentTokenRaw } from "../identity/tokens";
import { extensionUpgradeAllowed } from "../browser-extension-service";

let server: TestServer | undefined;
afterEach(async () => { await server?.stop(); server = undefined; });

test("production routes pair, bind Origin, reject office credential use, persist and revoke", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const other = await server.seedMember("Other");
  expect((await memberRequest(server, owner, "GET", "/api/me/browser")).status).toBe(200);
  expect(await (await memberRequest(server, other, "GET", "/api/me/browser")).json()).toMatchObject({ paired: false, backend: "headless" });
  const agent = await ownedAgent(server, owner, "browser agent");
  const token = getAgentTokenRaw(agent.id)!;
  expect((await server.http("/api/me/browser/pair", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(403);
  const { code } = await (await memberRequest(server, owner, "POST", "/api/me/browser/pair", {})).json();
  const socket = await extensionSocket(server, { kind: "hello", version: 1, code });
  const paired = await socket.wait("paired");
  const ready = await socket.wait("ready");
  expect(typeof paired.credential).toBe("string");
  expect((await server.http("/api/me/browser", { headers: { Authorization: `Bearer ${paired.credential}` } })).status).toBe(401);
  const duplicate = await extensionSocket(server, { kind: "hello", version: 1, credential: paired.credential });
  await duplicate.wait("refused");
  expect(socket.closed()).toBe(false);
  const reused = await extensionSocket(server, { kind: "hello", version: 1, code });
  await reused.wait("refused");
  const wrongOrigin = await extensionSocket(server, { kind: "hello", version: 1, credential: paired.credential }, "chrome-extension://" + "b".repeat(32));
  await wrongOrigin.wait("refused");
  expect((await memberRequest(server, owner, "PATCH", "/api/me/browser", { backend: "extension" })).status).toBe(204);
  server = await server.restart();
  const restored = await extensionSocket(server, { kind: "hello", version: 1, credential: paired.credential });
  const next = await restored.wait("ready");
  expect(next.generation).not.toBe(ready.generation);
  expect(await (await memberRequest(server, owner, "GET", "/api/me/browser")).json()).toMatchObject({ backend: "extension", paired: true, online: true });
  expect((await memberRequest(server, owner, "DELETE", "/api/me/browser")).status).toBe(204);
  await restored.wait("refused");
  expect(await (await memberRequest(server, owner, "GET", "/api/me/browser")).json()).toMatchObject({ paired: false, online: false });
});

test("extension socket requires exact Origin and canonical office host", () => {
  const request = (url: string, host: string, o: string) => new Request(url, { headers: { host, origin: o } });
  expect(extensionUpgradeAllowed(request("https://office.example/browser-extension/ws", "office.example", origin), "https://office.example")).toBe(true);
  for (const bad of ["null", "https://office.example", "", origin + "/", origin + ".evil"]) expect(extensionUpgradeAllowed(request("https://office.example/browser-extension/ws", "office.example", bad), "https://office.example")).toBe(false);
  expect(extensionUpgradeAllowed(request("https://app.office.example/browser-extension/ws", "app.office.example", origin), "https://office.example")).toBe(false);
  expect(extensionUpgradeAllowed(request("http://office.example/browser-extension/ws", "office.example", origin), "http://office.example")).toBe(false);
});

test("current manager room access loss actively detaches a pending agent action", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const member = await server.seedMember("Browser member");
  const room = server.agentManager.getOrdinaryRooms()[0].id;
  const access = async (rooms: string[]) => server!.http(`/api/users/${encodeURIComponent(member.username)}/access`, { method: "PUT", rawSessionId: owner.rawSessionId, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowedRooms: rooms }) });
  expect((await access([room])).status).toBe(200);
  const agent = await ownedAgent(server, member, "member browser agent");
  const { code } = await (await memberRequest(server, member, "POST", "/api/me/browser/pair", {})).json();
  const socket = await extensionSocket(server, { kind: "hello", version: 1, code });
  await socket.wait("ready");
  await memberRequest(server, member, "PATCH", "/api/me/browser", { backend: "extension" });
  const pending = server.http(`/api/agents/${agent.id}/browser`, { method: "POST", headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "goto", url: "https://example.com" }) });
  const command = await socket.wait("command");
  expect(command.method).toBe("create");
  expect((await access([])).status).toBe(200);
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("browser_control_ended");
  expect(socket.messages.some((m) => m.kind === "command" && m.method === "detach")).toBe(true);
  expect(socket.closed()).toBe(false);
  socket.ws.close();
});


test("app host dispatch cannot reach pairing or browser sockets", async () => {
  server = await startFlatOffice((s) => { server = s; });
  for (const path of ["/api/me/browser/pair", "/browser-extension/ws"]) {
    const response = await raw(server.port, { host: "unknown.office.example", path, ...(path.endsWith("/ws") ? { headers: { ...WS_UPGRADE_HEADERS, Origin: origin } } : { method: "POST" }) });
    expect(response.status).toBe(404);
  }
});
