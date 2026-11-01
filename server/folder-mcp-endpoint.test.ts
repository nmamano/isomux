// The isomux_files MCP server (task 25015e41): only the token of a Codex agent
// whose stop has the folder gets in, judged from the server's agent record on
// every request; the tools run on the record's folder and stop, never on
// anything the request or the token says.
import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FOLDER_FILES_MCP_PATH,
  handleFolderMcpRequest,
  type FolderFilesAgent,
  type FolderMcpDeps,
} from "./folder-mcp-endpoint.ts";
import type { FolderFilesRequest, FolderFilesResult } from "./folder-files.ts";
import type { Identity } from "./identity/index.ts";

const URL_ = `http://127.0.0.1:4000${FOLDER_FILES_MCP_PATH}`;
const AGENT_ID = "agent-files-1";

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

function agentIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    scope: "agent",
    userId: "user-1",
    agentId: AGENT_ID,
    agentAccess: "folder",
    ...overrides,
  } as Identity;
}

// Deps whose agent record the test changes between requests.
function deps(initial: FolderFilesAgent | null) {
  const state = { agent: initial };
  const runs: FolderFilesRequest[] = [];
  let answer: FolderFilesResult = { ok: true, text: "L1: hello" };
  const d: FolderMcpDeps = {
    agentNow: (id) => (id === AGENT_ID ? state.agent : null),
    run: async (req) => {
      runs.push(req);
      return answer;
    },
  };
  return {
    d,
    state,
    runs,
    answer: (a: FolderFilesResult) => {
      answer = a;
    },
  };
}

const CODEX_AT = (access: FolderFilesAgent["access"]): FolderFilesAgent => ({
  agentType: "codex",
  access,
  folder: "/srv/agent-folder",
  codexHome: "/srv/codex-home",
});

async function connect(identity: Identity | null, d: FolderMcpDeps) {
  const client = new Client({ name: "files-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) =>
        handleFolderMcpRequest(new Request(input, init), identity, d),
    }),
  );
  clients.push(client);
  return client;
}

async function status(identity: Identity | null, d: FolderMcpDeps) {
  const res = await handleFolderMcpRequest(
    new Request(URL_, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      }),
    }),
    identity,
    d,
  );
  await res.body?.cancel();
  return res.status;
}

describe("who gets in", () => {
  it("no identity is 401; anyone but a Codex agent at folder or web is 403", async () => {
    expect(await status(null, deps(CODEX_AT("folder")).d)).toBe(401);
    const cases: [string, Identity, FolderFilesAgent | null, number][] = [
      ["codex at folder", agentIdentity(), CODEX_AT("folder"), 200],
      ["codex at web", agentIdentity(), CODEX_AT("web"), 200],
      ["codex at office", agentIdentity(), CODEX_AT("office"), 403],
      ["codex at chat", agentIdentity(), CODEX_AT("chat"), 403],
      ["codex at standard", agentIdentity(), CODEX_AT("standard"), 403],
      ["codex privileged", agentIdentity(), CODEX_AT("privileged"), 403],
      [
        "claude at folder",
        agentIdentity(),
        { ...CODEX_AT("folder"), agentType: "claude" },
        403,
      ],
      [
        "opencode at folder",
        agentIdentity(),
        { ...CODEX_AT("folder"), agentType: "opencode" },
        403,
      ],
      ["no such agent", agentIdentity(), null, 403],
      [
        "an API token",
        { scope: "api", userId: "user-1", apiTokenId: "t1" } as Identity,
        CODEX_AT("folder"),
        403,
      ],
      [
        "a member session",
        { scope: "user", userId: "user-1" } as Identity,
        CODEX_AT("folder"),
        403,
      ],
    ];
    for (const [label, identity, agent, expected] of cases)
      expect({ label, status: await status(identity, deps(agent).d) }).toEqual({
        label,
        status: expected,
      });
  });

  // The token's own stop is what it was at issue; the record is now.
  it("the agent record decides, not the stop the token carries", async () => {
    expect(
      await status(
        agentIdentity({ agentAccess: "folder" }),
        deps(CODEX_AT("office")).d,
      ),
    ).toBe(403);
    expect(
      await status(
        agentIdentity({ agentAccess: "office" }),
        deps(CODEX_AT("folder")).d,
      ),
    ).toBe(200);
  });

  it("a move to office between two requests closes the next one", async () => {
    const t = deps(CODEX_AT("folder"));
    const client = await connect(agentIdentity(), t.d);
    await client.listTools();
    t.state.agent = CODEX_AT("office");
    const err = await client
      .callTool({ name: "read_file", arguments: { file_path: "a.txt" } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(t.runs).toEqual([]);
  });
});

describe("the tools", () => {
  it("lists read_file, list_dir and grep_files, each read-only", async () => {
    const client = await connect(agentIdentity(), deps(CODEX_AT("web")).d);
    const { tools } = await client.listTools();
    expect(
      tools
        .map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: "grep_files", readOnly: true },
      { name: "list_dir", readOnly: true },
      { name: "read_file", readOnly: true },
    ]);
  });

  it("a call runs on the record's folder and stop, with the model's arguments", async () => {
    const t = deps(CODEX_AT("folder"));
    const client = await connect(agentIdentity({ agentAccess: "web" }), t.d);
    const args = { file_path: "a.txt", offset: 2, limit: 3 };
    const result = (await client.callTool({
      name: "read_file",
      arguments: args,
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(result.isError ?? false).toBe(false);
    expect(result.content.map((c) => c.text).join("")).toContain("L1: hello");
    expect(t.runs).toEqual([
      {
        tool: "read_file",
        args,
        folder: "/srv/agent-folder",
        access: "folder",
        codexHome: "/srv/codex-home",
      },
    ]);
  });

  it("a refused call is a tool error the model reads, not an HTTP error", async () => {
    const t = deps(CODEX_AT("folder"));
    t.answer({ ok: false, error: "reaches only files inside your folder" });
    const client = await connect(agentIdentity(), t.d);
    const result = (await client.callTool({
      name: "grep_files",
      arguments: { pattern: "x", path: "/etc" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join("")).toContain(
      "inside your folder",
    );
  });

  it("an unknown tool runs nothing", async () => {
    const t = deps(CODEX_AT("folder"));
    const client = await connect(agentIdentity(), t.d);
    const outcome = await client
      .callTool({ name: "write_file", arguments: { file_path: "a.txt" } })
      .then(
        (r) => (r as { isError?: boolean }).isError === true,
        () => true,
      );
    expect(outcome).toBe(true);
    expect(t.runs).toEqual([]);
  });
});
