// Proxy trust over real HTTP (internal-docs/proxy-trust-design.md, F7 and F8).
//
// The harness fetches 127.0.0.1, so every request here has a loopback peer:
// exactly what a same-host proxy such as Caddy looks like. A forwarding header
// is what tells a proxied request apart from an on-box one.
//
// What is pinned:
//   - F7: an agent, cron-run or app token is refused when the request carries
//     X-Forwarded-For, Forwarded or X-Real-IP, with one log line that names
//     the holder and not the token. A personal API token is not affected, and
//     a valid cookie still passes alongside a refused token.
//   - F8: /readyz answers with no identity, before and after the claim,
//     exempts on-box callers only and, with trustedProxy "same-host", limits
//     each forwarded client on its own budget.
// The first-owner claim needs the setup key on loopback too: setup-key.test.ts.
// Zero LLM.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { getUserByName } from "../users.ts";
import { _resetReadyLimiterForTests } from "../ready-limiter.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const FORWARDING: [string, string][] = [
  ["X-Forwarded-For", "203.0.113.9"],
  ["Forwarded", "for=203.0.113.9"],
  ["X-Real-IP", "203.0.113.9"],
];
const FORWARDING_HEADER = { [FORWARDING[0][0]]: FORWARDING[0][1] };

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.warn = original) };
}

const tasks = (
  srv: TestServer,
  bearer: string,
  extra: Record<string, string> = {},
  rawSessionId?: string,
) =>
  srv.http("/api/tasks", {
    headers: { Authorization: `Bearer ${bearer}`, ...extra },
    ...(rawSessionId ? { rawSessionId } : {}),
  });

async function seedAppToken(srv: TestServer, agentToken: string) {
  const reg = await srv.http("/api/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "habits",
      command: "bun run serve.ts",
      cwd: srv.stateRoot,
    }),
  });
  expect(reg.status).toBe(201);
  const appToken = srv.appSupervisor.tokenFiles.get("habits");
  if (!appToken) throw new Error("no app token file");
  return appToken;
}

describe("F7: agent, cron-run and app tokens work only on-box", () => {
  it("refuses each machine token behind every forwarding header and logs once without the token; an API token and a cookie still pass", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const agent = await srv.agentManager.spawn(
      "AppBot",
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      srv.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      undefined,
      "codex",
    );
    if (!agent) throw new Error("spawn returned null");
    const agentToken = mintAgentToken(agent.id, ownerId);
    const runToken = mintRunToken("job-1", "run-1", ownerId);
    const appToken = await seedAppToken(srv, agentToken);

    for (const [scope, token] of [
      ["agent", agentToken],
      ["cron-run", runToken],
      ["app", appToken],
    ] as const) {
      // On-box, the token is an identity: whatever the route then decides,
      // it is not the 401 wall.
      const onBox = await tasks(srv, token);
      expect(onBox.status).not.toBe(401);
      for (const [name, value] of FORWARDING) {
        const warnings = captureWarnings();
        let res: Response;
        try {
          res = await tasks(srv, token, { [name]: value });
        } finally {
          warnings.restore();
        }
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe("unauthenticated");
        expect(warnings.lines).toHaveLength(1);
        expect(warnings.lines[0]).toContain(scope);
        expect(warnings.lines[0]).not.toContain(token);
      }
    }

    // A personal API token is a remote credential: a proxy does not refuse it.
    const { token: raw } = await mintApiToken({
      userId: ownerId,
      name: "Laptop",
      expiresInDays: 30,
    });
    expect((await tasks(srv, raw, FORWARDING_HEADER)).status).toBe(200);

    // A valid cookie passes beside a refused agent token.
    const warnings = captureWarnings();
    let res: Response;
    try {
      res = await tasks(srv, agentToken, FORWARDING_HEADER, owner.rawSessionId);
    } finally {
      warnings.restore();
    }
    expect(res.status).toBe(200);
  });
});

describe("F8: /readyz", () => {
  // The limiter is module state that outlives a harness boot.
  beforeEach(() => _resetReadyLimiterForTests());

  it("answers with no identity before and after the claim, and never limits an on-box caller", async () => {
    const srv = await startTestServer();
    server = srv;
    // Pre-claim: the probe is not behind the cookie wall or the claim gate.
    const pre = await srv.http("/readyz");
    expect(pre.status).toBe(200);
    expect(await pre.text()).toBe("ok\n");
    await srv.seedOwner("Morgan");
    for (let i = 0; i < 40; i++) {
      const res = await srv.http("/readyz");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok\n");
    }
  });

  it("limits each forwarded client on its own budget behind a same-host proxy", async () => {
    let srv = await startTestServer();
    server = srv;
    writeFileSync(
      join(srv.stateRoot, "office-config.json"),
      JSON.stringify({ trustedProxy: "same-host" }),
    );
    srv = await srv.restart();
    server = srv;
    const probe = (client: string) =>
      srv.http("/readyz", { headers: { "X-Forwarded-For": client } });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await probe("198.51.100.7")).status);
    expect(new Set(statuses.slice(0, -1))).toEqual(new Set([200]));
    expect(statuses.at(-1)).toBe(429);
    // Another client behind the same proxy still has its own budget.
    expect((await probe("198.51.100.8")).status).toBe(200);
    // And the box itself is still exempt.
    expect((await srv.http("/readyz")).status).toBe(200);
  });
});
