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
// office server.

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
// how it ended.
async function runTurn(
  access: AgentAccess | undefined,
  answers: Answer[],
): Promise<{
  requests: Record<string, unknown>[];
  ends: string[];
  cwd: string;
  agentCwd: string;
}> {
  requests = [];
  script = answers;
  officeToolLists = 0;
  const agentId = `codex-access-live-${process.pid}-${seq++}`;
  const agentCwd = agentFolder();
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
    ...(access === "office"
      ? {
          mcpServers: [
            {
              name: "isomux",
              url: `http://127.0.0.1:${server!.port}/mcp`,
              headers: { Authorization: "Bearer fake-office-token-c1" },
            },
          ],
        }
      : {}),
  });
  const it = session.stream();
  const ends: string[] = [];
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
    cwd: join(CODEX_EMPTY_CWD_ROOT, agentId),
    agentCwd,
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
