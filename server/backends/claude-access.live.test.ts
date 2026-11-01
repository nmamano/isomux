// The access slider (task e77304b1), live tier (ISOMUX_TEST_LIVE=1): what the
// real Claude Code process loads for a session below Standard. The unit tests
// prove the options Isomux passes; this proves what the CLI makes of them, from
// its own init message: the exact built-in tools, the office /mcp as the only
// MCP server, and no skill from disk.
//
// No model is called: the API base URL is a closed port, and the init message
// comes before the first request. The session runs in a temporary home with a
// planted user MCP server, a planted user skill and a planted project skill.
// The Standard control proves the plants load when nothing confines them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  createClaudeBackend,
  realV1SdkClient,
  type SdkClient,
  type SdkConversation,
} from "./claude.ts";
import {
  claudeToolsForStop,
  type AgentAccess,
} from "../../shared/agent-access.ts";

const LIVE = process.env.ISOMUX_TEST_LIVE === "1";
const CLOSED_PORT_URL = "http://127.0.0.1:9";

let root: string;
let home: string;
let configDir: string;

beforeAll(() => {
  if (!LIVE) return;
  root = mkdtempSync(join(tmpdir(), "claude-access-live-"));
  home = join(root, "home");
  configDir = join(home, ".claude");
  mkdirSync(join(configDir, "skills", "planted-user-skill"), {
    recursive: true,
  });
  writeFileSync(
    join(configDir, "skills", "planted-user-skill", "SKILL.md"),
    "---\nname: planted-user-skill\ndescription: planted\n---\nplanted\n",
  );
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "planted-user": { type: "http", url: `${CLOSED_PORT_URL}/planted` },
      },
    }),
  );
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// A folder with a planted project skill, as an agent's folder may hold one.
function agentFolder(): string {
  const cwd = mkdtempSync(join(root, "folder-"));
  mkdirSync(join(cwd, ".claude", "skills", "planted-project-skill"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, ".claude", "skills", "planted-project-skill", "SKILL.md"),
    "---\nname: planted-project-skill\ndescription: planted\n---\nplanted\n",
  );
  return cwd;
}

interface Init {
  tools: string[];
  mcpServers: string[];
  commands: string[];
}

// Starts a session at `access` through the real SDK client and returns the
// CLI's init message.
async function initAt(access: AgentAccess | undefined): Promise<Init> {
  let resolveInit!: (init: Init) => void;
  const seen = new Promise<Init>((resolve) => {
    resolveInit = resolve;
  });
  const tee = (conv: SdkConversation): SdkConversation =>
    new Proxy(conv, {
      get(target, prop, receiver) {
        if (prop !== "messages") return Reflect.get(target, prop, receiver);
        return async function* () {
          for await (const msg of target.messages()) {
            const m = msg as SDKMessage & {
              type: string;
              subtype?: string;
              tools?: string[];
              mcp_servers?: { name: string }[];
              slash_commands?: string[];
              skills?: string[];
            };
            if (m.type === "system" && m.subtype === "init")
              resolveInit({
                tools: m.tools ?? [],
                mcpServers: (m.mcp_servers ?? []).map((s) => s.name),
                commands: [...(m.slash_commands ?? []), ...(m.skills ?? [])],
              });
            yield msg;
          }
        };
      },
    });
  const client: SdkClient = {
    ...realV1SdkClient,
    createSession: (opts, mcp) => tee(realV1SdkClient.createSession(opts, mcp)),
    resumeSession: (id, opts, mcp) =>
      tee(realV1SdkClient.resumeSession(id, opts, mcp)),
  };
  const below = access !== undefined && access !== "standard";
  const session = createClaudeBackend(client).createSession({
    agentId: `access-live-${access ?? "standard"}`,
    cwd: agentFolder(),
    systemPrompt: "Reply OK.",
    modelFamily: "haiku",
    effort: "low",
    permissionMode: "bypassPermissions",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE-access-live",
      ANTHROPIC_BASE_URL: CLOSED_PORT_URL,
      DISABLE_TELEMETRY: "1",
    },
    ...(access ? { access } : {}),
    mcpServers:
      below && access !== "chat"
        ? [
            {
              name: "isomux",
              url: `${CLOSED_PORT_URL}/mcp`,
              headers: { Authorization: "Bearer access-live" },
            },
          ]
        : [],
  });
  const drain = (async () => {
    try {
      for await (const _ of session.stream()) void _;
    } catch {}
  })();
  try {
    await session.send("hi");
    return await Promise.race([
      seen,
      Bun.sleep(60_000).then(() => {
        throw new Error(`no init message at ${access}`);
      }),
    ]);
  } finally {
    session.close();
    await drain;
  }
}

const builtIns = (init: Init) =>
  init.tools.filter((tool) => !tool.startsWith("mcp__")).sort();

describe.skipIf(!LIVE)("Claude below Standard, live", () => {
  test("the Standard control loads the planted server and skills", async () => {
    const init = await initAt(undefined);
    expect(init.mcpServers).toContain("planted-user");
    expect(init.commands.join(" ")).toContain("planted-user-skill");
    expect(init.commands.join(" ")).toContain("planted-project-skill");
    expect(builtIns(init)).toContain("Bash");
  }, 90_000);

  for (const access of ["chat", "office", "folder", "web"] as const) {
    test(`at ${access}: the stop's built-in tools only, the office /mcp only, no skill from disk`, async () => {
      const init = await initAt(access);
      expect(builtIns(init)).toEqual([...claudeToolsForStop(access)!].sort());
      // Any MCP tool is the office's.
      expect(
        init.tools.filter(
          (tool) =>
            tool.startsWith("mcp__") && !tool.startsWith("mcp__isomux__"),
        ),
      ).toEqual([]);
      expect(init.mcpServers).toEqual(access === "chat" ? [] : ["isomux"]);
      const commands = init.commands.join(" ");
      expect(commands).not.toContain("planted-user-skill");
      expect(commands).not.toContain("planted-project-skill");
    }, 90_000);
  }
});
