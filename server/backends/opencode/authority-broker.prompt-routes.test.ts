// Every office route the agent system prompt documents must pass the OpenCode
// authority broker, or sit in EXCLUDED with the reason it is refused. The
// routes come from the prompt an OpenCode agent actually reads (privileged,
// so the operator section is in, plus the app section that a non-Linux host
// leaves out), not from a hand-copied list.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import {
  appHostingSection,
  buildSystemPrompt,
  rewriteOpenCodeOfficeCommands,
} from "../../system-prompt.ts";

// "METHOD /path" as the prompt spells it -> one-line reason the broker refuses it.
const EXCLUDED: Record<string, string> = {};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function documentedRoutes(): string[] {
  const prompt = [
    buildSystemPrompt(
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
    ),
    rewriteOpenCodeOfficeCommands(appHostingSection(null)),
  ].join("\n");
  const routes = new Set<string>();
  for (const line of prompt.split("\n")) {
    for (const match of line.matchAll(
      /\b(GET|POST|PUT|PATCH|DELETE) http:\/\/isomux(\/[^\s"'?,)]*)/g,
    ))
      routes.add(`${match[1]} ${match[2]}`);
    for (const command of line.split(/(?=\bcurl )/)) {
      if (!command.startsWith("curl ")) continue;
      const url = /http:\/\/isomux(\/[^\s"'?]*)/.exec(command);
      if (!url) continue;
      const method = /-X (\w+)/.exec(command)?.[1] ?? "GET";
      routes.add(`${method} ${url[1]}`);
      // Shorthand in the trailing comment: "add /<name> for one" extends the
      // path; "also /start and /stop" replaces its last segment.
      const comment = command.split(/\s#\s/)[1] ?? "";
      const added = /\badd (\/[^\s/]+)/.exec(comment);
      if (added) routes.add(`${method} ${url[1]}${added[1]}`);
      const also = /\balso (\/[^\s/,]+(?:(?:,| and| or)+ \/[^\s/,]+)*)/.exec(
        comment,
      );
      for (const sibling of also?.[1].match(/\/[^\s/,]+/g) ?? [])
        routes.add(`${method} ${url[1].replace(/\/[^/]+$/, sibling)}`);
    }
  }
  return [...routes].sort();
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
  it("passes every office route the agent prompt documents, except EXCLUDED", async () => {
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

    const routes = documentedRoutes();
    // Guards against a prompt or parser change that leaves nothing to check.
    expect(routes).toContain("GET /agents");
    expect(routes).toContain("POST /api/apps");
    expect(routes).toContain("GET /api/members-chat");
    expect(routes).toContain("GET /api/apps/<name>");
    expect(routes).toContain("POST /api/apps/<name>/start");
    expect(Object.keys(EXCLUDED).filter((r) => !routes.includes(r))).toEqual(
      [],
    );

    const mismatches: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(" ");
      // A fresh activation resets the per-turn call limit.
      const handle = binding.activate(process.pid);
      // The upstream answers 200 to everything, so a 403 is the broker's.
      const expected = route in EXCLUDED ? 403 : 200;
      const actual = await status(socketPath, handle, method, path);
      if (actual !== expected) mismatches.push(`${route} -> ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });
});
