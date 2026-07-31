// C3-a (hosted isomux): human-facing runtime copy derives from the configured
// public origin, while agent-run curl recipes stay on localhost.
//
// Locks both conditional surfaces:
//   - buildSystemPrompt(): the "office UI for humans" line appears IFF a real
//     public origin is active for the boot, and the localhost curl recipes are
//     untouched either way.
//   - /help tips: VPN/tunnel copy on a localhost boot; "open <origin>" plus a
//     Funnel-free invite tip when an origin is active.
//
// "Active" means buildPublicOrigin() resolves env/config, which requires a
// claimed office AND externalAccess captured at boot - a loopback-only bind
// forces the localhost fallback. The config path is exercised through the real
// Access route + restart (not by poking module state) because that gate - a
// config-sourced origin counts, same as invites - is an explicit design
// choice these tests pin.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { buildSystemPrompt } from "../system-prompt.ts";
import type { AgentInfo } from "../../shared/types.ts";

const ORIGIN = "https://office.example";
const HUMAN_LINE = "The office UI for humans is at";
const CURL_RECIPE = "curl -s localhost:";
const VPN_TIP = "connect it to the same VPN";
const FUNNEL_TIP = "Tailscale Funnel";
const INVITE_TIP = "mint one-time invite URLs";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// Run /help (dispatches synchronously, no turn) and return the system entry
// holding the tips.
async function helpOutput(srv: TestServer, agentId: string): Promise<string> {
  await srv.agentManager.sendMessage(agentId, "/help", "Boss");
  const entry = srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => e.content)
    .find((c) => c.includes("**Tips:**"));
  if (!entry) throw new Error("no /help output found in agent log");
  return entry;
}

// Enable external access with a config origin (real Access route), then
// cold-restart so the boot capture picks it up. Returns the fresh server.
async function restartWithConfigOrigin(srv: TestServer): Promise<TestServer> {
  const owner = await srv.seedOwner("Boss");
  const r = await srv.http("/api/office/access", {
    method: "PUT",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalAccess: true, publicOrigin: ORIGIN }),
  });
  expect(r.status).toBe(200);
  return srv.restart();
}

describe("public-origin-derived copy (C3-a)", () => {
  it("localhost boot: no human-origin prompt line, /help keeps the VPN/Funnel tips", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");

    const prompt = buildSystemPrompt("A1", "agent-1", "Test Room");
    expect(prompt).not.toContain(HUMAN_LINE);
    expect(prompt).toContain(CURL_RECIPE);

    const agent = await spawnAgent(
      srv,
      "Worker",
      srv.agentManager.getRooms()[0].id,
    );
    const help = await helpOutput(srv, agent.id);
    expect(help).toContain(VPN_TIP);
    expect(help).toContain(FUNNEL_TIP);
    expect(help).toContain(INVITE_TIP);
    expect(help).not.toContain(ORIGIN);
  });

  it("config-origin boot: prompt gains the human-origin line, curl recipes stay localhost, /help shows the URL", async () => {
    const srv0 = await startTestServer();
    server = srv0;
    const srv = await restartWithConfigOrigin(srv0);
    server = srv;

    const prompt = buildSystemPrompt("A1", "agent-1", "Test Room");
    expect(prompt).toContain(`${HUMAN_LINE} ${ORIGIN}`);
    // Agent-run API recipes are untouched - and the origin appears in that
    // one line only, never substituted into a recipe.
    expect(prompt).toContain(CURL_RECIPE);
    expect(prompt.split(ORIGIN).length - 1).toBe(1);

    const agent = await spawnAgent(
      srv,
      "Worker",
      srv.agentManager.getRooms()[0].id,
    );
    const help = await helpOutput(srv, agent.id);
    expect(help).toContain(`Isomux works on your phone: open ${ORIGIN}.`);
    expect(help).toContain(INVITE_TIP);
    expect(help).not.toContain(VPN_TIP);
    expect(help).not.toContain(FUNNEL_TIP);
  });

  it("env origin wins over config at boot and lands in the prompt line", async () => {
    const ENV_ORIGIN = "https://env.example";
    const prevEnv = process.env.ISOMUX_PUBLIC_ORIGIN;
    try {
      const srv0 = await startTestServer();
      server = srv0;
      // Set the env AFTER the Access PUT - the route 409s on a conflicting
      // env origin - but BEFORE the restart that re-evaluates it.
      const owner = await srv0.seedOwner("Boss");
      const r = await srv0.http("/api/office/access", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalAccess: true, publicOrigin: ORIGIN }),
      });
      expect(r.status).toBe(200);
      process.env.ISOMUX_PUBLIC_ORIGIN = ENV_ORIGIN;
      const srv = await srv0.restart();
      server = srv;

      const prompt = buildSystemPrompt("A1", "agent-1", "Test Room");
      expect(prompt).toContain(`${HUMAN_LINE} ${ENV_ORIGIN}`);
      expect(prompt).not.toContain(ORIGIN);
    } finally {
      if (prevEnv === undefined) delete process.env.ISOMUX_PUBLIC_ORIGIN;
      else process.env.ISOMUX_PUBLIC_ORIGIN = prevEnv;
    }
  });
});
