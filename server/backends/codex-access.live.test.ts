// Codex at chat and office (task e77304b1), live tier (ISOMUX_TEST_LIVE=1):
// what the real Codex app-server offers the model for a session below
// Standard. The unit tests (codex/adapter.test.ts) prove what Isomux sends;
// this proves what Codex makes of it, from the Responses requests it sends.
//
// No model is called: Codex talks to a fake Responses endpoint in this
// process, set as the member's model provider. The member's Codex home turns
// every tool source on and plants an MCP server, a skill and a project doc;
// the Standard control proves those plants load when nothing confines them.
// The exact tools at chat are request_user_input and apply_patch (the
// residuals in the design, §6.2a); office adds Codex's MCP tools for the
// office server. Folder and web (task 25015e41) add Isomux's isomux_files
// server, served here by the real endpoint and file tools, and a
// workspace-write sandbox on the agent's folder; web adds web search.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { CodexSession } from "./codex/adapter.ts";
import { CODEX_EMPTY_CWD_ROOT } from "./codex/access.ts";
import {
  FOLDER_FILES_MCP_PATH,
  FOLDER_FILES_MCP_SERVER,
  handleFolderMcpRequest,
} from "../folder-mcp-endpoint.ts";
import { runFolderFiles } from "../folder-files-host.ts";
import type { Identity } from "../identity/index.ts";
import { prepareCodexSafetyHookArtifact } from "./codex/safety-hook-install.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { NormalizedEvent } from "./types.ts";

const LIVE = process.env.ISOMUX_TEST_LIVE === "1";
const MODEL = "gpt-5.5";

let root: string;
let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;
// Markers: each one shows up in a request, or on disk, only when the plant
// it belongs to reached Codex.
const SKILL = "planted-skill-c1";
const PROJECT_DOC = "PLANTED-PROJECT-DOC-C1";
let stdioMarker: string;
let shellMarker: string;
let plantedRemoteHits = 0;
let officeToolLists = 0;
// The agent the isomux_files endpoint serves: its record "now".
const FILES_TOKEN = "fake-files-token-c2";
let filesAgent: { id: string; access: AgentAccess; folder: string } | null =
  null;

// The fake Responses endpoint: each turn's requests, and a script that
// answers request i of the current run.
type Answer = Record<string, unknown>[] | "done";
let requests: Record<string, unknown>[] = [];
let script: Answer[] = [];

function sse(events: Record<string, unknown>[]): Response {
  return new Response(
    events
      .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function answer(i: number, items: Record<string, unknown>[]): Response {
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const id = `r${i}`;
  return sse([
    {
      type: "response.created",
      response: { id, object: "response", status: "in_progress", output: [] },
    },
    ...items.flatMap((item, k) => [
      { type: "response.output_item.added", output_index: k, item },
      { type: "response.output_item.done", output_index: k, item },
    ]),
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: items,
        usage,
      },
    },
  ]);
}

const DONE = (i: number) => ({
  type: "message",
  id: `m${i}`,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "done", annotations: [] }],
});

// The office MCP server at office: one tool.
async function officeMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const body = await req.clone().text();
  if (body.includes('"tools/list"')) officeToolLists++;
  const mcp = new McpServer({ name: "isomux", version: "1.0.0" });
  mcp.registerTool("ping_office", { description: "ping" }, () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await mcp.close().catch(() => {});
  }
}

beforeAll(async () => {
  if (!LIVE) return;
  // As the office server: the session installs the safety hook from it.
  await prepareCodexSafetyHookArtifact();
  root = mkdtempSync(join(tmpdir(), "codex-access-live-"));
  home = join(root, "codex-home");
  stdioMarker = join(root, "planted-stdio-started");
  writeFileSync(join(root, "outside-target.txt"), "original\n");
  shellMarker = join(root, "shell-ran");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/mcp") return officeMcp(req);
      if (path === FOLDER_FILES_MCP_PATH) {
        const agent = filesAgent;
        const identity: Identity | null =
          agent && req.headers.get("authorization") === `Bearer ${FILES_TOKEN}`
            ? ({
                scope: "agent",
                userId: "user-c2",
                agentId: agent.id,
                agentAccess: agent.access,
              } as Identity)
            : null;
        return handleFolderMcpRequest(req, identity, {
          agentNow: (id) =>
            agent && id === agent.id
              ? {
                  agentType: "codex",
                  access: agent.access,
                  folder: agent.folder,
                  codexHome: home,
                }
              : null,
          run: (r) => runFolderFiles(r),
        });
      }
      if (path === "/planted-mcp") {
        plantedRemoteHits++;
        return new Response(null, { status: 404 });
      }
      const i = requests.length;
      requests.push(JSON.parse(await req.text()) as Record<string, unknown>);
      const next = script[i] ?? "done";
      return answer(i, next === "done" ? [DONE(i)] : next);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  mkdirSync(join(home, "skills", SKILL), { recursive: true });
  writeFileSync(
    join(home, "skills", SKILL, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: planted\n---\nplanted\n`,
  );
  // A member config.toml that turns on every source the stop turns off.
  const features = [
    "shell_tool",
    "unified_exec",
    "view_image",
    "goals",
    "multi_agent",
    "multi_agent_v2",
    "sleep_tool",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "tool_suggest",
    "skill_search",
    "skill_mcp_dependency_install",
    "memories",
    "request_permissions_tool",
    "standalone_web_search",
  ];
  writeFileSync(
    join(home, "config.toml"),
    [
      'model_provider = "fake"',
      'web_search = "live"',
      "project_doc_max_bytes = 65536",
      "[model_providers.fake]",
      'name = "fake"',
      `base_url = "${base}/v1"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "[skills]",
      "include_instructions = true",
      "[memories]",
      "use_memories = true",
      "generate_memories = true",
      "[sandbox_workspace_write]",
      "network_access = true",
      "[features]",
      ...features.map((key) => `${key} = true`),
      "[mcp_servers.planted-stdio]",
      'command = "/bin/sh"',
      `args = ["-c", "touch '${stdioMarker}'; sleep 30"]`,
      "startup_timeout_sec = 2",
      "[mcp_servers.planted-remote]",
      `url = "${base}/planted-mcp"`,
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

// The agent's own folder, with a project doc: below Standard the thread
// never runs there.
function agentFolder(): string {
  const cwd = mkdtempSync(join(root, "agent-folder-"));
  writeFileSync(join(cwd, "AGENTS.md"), `${PROJECT_DOC}\n`);
  return cwd;
}

// Every tool a request offers: the top-level list and the additional_tools
// input items, namespaces flattened. A tool with no name is its type.
function toolsOf(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  const walk = (tools: unknown, ns: string) => {
    for (const tool of (tools as Record<string, unknown>[]) ?? []) {
      const name =
        (tool.name as string | undefined) ?? `<${String(tool.type)}>`;
      if (tool.type === "namespace") {
        walk(tool.tools, name.endsWith("__") ? name : `${name}__`);
      } else {
        names.push(`${ns}${name}`);
      }
    }
  };
  walk(body.tools, "");
  for (const item of (body.input as Record<string, unknown>[]) ?? [])
    if (item.type === "additional_tools") walk(item.tools, "");
  return names.sort();
}

let seq = 0;
// One session, one turn of "hello". Returns every request the turn sent and
// how it ended. `agentCwd` and `resumeThreadId` continue an earlier run's
// thread in its folder.
async function runTurn(
  access: AgentAccess | undefined,
  answers: Answer[],
  more: { agentCwd?: string; resumeThreadId?: string } = {},
): Promise<{
  requests: Record<string, unknown>[];
  ends: string[];
  cwd: string;
  agentCwd: string;
  threadId: string;
}> {
  requests = [];
  script = answers;
  officeToolLists = 0;
  const agentId = `codex-access-live-${process.pid}-${seq++}`;
  const agentCwd = more.agentCwd ?? agentFolder();
  const withFiles = access === "folder" || access === "web";
  filesAgent = access ? { id: agentId, access, folder: agentCwd } : null;
  const session = new CodexSession({
    agentId,
    cwd: agentCwd,
    systemPrompt: "",
    modelFamily: MODEL,
    effort: "",
    permissionMode: "on-request",
    // The widest stored sandbox: below Standard it never reaches the thread.
    sandbox: access ? "danger-full-access" : "read-only",
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "sk-fake-c1" },
    ...(access ? { access } : {}),
    ...(more.resumeThreadId ? { resumeThreadId: more.resumeThreadId } : {}),
    ...(access === "office" || withFiles
      ? {
          mcpServers: [
            {
              name: "isomux",
              url: `http://127.0.0.1:${server!.port}/mcp`,
              headers: { Authorization: "Bearer fake-office-token-c1" },
            },
            ...(withFiles
              ? [
                  {
                    name: FOLDER_FILES_MCP_SERVER,
                    url: `http://127.0.0.1:${server!.port}${FOLDER_FILES_MCP_PATH}`,
                    headers: { Authorization: `Bearer ${FILES_TOKEN}` },
                  },
                ]
              : []),
          ],
          officeTools: ["ping_office"],
        }
      : {}),
  });
  const it = session.stream();
  const ends: string[] = [];
  let threadId = "";
  try {
    await session.send("hello");
    const deadline = Date.now() + 45_000;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no turn_completed in time");
      const next = await Promise.race([
        it.next(),
        Bun.sleep(left).then(() => null),
      ]);
      if (!next || next.done) throw new Error("stream ended before the turn");
      const ev: NormalizedEvent = next.value;
      if (ev.kind === "system_init") threadId = ev.sessionId ?? "";
      if (ev.kind === "turn_completed") {
        ends.push(
          ev.status === "completed"
            ? "completed"
            : `${ev.status}: ${JSON.stringify(ev.error ?? null)}`,
        );
        break;
      }
    }
  } finally {
    session.close();
  }
  return {
    requests: [...requests],
    ends,
    cwd: withFiles ? agentCwd : join(CODEX_EMPTY_CWD_ROOT, agentId),
    agentCwd,
    threadId,
  };
}

describe.skipIf(!LIVE)(`Codex ${MODEL} below Standard (live)`, () => {
  // Codex adds its MCP plumbing as soon as one server is on: a tool search
  // that defers the office tools behind it, and the resource tools. They
  // reach only enabled servers (the next test).
  const MCP_PLUMBING = [
    "<tool_search>",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "read_mcp_resource",
  ];
  for (const access of ["chat", "office"] as const) {
    test(`${access}: every request offers only request_user_input and apply_patch${access === "office" ? ", and the MCP tools of the office server" : ""}`, async () => {
      rmSync(stdioMarker, { force: true });
      plantedRemoteHits = 0;
      // Codex connects the office server before the first request.
      const run = await runTurn(access, ["done"]);
      expect(run.ends).toEqual(run.ends.map(() => "completed"));
      // Every request, so a side request on another model or with other
      // tools is caught too.
      expect(run.requests.map((r) => r.model)).toEqual(
        run.requests.map(() => MODEL),
      );
      const allowed = [
        "apply_patch",
        "request_user_input",
        ...(access === "office" ? MCP_PLUMBING : []),
      ].sort();
      for (const request of run.requests)
        expect(
          toolsOf(request).filter((t) => !t.startsWith("mcp__isomux__")),
        ).toEqual(allowed);
      if (access === "office") expect(officeToolLists).toBeGreaterThan(0);
      // No plant reached the thread or ran.
      const text = JSON.stringify(run.requests);
      expect(text).not.toContain(SKILL);
      expect(text).not.toContain(PROJECT_DOC);
      expect(text).not.toContain(run.agentCwd);
      expect(text).toContain(run.cwd);
      expect(existsSync(stdioMarker)).toBe(false);
      expect(plantedRemoteHits).toBe(0);
      // Codex wrote nothing in the folder, so the next start finds it
      // empty.
      expect(readdirSync(run.cwd)).toEqual([]);
    }, 60_000);
  }

  // The resource tools at office take a server name: a planted server is
  // off, so nothing starts and nothing is fetched.
  test("office: the MCP resource tools reach no planted server", async () => {
    rmSync(stdioMarker, { force: true });
    plantedRemoteHits = 0;
    const calls: [string, Record<string, unknown>][] = [
      [
        "read_mcp_resource",
        { server: "planted-remote", uri: "file:///etc/hostname" },
      ],
      [
        "read_mcp_resource",
        { server: "planted-stdio", uri: "file:///etc/hostname" },
      ],
      ["list_mcp_resources", { server: "planted-remote" }],
      ["list_mcp_resource_templates", { server: "planted-stdio" }],
    ];
    const items = calls.map(([name, args], k) => ({
      type: "function_call",
      id: `fc_r${k}`,
      call_id: `call_r${k}`,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    }));
    const run = await runTurn("office", [items, "done"]);
    expect(run.ends).toEqual(["completed"]);
    expect(run.requests.length).toBeGreaterThanOrEqual(2);
    const outputs = ((run.requests[1].input as Record<string, unknown>[]) ?? [])
      .filter((i) => i.type === "function_call_output")
      .map((i) => i.call_id)
      .sort();
    expect(outputs).toEqual(items.map((i) => i.call_id).sort());
    expect(plantedRemoteHits).toBe(0);
    expect(existsSync(stdioMarker)).toBe(false);
  }, 60_000);

  // An office tool that is not marked read-only runs: under approval never
  // Codex would refuse it, and the pack already limits what it does.
  test("office: an office tool that writes runs", async () => {
    const run = await runTurn("office", [
      [
        {
          type: "function_call",
          id: "fc_o0",
          call_id: "call_o0",
          namespace: "mcp__isomux",
          name: "ping_office",
          arguments: "{}",
          status: "completed",
        },
      ],
      "done",
    ]);
    expect(run.ends).toEqual(["completed"]);
    const out = ((run.requests[1]?.input as Record<string, unknown>[]) ?? [])
      .filter((i) => i.type === "function_call_output")
      .map((i) => JSON.stringify(i.output));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("pong");
  }, 60_000);

  // The model may name a tool it was not given: Codex answers each call as
  // unsupported and runs nothing.
  test("a call to a tool not offered runs nothing", async () => {
    rmSync(shellMarker, { force: true });
    const calls: [string, Record<string, unknown>][] = [
      ["exec_command", { cmd: `touch '${shellMarker}'` }],
      ["shell", { command: ["touch", shellMarker] }],
      ["shell_command", { command: `touch '${shellMarker}'` }],
      ["spawn_agent", { message: "hi" }],
      ["view_image", { path: "/etc/hostname" }],
      ["list_mcp_resources", {}],
      ["tool_search", { query: "agent" }],
      ["create_goal", { objective: "x" }],
      ["web_search", { query: "x" }],
      ["mcp__planted-stdio__anything", {}],
    ];
    const items = calls.map(([name, args], k) => ({
      type: "function_call",
      id: `fc_${k}`,
      call_id: `call_${k}`,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    }));
    const run = await runTurn("chat", [items, "done"]);
    expect(run.ends).toEqual(["completed"]);
    expect(run.requests.length).toBeGreaterThanOrEqual(2);
    const outputs = ((run.requests[1].input as Record<string, unknown>[]) ?? [])
      .filter((i) => i.type === "function_call_output")
      .map((i) => i.call_id)
      .sort();
    // Codex answered every call, so it saw them all.
    expect(outputs).toEqual(items.map((i) => i.call_id).sort());
    expect(existsSync(shellMarker)).toBe(false);
    expect(existsSync(stdioMarker)).toBe(false);
  }, 60_000);

  // apply_patch stays offered (§6.2a); the read-only sandbox refuses every
  // write, in the thread's folder and outside it.
  test("a streamed apply_patch writes nothing, inside the folder or outside", async () => {
    const patch = (k: number, body: string) => ({
      type: "custom_tool_call",
      id: `ctc_${k}`,
      call_id: `call_p${k}`,
      name: "apply_patch",
      input: `*** Begin Patch\n${body}\n*** End Patch`,
      status: "completed",
    });
    // The thread's folder is known only once the run starts; Codex reads
    // relative paths against it.
    const run = await runTurn("office", [
      [
        patch(0, "*** Add File: inside.txt\n+written inside"),
        patch(
          1,
          `*** Update File: ${join(root, "outside-target.txt")}\n@@\n-original\n+written outside`,
        ),
      ],
      "done",
    ]);
    expect(run.ends).toEqual(["completed"]);
    const outside = readFileSync(join(root, "outside-target.txt"), "utf8");
    expect(run.requests.length).toBeGreaterThanOrEqual(2);
    const outputs = ((run.requests[1].input as Record<string, unknown>[]) ?? [])
      .filter((i) => i.type === "custom_tool_call_output")
      .map((i) => i.call_id)
      .sort();
    expect(outputs).toEqual(["call_p0", "call_p1"]);
    expect(existsSync(join(run.cwd, "inside.txt"))).toBe(false);
    expect(existsSync(join(run.agentCwd, "inside.txt"))).toBe(false);
    expect(outside).toBe("original\n");
  }, 60_000);

  // The control: the same home with nothing confining it loads the plants.
  test("Standard loads the planted skill, project doc and shell", async () => {
    rmSync(stdioMarker, { force: true });
    const run = await runTurn(undefined, ["done"]);
    // Codex may send a side request first: look at every request.
    const tools = [...new Set(run.requests.flatMap(toolsOf))];
    expect(tools.length).toBeGreaterThan(2);
    const text = JSON.stringify(run.requests);
    expect(text).toContain(SKILL);
    expect(text).toContain(PROJECT_DOC);
    expect(text).toContain(run.agentCwd);
    expect(existsSync(stdioMarker)).toBe(true);
  }, 60_000);
});

// The isomux_files tools as a request lists them: the tool name after the
// server's namespace.
function filesTools(body: Record<string, unknown>): string[] {
  return toolsOf(body)
    .filter((t) => t.includes(FOLDER_FILES_MCP_SERVER))
    .map((t) => t.split("__").at(-1)!)
    .sort();
}

// The sandbox of the thread's last turn, from the rollout Codex keeps in the
// member's home.
function lastTurnSandbox(): Record<string, unknown> | null {
  const rollouts: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith("rollout-"))
        rollouts.push({ path, mtime: Bun.file(path).lastModified });
    }
  };
  walk(join(home, "sessions"));
  const newest = rollouts.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return null;
  let policy: Record<string, unknown> | null = null;
  for (const line of readFileSync(newest.path, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      payload?: { sandbox_policy?: Record<string, unknown> };
    };
    if (entry.type === "turn_context" && entry.payload?.sandbox_policy)
      policy = entry.payload.sandbox_policy;
  }
  return policy;
}

// A call to an MCP tool as gpt-5.5 makes it in Codex 0.164: the tool's own
// name, in the server's namespace.
const call = (
  k: number,
  server: string,
  name: string,
  args: Record<string, unknown>,
) => ({
  type: "function_call",
  id: `fc_f${k}`,
  call_id: `call_f${k}`,
  namespace: `mcp__${server}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

const patchCall = (k: number, body: string) => ({
  type: "custom_tool_call",
  id: `ctc_f${k}`,
  call_id: `call_fp${k}`,
  name: "apply_patch",
  input: `*** Begin Patch\n${body}\n*** End Patch`,
  status: "completed",
});

// The output Codex sent back for each call id, in the request after the
// calls.
function outputs(run: { requests: Record<string, unknown>[] }) {
  return Object.fromEntries(
    ((run.requests[1]?.input as Record<string, unknown>[]) ?? [])
      .filter(
        (i) =>
          i.type === "function_call_output" ||
          i.type === "custom_tool_call_output",
      )
      .map((i) => [i.call_id as string, JSON.stringify(i.output)]),
  );
}

describe.skipIf(!LIVE)(`Codex ${MODEL} at folder and web (live)`, () => {
  // Codex's MCP plumbing, which a tool search may sit beside.
  const PLUMBING = [
    "<tool_search>",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "read_mcp_resource",
  ];
  for (const access of ["folder", "web"] as const) {
    test(`${access}: every request offers the file tools directly, apply_patch and no shell${access === "web" ? ", and web search" : ""}`, async () => {
      rmSync(stdioMarker, { force: true });
      plantedRemoteHits = 0;
      const run = await runTurn(access, ["done"]);
      expect(run.ends).toEqual(run.ends.map(() => "completed"));
      expect(run.requests.map((r) => r.model)).toEqual(
        run.requests.map(() => MODEL),
      );
      const allowed = new Set([
        "apply_patch",
        "request_user_input",
        ...PLUMBING,
        ...(access === "web" ? ["<web_search>"] : []),
      ]);
      for (const request of run.requests) {
        const tools = toolsOf(request);
        expect(
          tools.filter(
            (t) =>
              !allowed.has(t) &&
              !t.startsWith("mcp__isomux__") &&
              !t.includes(FOLDER_FILES_MCP_SERVER),
          ),
        ).toEqual([]);
        // Listed, not behind a search: the model knows it can read.
        expect(filesTools(request)).toEqual([
          "grep_files",
          "list_dir",
          "read_file",
        ]);
        expect(tools).toContain("apply_patch");
        expect(tools.includes("<web_search>")).toBe(access === "web");
      }
      const text = JSON.stringify(run.requests);
      expect(text).not.toContain(SKILL);
      expect(text).not.toContain(PROJECT_DOC);
      expect(text).toContain(run.agentCwd);
      expect(existsSync(stdioMarker)).toBe(false);
      expect(plantedRemoteHits).toBe(0);
      // The sandbox Codex ran the turn in.
      expect(lastTurnSandbox()).toMatchObject({
        type: "workspace-write",
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      });
      expect(
        (lastTurnSandbox()?.writable_roots as unknown[] | undefined) ?? [],
      ).toEqual([]);
    }, 60_000);
  }

  test("folder: the file tools read the folder and nothing outside it, and the office tool answers", async () => {
    const agentCwd = agentFolder();
    writeFileSync(join(agentCwd, "notes.txt"), "inside-notes-c2\n");
    const F = FOLDER_FILES_MCP_SERVER;
    const run = await runTurn(
      "folder",
      [
        [
          call(0, F, "read_file", { file_path: "notes.txt" }),
          call(1, F, "read_file", {
            file_path: join(root, "outside-target.txt"),
          }),
          call(2, F, "list_dir", { dir_path: "." }),
          call(3, F, "grep_files", { pattern: "inside-notes" }),
          call(4, "isomux", "ping_office", {}),
        ],
        "done",
      ],
      { agentCwd },
    );
    expect(run.ends).toEqual(["completed"]);
    const out = outputs(run);
    expect(Object.keys(out).sort()).toEqual(
      ["call_f0", "call_f1", "call_f2", "call_f3", "call_f4"].sort(),
    );
    expect(out.call_f0).toContain("inside-notes-c2");
    expect(out.call_f1).not.toContain("original");
    expect(out.call_f2).toContain("notes.txt");
    expect(out.call_f3).toContain("notes.txt");
    expect(out.call_f4).toContain("pong");
  }, 60_000);

  // The thread may write in the folder, never outside it, never on the
  // engine or repository config (the hook, from the confinement the session
  // puts in the app-server's environment), never in a temp folder.
  test("folder: apply_patch writes inside the folder only", async () => {
    const agentCwd = agentFolder();
    const tmpTarget = join(tmpdir(), `c2-${process.pid}-escape.txt`);
    const run = await runTurn(
      "folder",
      [
        [
          patchCall(0, "*** Add File: inside.txt\n+written inside"),
          patchCall(
            1,
            `*** Update File: ${join(root, "outside-target.txt")}\n@@\n-original\n+written outside`,
          ),
          patchCall(
            2,
            `*** Update File: AGENTS.md\n@@\n-${PROJECT_DOC}\n+rewritten`,
          ),
          patchCall(3, `*** Add File: ${tmpTarget}\n+x`),
          patchCall(4, "*** Add File: ../escape-c2.txt\n+x"),
          patchCall(5, "*** Add File: .codex/config.toml\n+x"),
        ],
        "done",
      ],
      { agentCwd },
    );
    try {
      expect(run.ends).toEqual(["completed"]);
      expect(Object.keys(outputs(run)).sort()).toEqual(
        [
          "call_fp0",
          "call_fp1",
          "call_fp2",
          "call_fp3",
          "call_fp4",
          "call_fp5",
        ].sort(),
      );
      expect(readFileSync(join(agentCwd, "inside.txt"), "utf8")).toContain(
        "written inside",
      );
      expect(readFileSync(join(root, "outside-target.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(readFileSync(join(agentCwd, "AGENTS.md"), "utf8")).toBe(
        `${PROJECT_DOC}\n`,
      );
      expect(existsSync(tmpTarget)).toBe(false);
      expect(existsSync(join(agentCwd, "..", "escape-c2.txt"))).toBe(false);
      expect(existsSync(join(agentCwd, ".codex"))).toBe(false);
    } finally {
      rmSync(tmpTarget, { force: true });
    }
  }, 60_000);

  // A move on the slider resumes the thread: the tools follow the stop, not
  // the stop the thread started at.
  test("a thread started at Standard gets the file tools at folder, and loses them at office", async () => {
    const standard = await runTurn(undefined, ["done"]);
    expect(standard.threadId).not.toBe("");
    const folder = await runTurn("folder", ["done"], {
      agentCwd: standard.agentCwd,
      resumeThreadId: standard.threadId,
    });
    expect(folder.ends).toEqual(["completed"]);
    for (const request of folder.requests)
      expect(filesTools(request)).toEqual([
        "grep_files",
        "list_dir",
        "read_file",
      ]);
    const office = await runTurn("office", ["done"], {
      agentCwd: standard.agentCwd,
      resumeThreadId: standard.threadId,
    });
    expect(office.ends).toEqual(["completed"]);
    for (const request of office.requests) {
      expect(filesTools(request)).toEqual([]);
      expect(toolsOf(request)).not.toContain("<web_search>");
    }
  }, 120_000);
});
