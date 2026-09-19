import { afterEach, expect, test } from "bun:test";
import { createSetupHandler } from "./bootstrap.ts";
import { claimOwnership, setCookieHeader } from "../../server/auth.ts";
import {
  startTestServer,
  type TestServer,
} from "../../server/test-support/harness.ts";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

test("public setup requires its secret and origin and closes after owner creation", async () => {
  let owner = false;
  let claims = 0;
  const key = "synthetic-setup-key-32-characters-long";
  const handler = createSetupHandler({
    origin: "https://office.example.com",
    key,
    hasOwner: () => owner,
    complete: () => {},
    claim: async () => {
      owner = true;
      claims++;
      return "__Host-isomux_session=synthetic; Secure; HttpOnly; Path=/";
    },
  });
  const post = (secret: string, origin = "https://office.example.com") =>
    handler(
      new Request("https://office.example.com/setup", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ key: secret, name: "Owner" }),
      }),
    );
  expect((await post("wrong")).status).toBe(403);
  expect((await post(key, "https://other.example.com")).status).toBe(403);
  expect(claims).toBe(0);
  const accepted = await post(key);
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("Secure; HttpOnly");
  expect(claims).toBe(1);
  expect((await post(key)).status).toBe(409);
  expect(claims).toBe(1);
});

test("a container setup claim seeds the three welcome agents after office boot", async () => {
  server = await startTestServer();
  let claimedUsername: string | undefined;
  const key = "synthetic-setup-key-32-characters-long";
  const handler = createSetupHandler({
    origin: "https://office.example.com",
    key,
    hasOwner: () => false,
    complete: () => {},
    claim: async (name, userAgent) => {
      const result = await claimOwnership(name, { userAgent });
      if (!result.ok) return null;
      claimedUsername = result.username;
      return setCookieHeader(result.rawSessionId, result.absoluteExpiresAt);
    },
  });

  const response = await handler(
    new Request("https://office.example.com/setup", {
      method: "POST",
      headers: {
        origin: "https://office.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ key, name: "Owner" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(claimedUsername).toBe("Owner");

  server = await server.restart();

  const agents = server.agentManager.getAllAgents();
  const names = agents.map((agent) => agent.name).sort();
  expect(names).toEqual([
    "Claude Welcome Agent",
    "Codex Welcome Agent",
    "Free Welcome Agent",
    "Receptionist",
  ]);
  expect(agents.find((agent) => agent.roomId === LOBBY_ROOM_ID)?.name).toBe(
    "Receptionist",
  );

  const ids = agents.map((agent) => agent.id).sort();
  server = await server.restart();
  expect(
    server.agentManager
      .getAllAgents()
      .map((agent) => agent.id)
      .sort(),
  ).toEqual(ids);
});
