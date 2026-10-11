import { afterEach, expect, it } from "bun:test";
import { anOfficeWithAnApp } from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { getUserByName, updateUserById } from "../users.ts";

let server: TestServer | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { await upstream?.stop(true); await server?.stop(); server = undefined; upstream = undefined; });
it("reads app tab metadata only after office login and app access", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => { server = s; });
  const app = appRegistry.get("hello")!;
  let reads = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: app.port, fetch(req) {
    reads++;
    expect(req.headers.has("cookie")).toBe(false);
    expect(req.headers.has("authorization")).toBe(false);
    return new Response('<title>Private app title</title><link rel="icon" href="https://hello.office.example/icon.png">', { headers: { "Content-Type": "text/html" } });
  } });
  await srv.http("/hello", { headers: { Host: "office.example" } });
  expect(reads).toBe(0);
  const allowed = await srv.http("/hello", { rawSessionId, headers: { Host: "office.example" } });
  expect((await allowed.text()).includes('<title>Private app title</title>')).toBe(true);
  expect(reads).toBe(1);
  const member = getUserByName("Member")!;
  updateUserById(member.id, { allowedRooms: [] });
  const denied = await srv.http("/hello", { rawSessionId, headers: { Host: "office.example" } });
  expect((await denied.text()).includes("Private app title")).toBe(false);
  expect(reads).toBe(1);
});
