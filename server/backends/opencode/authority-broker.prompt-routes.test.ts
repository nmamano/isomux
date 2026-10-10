// Keep every documented office route in step with the route table and broker.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { buildSystemPrompt } from "../../system-prompt.ts";
import {
  AGENT_REFERENCE_TOPICS,
  agentReferenceContent,
} from "../../agent-reference.ts";
import { PRIVILEGED_AGENT_CAPABILITIES } from "../../identity/index.ts";

import { API_ROUTES, PUBLIC_ROUTES, type RouteDef } from "../../routes/table.ts";
import { matchRoute } from "../../routes/match.ts";

// Independent expectation: changing the broker predicate must fail this test.
function agentStageOne(route: RouteDef): boolean {
  if (route.auth.kind === "authenticated") return true;
  if (route.auth.kind !== "capability") return false;
  const required = typeof route.auth.requiredCapability === "string"
    ? [route.auth.requiredCapability] : route.auth.requiredCapability;
  return required.some((cap) => PRIVILEGED_AGENT_CAPABILITIES.includes(cap));
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

type Occurrence = { route: string; where: string };

function documentedRoutes(): Occurrence[] {
  const prompt = buildSystemPrompt(
    "Agent",
    "agent-x",
    "Room",
    "room-1",
    null,
    null,
    null,
    "owner",
    null,
    true,
    null,
    "opencode",
  );
  expect(prompt).not.toMatch(/not available to OpenCode agents/i);
  const found: Occurrence[] = [];
  for (const command of prompt.split(/(?=\bcurl )/)) {
    if (!command.startsWith("curl ")) continue;
    const url = /http:\/\/isomux(\/[^\s"'?]*)/.exec(command);
    if (!url) continue;
    const method = /-X (\w+)/.exec(command)?.[1] ?? "GET";
    found.push({
      route: `${method} ${url[1]}`,
      where: "prompt",
    });
  }
  // The reference route serves the same bytes to every engine, so this is
  // the text an OpenCode agent reads.
  const privileged = {
    scope: "agent",
    agentId: "agent-x",
    userId: "u1",
    role: "owner",
    capabilities: PRIVILEGED_AGENT_CAPABILITIES,
  } as const;
  const span = /`(GET|HEAD|POST|PUT|PATCH|DELETE) (\/[^`\s?]*)`/g;
  for (const topic of Object.keys(AGENT_REFERENCE_TOPICS)) {
    const markdown = agentReferenceContent(privileged, topic);
    if (typeof markdown !== "string") throw new Error(`${topic} unreadable`);
    expect(markdown, topic).not.toMatch(/not available to OpenCode agents/i);
    // Exact `METHOD /path` spans. The route-table test pins every agent route
    // in that form, so shorthand spans with {a,b} or a|b add nothing here.
    for (const match of markdown.matchAll(span)) {
      if (/[{|]/.test(match[2])) continue;
      found.push({
        route: `${match[1]} ${match[2]}`,
        where: topic,
      });
    }
  }
  return found;
}

async function status(
  socketPath: string,
  handle: string,
  method: string,
  path: string,
) {
  return await new Promise<number>((resolve, reject) => {
    let text = "";
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(
            `${method} ${path} HTTP/1.1\r\nHost: isomux\r\nX-Isomux-Turn: ${handle}\r\n\r\n`,
          );
        },
        data(_socket, chunk) {
          text += chunk.toString();
        },
        close() {
          resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]));
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

describe("OpenCode broker allowlist", () => {
  it("admits documented and table routes exactly when agent stage one allows them", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-broker-prompt-routes-"));
    const socketPath = join(root, "private", "authority.sock");
    const upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const broker = new OpenCodeAuthorityBroker(
      socketPath,
      process.getuid?.() ?? -1,
      `http://127.0.0.1:${upstream.port}`,
    );
    cleanup.push(async () => {
      broker.close();
      await upstream.stop(true);
      rmSync(root, { recursive: true, force: true });
    });
    const binding = broker.bind("agent-x", "token-x");

    const occurrences = documentedRoutes();
    const routes = [...new Set(occurrences.map((o) => o.route))].sort();
    // Guards against a prompt, reference, or parser change that leaves
    // nothing to check.
    expect(routes).toContain("GET /api/agent-reference/<page>");
    expect(routes).toContain("GET /agents");
    expect(routes).toContain("DELETE /api/skills/file");
    expect(routes).toContain("POST /api/apps");
    expect(routes).toContain("GET /api/members-chat");
    expect(routes).toContain("GET /api/users/:username/member-prompt");
    expect(routes).toContain("PATCH /api/users/:username");
    expect(routes).toContain("GET /api/apps/:name");
    expect(routes).toContain("POST /api/apps/:name/start");
    expect(routes).toContain("POST /api/api-token-inboxes/:tokenId/messages");
    for (const route of [...API_ROUTES, ...PUBLIC_ROUTES]) {
      const handle = binding.activate(process.pid);
      expect(await status(socketPath, handle, route.method, route.path), route.opId)
        .toBe(agentStageOne(route) ? 200 : 403);
    }

    for (const occurrence of occurrences) {
      const [method, path] = occurrence.route.split(" ");
      const matched = matchRoute(API_ROUTES, method, path);
      const manifest = method === "GET" && path === "/agents";
      // A documented route cannot silently become an unknown-route exception.
      expect(manifest || matched !== null, occurrence.route).toBe(true);
      const handle = binding.activate(process.pid);
      const actual = await status(socketPath, handle, method, path);
      expect(actual, `${occurrence.where}: ${occurrence.route}`)
        .toBe(manifest || (matched && agentStageOne(matched.route)) ? 200 : 403);
    }
    // A specific user-only refusal also guards against replacing the predicate
    // with true, independently of the route-table loop above.
    expect(await status(socketPath, binding.activate(process.pid), "PUT",
      "/api/agents/agent-x/privileged")).toBe(403);
  });
});
