// Every office route an OpenCode agent is taught must pass the OpenCode
// authority broker, and every route the broker refuses must be marked as
// unavailable to OpenCode agents at each place a reference names it. The
// routes come from what the agent actually reads: the fetch command in its
// system prompt (privileged, so the privileged pages are in) and every topic
// as the reference route serves it, not from a hand-copied list.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { buildSystemPrompt } from "../../system-prompt.ts";
import {
  AGENT_REFERENCE_TOPICS,
  OPENCODE_UNAVAILABLE_MARK,
  agentReferenceContent,
} from "../../agent-reference.ts";
import { PRIVILEGED_AGENT_CAPABILITIES } from "../../identity/index.ts";

// "METHOD /path" -> one-line reason the broker refuses it although no
// OpenCode agent is meant to call it, so it carries no unavailability mark.
const EXCLUDED: Record<string, string> = {
  "POST /api/app/message":
    "App-server route: the app's own token never goes through the agent proxy.",
  "POST /api/app/pager":
    "App-server route: the app's own token never goes through the agent proxy.",
  "POST /api/app/pager/resolve":
    "App-server route: the app's own token never goes through the agent proxy.",
};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

type Occurrence = { route: string; marked: boolean; where: string };

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
  const found: Occurrence[] = [];
  for (const command of prompt.split(/(?=\bcurl )/)) {
    if (!command.startsWith("curl ")) continue;
    const url = /http:\/\/isomux(\/[^\s"'?]*)/.exec(command);
    if (!url) continue;
    const method = /-X (\w+)/.exec(command)?.[1] ?? "GET";
    found.push({
      route: `${method} ${url[1]}`,
      marked: false,
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
  const mark = OPENCODE_UNAVAILABLE_MARK.replace(/[()]/g, "\\$&");
  const span = new RegExp(
    `\`(GET|POST|PUT|PATCH|DELETE) (\\/[^\`\\s?]*)\`( ${mark})?`,
    "g",
  );
  for (const topic of Object.keys(AGENT_REFERENCE_TOPICS)) {
    const markdown = agentReferenceContent(privileged, topic);
    if (typeof markdown !== "string") throw new Error(`${topic} unreadable`);
    // Exact `METHOD /path` spans. The route-table test pins every agent route
    // in that form, so shorthand spans with {a,b} or a|b add nothing here.
    for (const match of markdown.matchAll(span)) {
      if (/[{|]/.test(match[2])) continue;
      found.push({
        route: `${match[1]} ${match[2]}`,
        marked: match[3] !== undefined,
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
  it("passes every route OpenCode agents are taught and marks every refused one where it appears", async () => {
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
    expect(routes).toContain("GET /api/apps/:name");
    expect(routes).toContain("POST /api/apps/:name/start");
    expect(routes).toContain("POST /api/api-token-inboxes/:tokenId/messages");
    expect(occurrences.some((o) => o.marked)).toBe(true);
    expect(Object.keys(EXCLUDED).filter((r) => !routes.includes(r))).toEqual(
      [],
    );

    const refused = new Set<string>();
    for (const route of routes) {
      const [method, path] = route.split(" ");
      // A fresh activation resets the per-turn call limit.
      const handle = binding.activate(process.pid);
      // The upstream answers 200 to everything, so a 403 is the broker's.
      const actual = await status(socketPath, handle, method, path);
      if (actual === 403) refused.add(route);
      else expect(actual, route).toBe(200);
    }
    const mismatches = occurrences
      .filter((o) =>
        o.route in EXCLUDED
          ? !refused.has(o.route) || o.marked
          : refused.has(o.route) !== o.marked,
      )
      .map(
        (o) =>
          `${o.where}: ${o.route} ${refused.has(o.route) ? "refused" : "allowed"}, ${o.marked ? "marked" : "unmarked"}`,
      );
    expect(mismatches).toEqual([]);
  });
});
