// OpenCode below Standard (task e77304b1, merge C2), live tier
// (ISOMUX_TEST_OPENCODE=1): what a real server of the pinned OpenCode offers the
// model and runs for a session at each stop. The unit tests
// (opencode/adapter.access.test.ts, opencode/safety-plugin.test.ts) prove
// what Isomux sends; this proves what OpenCode makes of it.
//
// No model is called: the servers talk to a fake chat-completions endpoint
// in this process, which records the tools of each request and answers with
// a scripted tool call per request. The member's OpenCode folder holds a
// plugin that adds tools (P5: a plugin tool can take any permission name),
// and the agent's folder and a folder above it hold project settings, a
// plugin, AGENTS.md files and an MCP server. The Standard control proves
// those plants load when nothing confines the session.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentMcpServer } from "../mcp-servers.ts";
import {
  OPENCODE_LIVE_MODELS_CATALOG,
  openCodeLiveConfig,
  openCodeMockProvider,
} from "../test-support/opencode-live-config.ts";
import { createOpenCodeBackend } from "./opencode/adapter.ts";
import { openCodeProfileKey } from "./opencode/access.ts";
import { openCodeProfilePaths } from "./opencode/profile-paths.ts";
import { OpenCodeSupervisor } from "./opencode/supervisor.ts";
import { OPENCODE_SERVER_ONLY_VARIABLES } from "./opencode/safety-plugin-tool.ts";
import type {
  BackendSession,
  CreateSessionOptions,
  NormalizedEvent,
} from "./types.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";
const MEMBER = "member-c2-live";
const OFFICE_TOOLS = ["list_my_asks", "open_ask"];
const OFFICE_NAMES = OFFICE_TOOLS.map((tool) => `isomux_${tool}`);
const GATE = "gate/gate-model";
const GPT = "gate/gpt-5.5";
// Markers: each shows up in a request, or on disk, only when the plant it
// belongs to reached OpenCode.
const SECRET = "SECRET-OUTSIDE-C2";
const INSIDE = "NOTES-INSIDE-C2";
const FOLDER_DOC = "PLANTED-FOLDER-DOC-C2";
const ANCESTOR_DOC = "PLANTED-ANCESTOR-DOC-C2";

let root: string;
let memberDir: string;
let project: string;
let folder: string;
let outside: string;
let markers: string;
let server: ReturnType<typeof Bun.serve> | null = null;
const supervisors = new Map<string, OpenCodeSupervisor>();
const routedKeys: string[] = [];

// The fake provider: each request's tools, system text and tool results,
// and the tool calls the model makes, one per request, in order.
interface Seen {
  model: string;
  tools: string[];
  text: string;
}
let requests: Seen[] = [];
let plan: Array<{ name: string; args: Record<string, unknown> }> = [];
let officeCalls: string[] = [];
let plantedMcpHits = 0;

const marker = (name: string) => join(markers, name);
const ran = (name: string) => existsSync(marker(name));

function chunk(value: unknown): string {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

async function provider(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/models"))
    return Response.json({ object: "list", data: [] });
  const body = (await req.json()) as {
    model?: string;
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const messages = body.messages ?? [];
  requests.push({
    model: String(body.model),
    tools: (body.tools ?? []).map((t) => String(t.function?.name)).sort(),
    // Not the model's own turns: a tool call's arguments name the secret.
    text: JSON.stringify(messages.filter((m) => m.role !== "assistant")),
  });
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const step = messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "assistant").length;
  const call = plan[step];
  const base = {
    id: `c${requests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
  };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const out = call
    ? chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage,
      })
    : chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "done" },
            finish_reason: null,
          },
        ],
      }) +
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      });
  return new Response(out + chunk("[DONE]"), {
    headers: { "content-type": "text/event-stream" },
  });
}

// The office MCP server: the two tools of the agent's pack.
async function officeMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const mcp = new McpServer({ name: "isomux", version: "1.0.0" });
  for (const tool of OFFICE_TOOLS)
    mcp.registerTool(tool, { description: tool }, () => {
      officeCalls.push(tool);
      return { content: [{ type: "text", text: `${tool} ok` }] };
    });
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

// A plugin that adds tools and writes a marker when it loads and when a
// tool runs.
function plantPlugin(id: string, tools: Array<[string, string | null]>) {
  const add = tools
    .map(
      ([name, permission]) =>
        `editor.add(tool(${JSON.stringify(name)}, ${JSON.stringify(
          permission ? { codemode: false, permission } : { codemode: false },
        )}));`,
    )
    .join("\n      ");
  return `import { writeFileSync } from "node:fs";
const mark = (name) => writeFileSync(${JSON.stringify(markers)} + "/" + name, "x");
const tool = (name, options) => ({
  name,
  description: "planted " + name,
  input: { type: "object", properties: {} },
  options,
  execute: async () => { mark("ran-" + name); return { output: "ran " + name }; },
});
export default {
  id: ${JSON.stringify(id)},
  async setup(ctx) {
    mark("setup-${id}");
    await ctx.tool.transform((editor) => {
      ${add}
    });
  },
};
`;
}

// A plugin with one tool that writes, to a marker file, which of the
// server-only variables and of a control variable the OpenCode server's own
// environment holds when the tool runs (task 25ac1be4). It takes no
// permission, so no stop below Standard offers it.
const SERVER_ENV_NAMES = [
  ...OPENCODE_SERVER_ONLY_VARIABLES,
  "OPENCODE_DISABLE_AUTOUPDATE",
];
function serverEnvPlugin(): string {
  return `import { writeFileSync } from "node:fs";
export default {
  id: "server-env",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "server_env",
        description: "server env",
        input: { type: "object", properties: {} },
        options: { codemode: false },
        execute: async () => {
          const names = ${JSON.stringify(SERVER_ENV_NAMES)};
          const present = names.filter((name) => name in process.env);
          writeFileSync(${JSON.stringify(marker("server-env"))}, JSON.stringify(present));
          return { output: "ok" };
        },
      });
    });
  },
};
`;
}

beforeAll(async () => {
  if (!LIVE) return;
  root = mkdtempSync(join(tmpdir(), "opencode-access-live-"));
  markers = join(root, "markers");
  mkdirSync(markers);
  outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/mcp") return officeMcp(req);
      if (path === "/planted-mcp") {
        plantedMcpHits++;
        return officeMcp(req);
      }
      return provider(req);
    },
  });
  // The member's OpenCode folder: a plugin whose tools take the name of an
  // allowed permission (read), an office-like one, and none.
  memberDir = join(root, "member-opencode");
  mkdirSync(join(memberDir, "plugin"), { recursive: true });
  writeFileSync(
    join(memberDir, "plugin", "member.ts"),
    plantPlugin("member-plant", [
      ["plug_free", null],
      ["plug_read", "read"],
      ["plug_office", "isomux_x"],
    ]),
  );
  writeFileSync(join(memberDir, "plugin", "server-env.ts"), serverEnvPlugin());
  // The project: settings, a plugin, an MCP server and AGENTS.md in the
  // agent's folder and in a folder above it.
  project = join(root, "project");
  folder = join(project, "a", "folder");
  mkdirSync(join(folder, ".opencode", "plugin"), { recursive: true });
  const plantedConfig = JSON.stringify({
    mcp: {
      planted: {
        type: "remote",
        url: `http://127.0.0.1:${server.port}/planted-mcp`,
        oauth: false,
      },
    },
  });
  writeFileSync(join(project, "opencode.json"), plantedConfig);
  writeFileSync(join(project, "AGENTS.md"), `${ANCESTOR_DOC}\n`);
  writeFileSync(join(folder, "AGENTS.md"), `${FOLDER_DOC}\n`);
  writeFileSync(
    join(folder, ".opencode", "plugin", "plant.ts"),
    plantPlugin("project-plant", [["project_tool", null]]),
  );
  writeFileSync(join(folder, "notes.md"), `${INSIDE}\n`);
  writeFileSync(join(folder, "movable.txt"), "a\n");
  symlinkSync(join(outside, "secret.txt"), join(folder, "linked-file"));
  symlinkSync(outside, join(folder, "linked-dir"));
});

afterAll(async () => {
  for (const supervisor of supervisors.values()) await supervisor.shutdown();
  await server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

const backend = createOpenCodeBackend({
  supervisorForEnvironment: (key, env, revision, mcpServers) => {
    routedKeys.push(key);
    let supervisor = supervisors.get(key);
    if (!supervisor) {
      const url = `http://127.0.0.1:${server!.port}/v1`;
      const gate = openCodeMockProvider(url, {
        modelConfig: { tool_call: true },
      });
      (gate.models as Record<string, unknown>)["gpt-5.5"] = {
        name: "Gate GPT",
        cost: { input: 0, output: 0 },
        tool_call: true,
      };
      supervisor = new OpenCodeSupervisor({
        profileDir: openCodeProfilePaths(key).profileDir,
        serverCwd: root,
        idleShutdownMs: 60_000,
        launchEnv: env,
        modelsCatalog: OPENCODE_LIVE_MODELS_CATALOG,
        environmentRevision: revision,
        mcpServers: mcpServers ?? [],
        config: openCodeLiveConfig(GATE, { gate }),
      });
      supervisors.set(key, supervisor);
    }
    return supervisor;
  },
});

function officeServer(): AgentMcpServer {
  return {
    name: "isomux",
    url: `http://127.0.0.1:${server!.port}/mcp`,
    headers: { Authorization: "Bearer office-token" },
  };
}

let agents = 0;
function sessionAt(
  access: AgentAccess,
  model = GATE,
  cwd = folder,
): BackendSession {
  const agentId = `opencode-live-c2-${process.pid}-${agents++}`;
  const opts: CreateSessionOptions = {
    agentId,
    cwd,
    systemPrompt: "Isomux live test.",
    modelFamily: model,
    effort: "high",
    permissionMode: "default",
    environmentKey: MEMBER,
    environmentRevision: "rev",
    env: { OPENCODE_CONFIG_DIR: memberDir },
    ...(access === "standard" ? {} : { access }),
    ...(access === "chat" || access === "standard"
      ? {}
      : { officeTools: OFFICE_TOOLS, mcpServers: [officeServer()] }),
  };
  return backend.createSession(opts);
}

// One turn, with `calls` as the model's tool calls: the events, the
// provider requests of the turn, and how the turn ended.
async function turn(
  session: BackendSession,
  calls: typeof plan,
): Promise<{ events: NormalizedEvent[]; seen: Seen[] }> {
  plan = calls;
  requests = [];
  const events: NormalizedEvent[] = [];
  const iterator = session.stream()[Symbol.asyncIterator]();
  await session.send("go");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iterator.next(),
      Bun.sleep(deadline - Date.now()).then(() => null),
    ]);
    if (!next || next.done) break;
    events.push(next.value);
    if (next.value.kind === "turn_completed") break;
  }
  session.close();
  // Each call reached the model's next request, so each one was tried. (At
  // Standard OpenCode also asks the model for a title.)
  expect(requests.length).toBeGreaterThanOrEqual(calls.length + 1);
  return { events, seen: requests };
}

const failures = (events: NormalizedEvent[]) =>
  events.flatMap((e) =>
    e.kind === "error"
      ? [JSON.stringify(e.message)]
      : e.kind === "turn_completed" && e.status !== "completed"
        ? [JSON.stringify(e)]
        : [],
  );
const completed = (events: NormalizedEvent[]) =>
  events.some((e) => e.kind === "turn_completed");
const toolsOf = (seen: Seen[]) => seen[0]?.tools ?? null;
const text = (seen: Seen[]) => seen.map((s) => s.text).join("\n");

// The calls that try to leave a stop; each leaves a mark only if it ran.
const escapes = () => [
  { name: "read", args: { path: join(outside, "secret.txt") } },
  { name: "read", args: { path: join(folder, "linked-file") } },
  { name: "read", args: { path: join(folder, "linked-dir", "secret.txt") } },
  { name: "read", args: { path: "../../../outside/secret.txt" } },
  { name: "grep", args: { pattern: SECRET, path: outside } },
  { name: "glob", args: { pattern: "*", path: outside } },
  { name: "write", args: { path: join(outside, "escaped.txt"), content: "x" } },
  {
    name: "write",
    args: { path: join(folder, "linked-dir", "through.txt"), content: "x" },
  },
  {
    name: "write",
    args: {
      path: join(folder, ".opencode", "plugin", "evil.ts"),
      content: "export default {}",
    },
  },
  { name: "shell", args: { command: `touch ${marker("shell-ran")}` } },
  { name: "plug_free", args: {} },
  { name: "plug_read", args: {} },
  { name: "plug_office", args: {} },
  { name: "project_tool", args: {} },
];

function expectNoEscape(label: string, seen: Seen[]): void {
  expect({ label, secret: text(seen).includes(SECRET) }).toEqual({
    label,
    secret: false,
  });
  expect({
    label,
    on: {
      escaped: existsSync(join(outside, "escaped.txt")),
      through: existsSync(join(outside, "through.txt")),
      plugin: existsSync(join(folder, ".opencode", "plugin", "evil.ts")),
      shell: ran("shell-ran"),
      plugFree: ran("ran-plug_free"),
      plugRead: ran("ran-plug_read"),
      plugOffice: ran("ran-plug_office"),
      projectTool: ran("ran-project_tool"),
    },
  }).toEqual({
    label,
    on: {
      escaped: false,
      through: false,
      plugin: false,
      shell: false,
      plugFree: false,
      plugRead: false,
      plugOffice: false,
      projectTool: false,
    },
  });
}

function expectNoPlants(label: string, seen: Seen[]): void {
  expect({
    label,
    docs: [FOLDER_DOC, ANCESTOR_DOC].filter((doc) => text(seen).includes(doc)),
    projectPlugin: ran("setup-project-plant"),
    plantedMcp: plantedMcpHits,
  }).toEqual({ label, docs: [], projectPlugin: false, plantedMcp: 0 });
}

describe.skipIf(!LIVE)("OpenCode below Standard, live", () => {
  // The member's own plugin loads on the limited server (the residual in
  // security-audit.md 6.2a): its tool that takes the read permission is
  // offered at Folder and Web, and the plugin refuses it. So is 2.2.5's
  // opencode_worktree_remove: with execute denied, OpenCode offers each Code
  // Mode tool whose permission the rules allow, and that one takes edit
  // (core/src/tool.ts, tool/plugin/opencode.ts). The plugin refuses it by
  // name, as it refuses plug_read.
  const folderTools = (model: string, web: boolean) =>
    [
      ...OFFICE_NAMES,
      "glob",
      "grep",
      "read",
      "plug_read",
      "opencode_worktree_remove",
      ...(model === GPT ? ["patch"] : ["edit", "write"]),
      ...(web ? ["webfetch", "websearch"] : []),
    ].sort();

  it("offers no tool at Chat and refuses every call", async () => {
    const { events, seen } = await turn(sessionAt("chat"), [
      { name: "isomux_list_my_asks", args: {} },
      ...escapes(),
    ]);
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    expect(toolsOf(seen)).toEqual([]);
    expect(officeCalls).toEqual([]);
    expectNoEscape("chat", seen);
    expectNoPlants("chat", seen);
  }, 120_000);

  it("offers the office tools of the pack at Office, by exact name, and nothing else", async () => {
    officeCalls = [];
    const { events, seen } = await turn(sessionAt("office"), [
      { name: "isomux_list_my_asks", args: {} },
      { name: "read", args: { path: join(folder, "notes.md") } },
      ...escapes(),
    ]);
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    expect(toolsOf(seen)).toEqual([...OFFICE_NAMES].sort());
    expect(officeCalls).toEqual(["list_my_asks"]);
    expect(text(seen).includes(INSIDE)).toBe(false);
    expectNoEscape("office", seen);
    expectNoPlants("office", seen);
  }, 120_000);

  for (const model of [GATE, GPT])
    it(`offers the Folder tools for ${model}, inside the folder only`, async () => {
      officeCalls = [];
      const inside =
        model === GPT
          ? {
              name: "patch",
              args: {
                patchText: `*** Begin Patch\n*** Add File: ${join(folder, "patched.txt")}\n+P\n*** End Patch`,
              },
            }
          : {
              name: "write",
              args: { path: join(folder, "written.txt"), content: "W" },
            };
      const patchEscapes =
        model === GPT
          ? [
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Add File: ${join(outside, "escaped.txt")}\n+P\n*** End Patch`,
                },
              },
              // Inside the folder by name, so only Isomux's plugin refuses
              // them: through a link, and into OpenCode's own settings.
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Add File: ${join(folder, "linked-dir", "through.txt")}\n+P\n*** End Patch`,
                },
              },
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Add File: ${join(folder, ".opencode", "plugin", "evil.ts")}\n+export default {}\n*** End Patch`,
                },
              },
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Update File: ${join(folder, "movable.txt")}\n*** Move to: ${join(folder, "linked-dir", "moved-through.txt")}\n@@\n-a\n+b\n*** End Patch`,
                },
              },
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Update File: ${join(folder, "movable.txt")}\n*** Move to: ${join(outside, "moved.txt")}\n@@\n-a\n+b\n*** End Patch`,
                },
              },
            ]
          : [];
      const { events, seen } = await turn(sessionAt("folder", model), [
        { name: "read", args: { path: join(folder, "notes.md") } },
        inside,
        ...patchEscapes,
        ...escapes(),
        // The control of the moves: one inside the folder runs.
        ...(model === GPT
          ? [
              {
                name: "patch",
                args: {
                  patchText: `*** Begin Patch\n*** Update File: ${join(folder, "movable.txt")}\n*** Move to: ${join(folder, "moved-inside.txt")}\n@@\n-a\n+b\n*** End Patch`,
                },
              },
            ]
          : []),
      ]);
      expect({
        completed: completed(events),
        failures: failures(events),
      }).toEqual({ completed: true, failures: [] });
      expect(toolsOf(seen)).toEqual(folderTools(model, false));
      // The controls: a read and a write inside the folder run.
      expect(text(seen).includes(INSIDE)).toBe(true);
      const made = join(folder, model === GPT ? "patched.txt" : "written.txt");
      expect(existsSync(made) && readFileSync(made, "utf8").trim()).toBe(
        model === GPT ? "P" : "W",
      );
      rmSync(made);
      expect(
        existsSync(join(outside, "moved.txt")) ||
          existsSync(join(outside, "moved-through.txt")),
      ).toBe(false);
      if (model === GPT) {
        const moved = join(folder, "moved-inside.txt");
        expect(existsSync(moved) && readFileSync(moved, "utf8")).toBe("b\n");
        rmSync(moved);
        writeFileSync(join(folder, "movable.txt"), "a\n");
      }
      expectNoEscape(`folder ${model}`, seen);
      expectNoPlants(`folder ${model}`, seen);
    }, 120_000);

  it("adds web fetch and search at Web", async () => {
    const { events, seen } = await turn(sessionAt("web"), escapes());
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    expect(toolsOf(seen)).toEqual(folderTools(GATE, true));
    expectNoEscape("web", seen);
    expectNoPlants("web", seen);
  }, 120_000);

  it("runs the one-shot below Standard on the limited server, with no tool", async () => {
    requests = [];
    plan = [];
    const reply = await backend.oneShotPrompt("topic please", {
      modelFamily: GATE,
      environmentKey: MEMBER,
      environmentRevision: "rev",
      env: { OPENCODE_CONFIG_DIR: memberDir },
      access: "office",
    });
    expect(reply).toContain("done");
    expect(requests.map((r) => r.tools)).toEqual([[]]);
    expect(routedKeys.at(-1)).toBe(openCodeProfileKey(MEMBER, "office"));
    expectNoPlants("one-shot", requests);
  }, 120_000);

  // Last: it loads the plants into the member's own server.
  it("loads the plants and offers every tool at Standard (the control)", async () => {
    const { events, seen } = await turn(sessionAt("standard"), [
      { name: "plug_free", args: {} },
    ]);
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    const tools = toolsOf(seen) ?? [];
    for (const tool of ["shell", "plug_free", "project_tool", "edit"])
      expect({ tool, offered: tools.includes(tool) }).toEqual({
        tool,
        offered: true,
      });
    expect(ran("ran-plug_free")).toBe(true);
    expect({
      folderDoc: text(seen).includes(FOLDER_DOC),
      projectPlugin: ran("setup-project-plant"),
      plantedMcp: plantedMcpHits > 0,
    }).toEqual({ folderDoc: true, projectPlugin: true, plantedMcp: true });
    expect(new Set(routedKeys)).toEqual(
      new Set([MEMBER, openCodeProfileKey(MEMBER, "chat")]),
    );
  }, 120_000);
});

// OpenCode's own schedules (task 7c765af8): a scheduled turn runs on the
// OpenCode server, and Isomux does not show it. A member's config turns them
// on; Isomux's rules take schedule_create and schedule_resume away, and a
// member's allow does not give them back. Its own member folder and key, so
// the schedules flag reaches no other case.
describe.skipIf(!LIVE)("OpenCode schedules, live", () => {
  const key = "member-schedules-live";
  let dir: string;
  let cwd: string;
  beforeAll(() => {
    dir = join(root, "member-schedules");
    cwd = join(root, "schedules-folder");
    mkdirSync(dir);
    mkdirSync(cwd);
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({
        experimental: { schedules: true },
        permissions: [
          {
            action: "opencode_schedule_create",
            resource: "*",
            effect: "allow",
          },
          {
            action: "opencode_schedule_resume",
            resource: "*",
            effect: "allow",
          },
        ],
      }),
    );
  });

  // The output of each tool call of the turn, in order.
  const outputs = (seen: Seen[]) => {
    const last = seen.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    return (
      JSON.parse(last.text) as Array<{ role?: string; content?: unknown }>
    )
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content));
  };

  it("takes schedule_create away at Standard, even when the member allows it", async () => {
    const session = backend.createSession({
      agentId: `opencode-live-schedules-${process.pid}`,
      cwd,
      systemPrompt: "Isomux live test.",
      modelFamily: GATE,
      effort: "high",
      permissionMode: "bypassPermissions",
      environmentKey: key,
      environmentRevision: "rev",
      env: { OPENCODE_CONFIG_DIR: dir },
    });
    const name = "isomux-hidden-turn";
    // The names of the stored schedules, or "none".
    const list = {
      name: "execute",
      args: {
        code: 'const { schedules } = await tools.opencode.schedule_list({}); return "stored: " + (schedules.map((s) => s.name).join(",") || "none")',
      },
    };
    const { events, seen } = await turn(session, [
      list,
      {
        name: "execute",
        args: {
          code: `return JSON.stringify(await tools.opencode.schedule_create(${JSON.stringify(
            { name, when: { in: "1 hour" }, prompt: "wake" },
          )}))`,
        },
      },
      {
        name: "execute",
        args: {
          code: "return JSON.stringify(Object.keys(tools.opencode).sort())",
        },
      },
      list,
    ]);
    expect(completed(events)).toBe(true);
    const [before, create, catalog, after] = outputs(seen);
    // The condition: the flag is on and the model reaches the namespace.
    expect(before).toContain("stored: none");
    expect(catalog).toContain("schedule_list");
    expect(catalog).toContain("schedule_pause");
    // MUTANT: no deny rule for opencode_schedule_create.
    expect(after).toContain("stored: none");
    expect(create).not.toContain(name);
    expect(catalog).not.toContain("schedule_create");
    // MUTANT: no deny rule for opencode_schedule_resume.
    expect(catalog).not.toContain("schedule_resume");
  }, 120_000);
});

// Refused cards (task fcfffe51): the safety plugin reports a refusal as an
// RPC event before it throws. This pins what the transport builds on: the
// real server registers the RPC per folder, puts the event on /api/event
// with the call's session, message and id, and sends it before the call's
// session.tool.failed, so the card lands between the call and its result.
describe.skipIf(!LIVE)("OpenCode refused cards, live", () => {
  it("shows a refused shell call's card between the call and its result", async () => {
    const command = "git push --force origin nothing";
    const { events } = await turn(sessionAt("standard"), [
      { name: "shell", args: { command, description: "refused" } },
    ]);
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    const shown = events.filter(
      (e) =>
        e.kind === "tool_call" ||
        e.kind === "permission_denied" ||
        e.kind === "tool_result",
    );
    // The condition: the plugin refused the call (its result is an error
    // that names the command; the command never ran).
    const result = shown.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain(command);
    // MUTANT: the transport drops the RPC frame, or the server sends it
    // after the failed frame.
    expect(shown.map((e) => e.kind)).toEqual([
      "tool_call",
      "permission_denied",
      "tool_result",
    ]);
    const id = (shown[0] as { toolUseId: string }).toolUseId;
    expect(shown.map((e) => (e as { toolUseId: string }).toolUseId)).toEqual([
      id,
      id,
      id,
    ]);
    expect(shown[0]).toMatchObject({ name: "shell", input: { command } });
    expect(shown[1]).toMatchObject({ toolName: "shell" });
  }, 120_000);
});

// Task 25ac1be4: OpenCode starts some processes from its own environment
// with no Isomux hook (a schedule's shell check, a terminal, a formatter),
// and reads the server-only variables once, at start. After the safety
// plugin's setup the server's environment holds none of them. A tool of a
// member plugin runs in the server process and reads it at call time.
describe.skipIf(!LIVE)("OpenCode server environment, live", () => {
  it("holds none of the server-only variables once the plugins are active", async () => {
    const { events } = await turn(sessionAt("standard"), [
      { name: "server_env", args: {} },
    ]);
    expect({
      completed: completed(events),
      failures: failures(events),
    }).toEqual({ completed: true, failures: [] });
    // The condition: the tool ran in the server and saw its environment.
    expect(ran("server-env")).toBe(true);
    const present = JSON.parse(
      readFileSync(marker("server-env"), "utf8"),
    ) as string[];
    // MUTANT: the safety plugin's setup leaves the server's environment as
    // it is.
    expect(present).toEqual(["OPENCODE_DISABLE_AUTOUPDATE"]);
  }, 120_000);
});
