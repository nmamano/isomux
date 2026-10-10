// Real request pipeline; the preload creates an isolated ISOMUX_HOME and the
// harness binds an ephemeral port with a fake app supervisor (no systemd writes).
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { anAgentToken, HTTPS_ORIGIN, OFFICE_HOST, raw, registerApp, startFlatOffice } from "./app-host-test-kit.ts";
import { appRegistry } from "../app-registry.ts";
import type { AppWire } from "../../shared/types.ts";

let server: TestServer | undefined;
afterEach(async () => { await server?.stop(); server = undefined; });

async function getApp(srv: TestServer, token: string, name: string): Promise<AppWire> {
  const response = await srv.http(`/api/apps/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as AppWire;
}

describe("short app links through the office request pipeline", () => {
  it("redirects signed-out GET and HEAD with an optional slash and passes queries only to the app host", async () => {
    const srv = await startFlatOffice((current) => { server = current; });
    const token = await anAgentToken(srv);
    await registerApp(srv, token, "board");
    const app = await getApp(srv, token, "board");
    expect(app.url).toBe(`https://board.${OFFICE_HOST}`);
    expect(app.shortUrl).toBe(`${HTTPS_ORIGIN}/board`);
    for (const method of ["GET", "HEAD"]) {
      for (const suffix of ["", "/", "?x=1", "/?x=1", "?@evil.example", "?//evil.example"]) {
        const response = await raw(srv.port, { host: OFFICE_HOST, method, path: `/board${suffix}` });
        const target = new URL(app.url!);
        target.search = new URL(`${HTTPS_ORIGIN}/board${suffix}`).search;
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(target.href);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toBe("");
      }
    }
    expect(readFileSync(join(srv.stateRoot, "apps", "apps.json"), "utf8")).not.toContain('"shortUrl"');
    const otherHost = await raw(srv.port, { host: "other.example", path: "/board" });
    expect(otherHost.headers.location).not.toBe(`${app.url}/`);
    const appHost = await raw(srv.port, { host: `board.${OFFICE_HOST}`, path: "/board" });
    expect(appHost.headers.location).toStartWith(`${HTTPS_ORIGIN}/auth/app?`);
  });

  it("keeps unknown, deeper, POST and office paths unchanged and retains archived links", async () => {
    const srv = await startFlatOffice((current) => { server = current; });
    const token = await anAgentToken(srv);
    const cases = [
      { path: "/missing" }, { path: "/tasks" }, { path: "/skills" },
      { path: "/board/deeper" }, { path: "/board", method: "POST", headers: { "Content-Length": "0" } },
    ];
    const before = await Promise.all(cases.map((item) => raw(srv.port, { host: OFFICE_HOST, ...item })));
    await registerApp(srv, token, "board");
    for (let index = 0; index < cases.length; index++) {
      const response = await raw(srv.port, { host: OFFICE_HOST, ...cases[index] });
      expect(response.stable).toBe(before[index].stable);
    }
    for (const action of ["stop", "archive"]) {
      const response = await srv.http(`/api/apps/board/${action}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect((await response.json() as AppWire).shortUrl).toBe(`${HTTPS_ORIGIN}/board`);
    }
    const archived = await raw(srv.port, { host: OFFICE_HOST, path: "/board" });
    expect(archived.status).toBe(302);
    expect(archived.headers.location).toBe(`https://board.${OFFICE_HOST}/`);
    expect((await srv.http("/api/apps/board", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
    expect((await raw(srv.port, { host: OFFICE_HOST, path: "/board" })).status).not.toBe(302);
  });

  it("keeps a colliding legacy app's own URL without a short field or redirect and refuses new collisions", async () => {
    const srv = await startFlatOffice((current) => { server = current; });
    const token = await anAgentToken(srv);
    const before = await raw(srv.port, { host: OFFICE_HOST, path: "/skills" });
    await registerApp(srv, token, "board");
    const original = appRegistry.get("board")!;
    writeFileSync(join(srv.stateRoot, "apps", "apps.json"), JSON.stringify([{ ...original, name: "skills", hostLabel: undefined, hostGen: undefined }]));
    const app = await getApp(srv, token, "skills");
    expect(app.url).toBe(`https://skills.${OFFICE_HOST}`);
    expect(app).not.toHaveProperty("shortUrl");
    const after = await raw(srv.port, { host: OFFICE_HOST, path: "/skills" });
    expect(after.stable).toBe(before.stable);
    for (const name of ["tasks", "settings", "i", "hooks", "icons", "katex"]) {
      const response = await srv.http("/api/apps", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, command: "bun app.ts", cwd: srv.stateRoot }) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("reserved_name");
    }
  });

  it("keeps port-only offices without a short field or redirect", async () => {
    const srv = await startTestServer();
    server = srv;
    const token = await anAgentToken(srv);
    const before = await raw(srv.port, { host: "localhost", path: "/board" });
    await registerApp(srv, token, "board");
    const app = await getApp(srv, token, "board");
    expect(app).not.toHaveProperty("url");
    expect(app).not.toHaveProperty("shortUrl");
    const after = await raw(srv.port, { host: "localhost", path: "/board" });
    expect(after.stable).toBe(before.stable);
  });
});

it("keeps office routes and unknown pages available when the app registry is corrupt", async () => {
  const srv = await startFlatOffice((current) => { server = current; });
  const token = await anAgentToken(srv);
  await registerApp(srv, token, "board");
  const requests = ["GET", "HEAD"].flatMap((method) =>
    ["/tasks", "/settings", "/nosuchpage"].flatMap((path) =>
      [false, true].map((signedIn) => ({ host: OFFICE_HOST, method, path, ...(signedIn ? { headers: { Authorization: `Bearer ${token}` } } : {}) })),
    ),
  );
  const before = await Promise.all(requests.map((request) => raw(srv.port, request)));
  writeFileSync(join(srv.stateRoot, "apps", "apps.json"), "{not json");
  expect(() => appRegistry.get("board")).toThrow();
  const lookup = spyOn(appRegistry, "get");
  try {
    for (let index = 0; index < requests.length; index++) {
      lookup.mockClear();
      const after = await raw(srv.port, requests[index]);
      expect(after.stable).toBe(before[index].stable);
      // The catch also protects unknown pages. Named office paths must not
      // read the registry at all, even when that catch would hide the error.
      expect(lookup.mock.calls.length).toBe(requests[index].path === "/nosuchpage" ? 1 : 0);
    }
  } finally {
    lookup.mockRestore();
  }
});
