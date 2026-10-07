import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
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
      "203.0.113.10",
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

async function startingPage(): Promise<Response> {
  const key = "synthetic-setup-key-32-characters-long";
  const handler = createSetupHandler({
    origin: "https://office.example.com",
    key,
    hasOwner: () => false,
    complete: () => {},
    claim: async () =>
      "__Host-isomux_session=synthetic; Secure; HttpOnly; Path=/",
  });
  return handler(
    new Request("https://office.example.com/setup", {
      method: "POST",
      headers: {
        origin: "https://office.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ key, name: "Owner" }),
    }),
    "203.0.113.10",
  );
}

// Runs the starting page's script on a virtual clock against a scripted
// sequence of answers to its polls of "/". Returns the second at which the
// page opened the office, or null.
async function openedAt(
  script: string,
  answers: (number | Error)[],
): Promise<number | null> {
  let now = 0;
  let opened: number | null = null;
  const timers: { at: number; run: () => void }[] = [];
  const polls: string[] = [];
  runInNewContext(script, {
    setTimeout: (run: () => void, ms: number) =>
      timers.push({ at: now + ms, run }),
    fetch: async (url: string) => {
      polls.push(url);
      const answer = answers.shift() ?? 502;
      if (answer instanceof Error) throw answer;
      return { status: answer };
    },
    location: {
      replace: (url: string) => {
        expect(url).toBe("/");
        opened = now / 1000;
      },
    },
  });
  while (opened === null && timers.length > 0 && now < 120_000) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift()!;
    now = next.at;
    next.run();
    // Let the awaited fetch settle before the next timer fires.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  expect(new Set(polls)).toEqual(new Set(["/"]));
  return opened;
}

test("the starting page opens the office only when the office answers, however long it boots", async () => {
  const response = await startingPage();
  expect(response.status).toBe(200);
  const html = await response.text();
  // No timed redirect: it lands on the proxy's 502 when the boot is slow.
  expect(html).not.toMatch(/http-equiv="refresh"/i);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const script = scripts[0][1];
  // The page's own CSP allows exactly this script and its same-origin polls.
  const csp = response.headers.get("content-security-policy")!;
  const hash = createHash("sha256").update(script).digest("base64");
  expect(csp).toContain(`script-src 'sha256-${hash}'`);
  expect(csp).toContain("connect-src 'self'");

  // The setup listener answers 409 until it closes; then the proxy refuses or
  // answers 502 for 10 s, longer than the old 3 s refresh.
  const gap = [409, new TypeError("connection reset"), ...Array(10).fill(502)];
  expect(await openedAt(script, [...gap, 200])).toBe(13);
  // An office that answers without the new session still opens: its own
  // sign-in gate takes over.
  expect(await openedAt(script, [...gap, 401])).toBe(13);
  // Any other answer keeps the page waiting.
  expect(await openedAt(script, [503, 504, 500, 404])).toBeNull();
});

test("setup attempts are limited per client, so one caller cannot block the claim", async () => {
  let owner = false;
  const key = "synthetic-setup-key-32-characters-long";
  const handler = createSetupHandler({
    origin: "https://office.example.com",
    key,
    hasOwner: () => owner,
    complete: () => {},
    claim: async () => {
      owner = true;
      return "__Host-isomux_session=synthetic; Secure; HttpOnly; Path=/";
    },
  });
  const post = (secret: string, client: string) =>
    handler(
      new Request("https://office.example.com/setup", {
        method: "POST",
        headers: {
          origin: "https://office.example.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ key: secret, name: "Owner" }),
      }),
      client,
    );
  const noisy = "198.51.100.7";
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++)
    statuses.push((await post("wrong", noisy)).status);
  // Wrong keys are refused until the noisy client runs out of attempts.
  expect(new Set(statuses.slice(0, -1))).toEqual(new Set([403]));
  expect(statuses.at(-1)).toBe(429);
  expect((await post(key, noisy)).status).toBe(429);
  expect(owner).toBe(false);
  // Another client still reaches the key check and claims the office.
  expect((await post(key, "203.0.113.10")).status).toBe(200);
  expect(owner).toBe(true);
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
    "203.0.113.10",
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
