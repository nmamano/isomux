// OpenCode below Standard through the real backend and transport (task
// e77304b1, merge C2), against the 2.1.4 stand-in: which server a session
// runs on, its agent and rules at create and at resume, its folder, the
// office MCP server it gets, the checks that refuse a start, its
// attachments, and the one-shot. The rules themselves are pinned in
// access.test.ts; the tools the model sees, in opencode-access.live.test.ts.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
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
import type { AgentAccess } from "../../../shared/agent-access.ts";
import { STATE_ROOT } from "../../config.ts";
import { removeStateDir } from "../../test-support/temp-state.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import type {
  BackendSession,
  CreateSessionOptions,
  NormalizedEvent,
} from "../types.ts";
import {
  OPENCODE_EMPTY_CWD_ROOT,
  OPENCODE_LIMITED_ONE_SHOT_DIR,
  openCodeEmptyCwd,
  openCodeProfileKey,
  openCodeStopRules,
} from "./access.ts";
import {
  createOpenCodeBackend,
  openCodePromptAttachments,
  type OpenCodeBackendOptions,
} from "./adapter.ts";
import {
  FAKE_PROFILE,
  fakeOpenCode,
  fakeSupervisor,
  framesOf,
  modelRow,
  type FakeOptions,
  type FakeTurn,
  type Frame,
} from "./fake-opencode-v2.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import { OpenCodeTransport } from "./transport.ts";
import { cleanUpProfileFixtures, fakeCli, profile } from "./profile-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
// The folders earlier stand-ins saw. A closed session's shell sweep runs
// after its close returns and can reach the next stand-in.
const earlierFolders = new Set<string>();
async function disposeAll(): Promise<void> {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
}
afterEach(disposeAll);
const removeAfter: string[] = [];
afterAll(() => {
  for (const dir of removeAfter) rmSync(dir, { recursive: true, force: true });
});

const MEMBER_KEY = "member-key-c2";
const MEMBER_DIR = "/fake-member/opencode";
const OFFICE_TOOLS = ["list_my_asks", "open_ask"];
const BELOW = ["chat", "office", "folder", "web"] as const;

// GET /api/config of a limited server (probe p4): the member's config dir and
// Isomux's document. `servers`: MCP servers in the member's opencode.json.
function limitedConfig(
  servers: Record<string, unknown> = {},
  extra: unknown[] = [],
): unknown[] {
  return [
    {
      type: "document",
      path: `${MEMBER_DIR}/opencode.json`,
      info: { mcp: { servers } },
    },
    { type: "directory", path: MEMBER_DIR },
    // Isomux's config file in the profile (OPENCODE_CONFIG).
    { type: "document", path: `${FAKE_PROFILE}/opencode.json`, info: {} },
    ...extra,
    {
      type: "document",
      info: { agents: { "isomux-cron": { mode: "primary" } } },
    },
  ];
}

function officeServer(agentId: string): AgentMcpServer {
  return {
    name: "isomux",
    url: "http://127.0.0.1:4000/mcp",
    headers: { Authorization: `Bearer token-of-${agentId}` },
  };
}

let seq = 0;
function agentFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-access-"));
  removeAfter.push(dir);
  return dir;
}
function newAgentId(): string {
  const id = `opencode-below-${process.pid}-${seq++}`;
  removeAfter.push(join(OPENCODE_EMPTY_CWD_ROOT, id));
  return id;
}

interface Routed {
  key: string;
  env: Record<string, string | undefined> | undefined;
  mcpServers: AgentMcpServer[] | undefined;
}

// A backend whose servers are the stand-in, recording which server each
// session asks for. `shared`: the server's own MCP list, as another agent of
// the member left it. One stand-in at a time: a new harness ends the last.
async function harness(
  fakeOptions: FakeOptions = {},
  shared: AgentMcpServer[] = [officeServer("another-agent")],
) {
  await disposeAll();
  let nextSession = 0;
  const fake = fakeOpenCode({
    nextSessionId: () => `ses_new_${++nextSession}`,
    models: () => [modelRow("gate", "free")],
    config: () => limitedConfig(),
    ...fakeOptions,
  });
  cleanup.push(() => {
    for (const request of fake.requests) {
      const folder = folderOf(request);
      if (folder) earlierFolders.add(folder);
    }
    fake.restore();
  });
  const { supervisor } = fakeSupervisor({
    mcpServers: () => shared,
    configDir: MEMBER_DIR,
  });
  const routed: Routed[] = [];
  // `supervisor` is only the fallback: supervisorForEnvironment wins when
  // given, so a test never starts a real OpenCode.
  const options = {
    supervisor,
    supervisorForEnvironment: (
      key: string,
      env: Record<string, string | undefined> | undefined,
      _revision: string | undefined,
      mcpServers: AgentMcpServer[] | undefined,
    ): OpenCodeSupervisor => {
      routed.push({ key, env, mcpServers });
      return supervisor;
    },
  } as OpenCodeBackendOptions;
  return { fake, backend: createOpenCodeBackend(options), routed, supervisor };
}

function sessionOpts(
  access: AgentAccess,
  agentId: string,
  cwd: string,
  extra: Partial<CreateSessionOptions> = {},
): CreateSessionOptions {
  return {
    agentId,
    cwd,
    systemPrompt: "prompt",
    modelFamily: "gate/free",
    effort: "high",
    permissionMode: "default",
    environmentKey: MEMBER_KEY,
    environmentRevision: "rev",
    env: { PATH: "/usr/bin", OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    access,
    ...(access === "standard" || access === "chat"
      ? {}
      : { officeTools: OFFICE_TOOLS, mcpServers: [officeServer(agentId)] }),
    ...extra,
  };
}

// Sends one message and reads the session's events until the turn ends or
// the prompt went out.
async function sendOnce(
  session: BackendSession,
  fake: ReturnType<typeof fakeOpenCode>,
  text = "hello",
  attachments?: Parameters<BackendSession["send"]>[1],
): Promise<{ sent: boolean; end: NormalizedEvent | null }> {
  cleanup.push(() => session.close());
  const it = session.stream()[Symbol.asyncIterator]();
  await session.send(text, attachments).catch(() => {});
  const deadline = Date.now() + 3_000;
  let end: NormalizedEvent | null = null;
  while (Date.now() < deadline && fake.prompts() === 0) {
    const next = await Promise.race([
      it.next(),
      Bun.sleep(50).then(() => null),
    ]);
    if (next && !next.done && next.value.kind === "turn_completed") {
      end = next.value;
      break;
    }
  }
  return { sent: fake.prompts() > 0, end };
}

const folderOf = (r: { query: URLSearchParams }) =>
  r.query.get("location[directory]");

describe("OpenCode below Standard: the server", () => {
  // Plugins from any Standard folder of the member load into the shared
  // server's process; a session below Standard never runs there.
  it("runs a session below Standard on the member's limited server, with project config off and no office server in the server's list", async () => {
    for (const access of ["standard", ...BELOW] as const) {
      const h = await harness();
      const id = newAgentId();
      const session = h.backend.createSession(
        sessionOpts(access, id, agentFolder()),
      );
      await sendOnce(session, h.fake);
      const below = access !== "standard";
      expect({
        access,
        keys: [...new Set(h.routed.map((r) => r.key))],
        flags: [
          ...new Set(
            h.routed.map((r) => r.env?.OPENCODE_DISABLE_PROJECT_CONFIG),
          ),
        ],
      }).toEqual({
        access,
        keys: [openCodeProfileKey(MEMBER_KEY, below ? access : "standard")],
        flags: [below ? "1" : "0"],
      });
      // The office server carries this agent's token: it goes to the
      // agent's own folder, never into the list every folder of the server
      // gets.
      if (below)
        expect({
          access,
          servers: h.routed.flatMap((r) => r.mcpServers ?? []),
        }).toEqual({ access, servers: [] });
    }
  });
});

describe("OpenCode below Standard: the session", () => {
  it("creates the session as the stop's agent with the stop's rules, in the empty folder at chat and office and the agent's folder at folder and web", async () => {
    for (const access of BELOW) {
      const id = newAgentId();
      const own = agentFolder();
      const want =
        access === "folder" || access === "web"
          ? own
          : join(OPENCODE_EMPTY_CWD_ROOT, id);
      let emptyAtCreate = null as boolean | null;
      const h = await harness({
        override: (route) => {
          if (route === "session.create")
            emptyAtCreate = existsSync(want) && readdirSync(want).length === 0;
          return undefined;
        },
      });
      // Plan and bypass agents never run below Standard.
      const session = h.backend.createSession(
        sessionOpts(access, id, own, {
          permissionMode: "bypassPermissions",
          interactive: true,
        }),
      );
      const { sent } = await sendOnce(session, h.fake);
      expect({ access, sent }).toEqual({ access, sent: true });
      const tools = access === "chat" ? [] : OFFICE_TOOLS;
      expect({
        access,
        create: h.fake.calls("POST", /^\/api\/session$/).map((r) => r.body),
      }).toEqual({
        access,
        create: [
          expect.objectContaining({
            agent: `isomux-${access}`,
            permissions: openCodeStopRules(access, tools),
            location: { directory: want },
          }),
        ],
      });
      expect({ access, agents: h.fake.promptLog.map((p) => p.agent) }).toEqual({
        access,
        agents: [`isomux-${access}`],
      });
      expect({
        access,
        folders: [
          ...new Set(
            h.fake.requests
              .map(folderOf)
              .filter((f) => f !== null && !earlierFolders.has(f)),
          ),
        ],
      }).toEqual({ access, folders: [want] });
      if (access === "chat" || access === "office")
        expect({ access, emptyAtCreate }).toEqual({
          access,
          emptyAtCreate: true,
        });
    }
  });

  // P6: an agent switch alone keeps the rules the session was made with, so
  // a session made at Standard keeps its allows. The resume replaces the list
  // and then switches the agent.
  it("replaces the rules and switches the agent of a resumed session, made at Standard", async () => {
    for (const access of BELOW) {
      const id = newAgentId();
      const h = await harness();
      const session = h.backend.resumeSession(
        "ses_from_standard",
        sessionOpts(access, id, agentFolder()),
      );
      const { sent } = await sendOnce(session, h.fake);
      expect({ access, sent }).toEqual({ access, sent: true });
      const tools = access === "chat" ? [] : OFFICE_TOOLS;
      const path = "/api/session/ses_from_standard";
      const steps = h.fake.requests
        .filter(
          (r) =>
            (r.method === "PATCH" && r.path === path) ||
            (r.method === "POST" && r.path === `${path}/agent`) ||
            (r.method === "POST" && r.path === `${path}/prompt`),
        )
        .map((r) => [r.path.split("/").at(-1), r.body]);
      expect({ access, steps }).toEqual({
        access,
        steps: [
          [
            "ses_from_standard",
            expect.objectContaining({
              permissions: openCodeStopRules(access, tools),
            }),
          ],
          ["agent", { agent: `isomux-${access}` }],
          ["prompt", expect.anything()],
        ],
      });
    }
  });
});

describe("OpenCode below Standard: the office MCP server", () => {
  it("puts this agent's office server into its own folder at office, folder and web, and none at chat", async () => {
    for (const access of BELOW) {
      const id = newAgentId();
      const h = await harness();
      // At chat too the caller hands over an office server: the stop drops it.
      const session = h.backend.createSession(
        sessionOpts(access, id, agentFolder(), {
          officeTools: OFFICE_TOOLS,
          mcpServers: [officeServer(id)],
        }),
      );
      await sendOnce(session, h.fake);
      expect({
        access,
        rules: h.fake
          .calls("POST", /^\/api\/session$/)
          .map((r) => (r.body as { permissions?: unknown }).permissions),
      }).toEqual({
        access,
        rules: [
          openCodeStopRules(access, access === "chat" ? [] : OFFICE_TOOLS),
        ],
      });
      const puts = h.fake
        .calls("PUT", /^\/api\/experimental\/mcp\//)
        .map((r) => ({
          name: decodeURIComponent(r.path.split("/").at(-1)!),
          auth: (r.body as { config?: { headers?: Record<string, string> } })
            .config?.headers?.Authorization,
        }));
      expect({ access, puts }).toEqual({
        access,
        puts:
          access === "chat"
            ? []
            : [{ name: "isomux", auth: `Bearer token-of-${id}` }],
      });
    }
  });

  // A folder keeps a run-time server until the server stops: an agent that
  // moved from office to chat finds its old office server there.
  it("at chat, removes an office server the folder still has, then runs", async () => {
    const id = newAgentId();
    const folder = join(OPENCODE_EMPTY_CWD_ROOT, id);
    const h = await harness({
      mcpServers: (directory) => (directory === folder ? ["isomux"] : []),
    });
    const session = h.backend.createSession(
      sessionOpts("chat", id, agentFolder()),
    );
    const { sent } = await sendOnce(session, h.fake);
    expect(
      h.fake
        .calls("DELETE", /^\/api\/experimental\/mcp\//)
        .map((r) => [r.path.split("/").at(-1), folderOf(r)]),
    ).toEqual([["isomux", folder]]);
    expect(sent).toBe(true);
  });
});

describe("OpenCode below Standard: the checks before a prompt", () => {
  // Each refusal ends the turn before any prompt reaches OpenCode.
  const refusals: [string, AgentAccess, (id: string) => FakeOptions][] = [
    [
      "a project config layer",
      "folder",
      () => ({
        config: () =>
          limitedConfig({}, [
            { type: "document", path: "/srv/repo/opencode.json", info: {} },
          ]),
      }),
    ],
    [
      "a project .opencode folder",
      "office",
      () => ({
        config: () =>
          limitedConfig({}, [{ type: "directory", path: "/srv/.opencode" }]),
      }),
    ],
    [
      "a member server named like the office one",
      "office",
      () => ({
        config: () => limitedConfig({ isomux_send: { type: "remote" } }),
        mcpServers: () => ["isomux_send"],
      }),
    ],
    [
      "a config server not listed yet",
      "web",
      () => ({ config: () => limitedConfig({ isomux_late: {} }) }),
    ],
    [
      "an MCP list it cannot read",
      "office",
      () => ({
        override: (route) =>
          route === "mcp.list"
            ? new Response(JSON.stringify({ rows: [] }), {
                headers: { "content-type": "application/json" },
              })
            : undefined,
      }),
    ],
    [
      "a config it cannot read",
      "chat",
      () => ({
        override: (route) =>
          route === "config"
            ? new Response(JSON.stringify({ layers: [] }), {
                headers: { "content-type": "application/json" },
              })
            : undefined,
      }),
    ],
  ];
  for (const [label, access, options] of refusals)
    it(`refuses the turn on ${label}`, async () => {
      const id = newAgentId();
      const h = await harness(options(id));
      const session = h.backend.createSession(
        sessionOpts(access, id, agentFolder()),
      );
      const { sent, end } = await sendOnce(session, h.fake);
      expect(sent).toBe(false);
      expect(end?.kind).toBe("turn_completed");
      expect((end as { status?: string }).status).toBe("failed");
      // The control: the same stop with a clean server sends, so the
      // refusal came from the fixture.
      const control = await harness();
      const clean = control.backend.createSession(
        sessionOpts(access, newAgentId(), agentFolder()),
      );
      expect((await sendOnce(clean, control.fake)).sent).toBe(true);
    });

  it("refuses the turn when the empty folder holds anything", async () => {
    const id = newAgentId();
    const folder = join(OPENCODE_EMPTY_CWD_ROOT, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, "opencode.json"), "{}");
    const h = await harness();
    const session = h.backend.createSession(
      sessionOpts("office", id, agentFolder()),
    );
    const { sent } = await sendOnce(session, h.fake);
    expect(sent).toBe(false);
    expect(h.fake.count("session.create")).toBe(0);
    rmSync(join(folder, "opencode.json"));
    const control = await harness();
    const again = control.backend.createSession(
      sessionOpts("office", id, agentFolder()),
    );
    expect((await sendOnce(again, control.fake)).sent).toBe(true);
  });
});

describe("OpenCode below Standard: the empty folder's mode", () => {
  it("refuses the turn when the empty folder is open to others", async () => {
    const id = newAgentId();
    const folder = join(OPENCODE_EMPTY_CWD_ROOT, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o755);
    const h = await harness();
    const { sent } = await sendOnce(
      h.backend.createSession(sessionOpts("chat", id, agentFolder())),
      h.fake,
    );
    expect(sent).toBe(false);
    expect(h.fake.count("session.create")).toBe(0);
    chmodSync(folder, 0o700);
    const control = await harness();
    const again = control.backend.createSession(
      sessionOpts("chat", id, agentFolder()),
    );
    expect((await sendOnce(again, control.fake)).sent).toBe(true);
  });
});

describe("OpenCode below Standard: attachments", () => {
  const AGENT = `opencode-attach-${process.pid}`;
  const FILES_DIR = join(STATE_ROOT, "logs", AGENT, "files");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  afterAll(() => removeStateDir(join(STATE_ROOT, "logs", AGENT)));
  const att = (filename: string, mediaType: string) => ({
    filename,
    originalName: filename,
    mediaType,
    size: 4,
  });
  function fixtures() {
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(join(FILES_DIR, "shot.png"), PNG);
    writeFileSync(join(FILES_DIR, "notes.md"), "NOTES BODY\n");
  }

  // 2.1.4 reads a file: URI from the server's own disk (probe pf): only
  // data: URIs go out.
  it("at chat and office an image goes as a data: URI, and no path, file: URI or other file reaches OpenCode", async () => {
    fixtures();
    for (const access of ["chat", "office"] as const) {
      const h = await harness();
      removeAfter.push(join(OPENCODE_EMPTY_CWD_ROOT, AGENT));
      const session = h.backend.createSession(
        sessionOpts(access, AGENT, agentFolder()),
      );
      await sendOnce(session, h.fake, "look", [
        att("shot.png", "image/png"),
        att("notes.md", "text/markdown"),
      ]);
      const prompt = h.fake.calls("POST", /\/prompt$/)[0]?.body as {
        files?: unknown;
      };
      expect({ access, files: prompt?.files }).toEqual({
        access,
        files: [
          {
            uri: `data:image/png;base64,${PNG.toString("base64")}`,
            mime: "image/png",
            name: "shot.png",
          },
        ],
      });
      const body = JSON.stringify(prompt);
      expect(body).not.toContain(FILES_DIR);
      expect(body).not.toContain("notes.md");
      expect(body).not.toContain("NOTES BODY");
      expect(body).not.toContain("file:");
      rmSync(join(OPENCODE_EMPTY_CWD_ROOT, AGENT), {
        recursive: true,
        force: true,
      });
    }
  });

  // The transport's own filter, whatever the adapter hands it.
  it("never sends a file: URI, from any caller", async () => {
    const id = newAgentId();
    const h = await harness();
    const transport = new OpenCodeTransport({
      cwd: join(OPENCODE_EMPTY_CWD_ROOT, id),
      model: "gate/free",
      systemPrompt: "prompt",
      supervisor: h.supervisor,
      agent: "isomux-chat",
      limited: { rules: openCodeStopRules("chat", []), mcpServers: [] },
      prepare: async () => {
        await openCodeEmptyCwd(id);
      },
    });
    cleanup.push(() => transport.close());
    const data = `data:image/png;base64,${PNG.toString("base64")}`;
    void transport
      .send(
        [
          { type: "text", text: "look" },
          {
            type: "file",
            uri: "file:///etc/passwd",
            mime: "text/plain",
            name: "p",
          },
          { type: "file", uri: data, mime: "image/png", name: "shot.png" },
        ],
        () => {},
      )
      .catch(() => {});
    const deadline = Date.now() + 3_000;
    while (h.fake.prompts() === 0 && Date.now() < deadline) await Bun.sleep(20);
    const prompt = h.fake.calls("POST", /\/prompt$/)[0]?.body as {
      files?: { uri: string }[];
    };
    expect(prompt?.files?.map((f) => f.uri)).toEqual([data]);
  });

  it("at folder and web each file is copied into the folder, the notice names the copy, and no file goes inline", async () => {
    fixtures();
    for (const access of ["folder", "web"] as const) {
      const own = agentFolder();
      const { files, text } = openCodePromptAttachments(
        AGENT,
        [att("shot.png", "image/png"), att("notes.md", "text/markdown")],
        { kind: "copy", folder: own },
      );
      expect({ access, files }).toEqual({ access, files: [] });
      const copyDir = join(own, "attachments");
      expect(readFileSync(join(copyDir, "notes.md"), "utf8")).toBe(
        "NOTES BODY\n",
      );
      expect(text).toContain(join(copyDir, "notes.md"));
      expect(text).toContain(join(copyDir, "shot.png"));
      expect(text).not.toContain(FILES_DIR);
    }
  });

  it("inline: every image as a data: URI, nothing else, and no text", () => {
    fixtures();
    expect(
      openCodePromptAttachments(
        AGENT,
        [att("notes.md", "text/markdown"), att("shot.png", "image/png")],
        { kind: "inline-images" },
      ),
    ).toEqual({
      files: [
        {
          uri: `data:image/png;base64,${PNG.toString("base64")}`,
          mime: "image/png",
          name: "shot.png",
        },
      ],
      text: null,
    });
  });
});

describe("OpenCode below Standard: the one-shot", () => {
  const ONE_SHOT = "one-shot-session";
  const frames = framesOf(ONE_SHOT);
  const topicTurn = (): FakeTurn => ({
    frames: [
      frames.delivered("INBOX"),
      frames.stepStarted("msg_topic"),
      frames.textDelta("msg_topic", "Topic label"),
      frames.textEnded("msg_topic", "Topic label"),
      frames.stepEnded("msg_topic"),
      frames.succeeded(),
    ] as Frame[],
    session: ONE_SHOT,
    inbox: "INBOX",
  });

  // The prompt holds the agent's conversation, strangers' text included:
  // no tool, no MCP server, on the limited server, in an empty folder.
  it("runs as the chat agent with no tool, on the limited server, in an empty folder, with no MCP server", async () => {
    for (const access of BELOW) {
      let emptyAtCreate = null as boolean | null;
      const h = await harness({
        sessionId: ONE_SHOT,
        nextSessionId: () => ONE_SHOT,
        turns: [topicTurn()],
        override: (route) => {
          if (route === "session.create")
            emptyAtCreate =
              existsSync(OPENCODE_LIMITED_ONE_SHOT_DIR) &&
              readdirSync(OPENCODE_LIMITED_ONE_SHOT_DIR).length === 0;
          return undefined;
        },
      });
      const result = await h.backend.oneShotPrompt("label", {
        cwd: "/srv/member-repo",
        modelFamily: "gate/free",
        environmentKey: MEMBER_KEY,
        env: { PATH: "/usr/bin" },
        access,
      });
      expect({ access, result }).toEqual({ access, result: "Topic label" });
      expect({
        access,
        keys: [...new Set(h.routed.map((r) => r.key))],
        flag: h.routed[0]?.env?.OPENCODE_DISABLE_PROJECT_CONFIG,
      }).toEqual({
        access,
        keys: [openCodeProfileKey(MEMBER_KEY, access)],
        flag: "1",
      });
      expect({
        access,
        create: h.fake.calls("POST", /^\/api\/session$/).map((r) => r.body),
      }).toEqual({
        access,
        create: [
          expect.objectContaining({
            agent: "isomux-chat",
            permissions: openCodeStopRules("chat", []),
            location: { directory: OPENCODE_LIMITED_ONE_SHOT_DIR },
          }),
        ],
      });
      expect({ access, emptyAtCreate }).toEqual({
        access,
        emptyAtCreate: true,
      });
      expect({
        access,
        puts: h.fake.calls("PUT", /^\/api\/experimental\/mcp\//).length,
      }).toEqual({ access, puts: 0 });
      expect({
        access,
        agents: h.fake.promptLog.map((p) => p.agent),
      }).toEqual({ access, agents: ["isomux-chat"] });
    }
  });

  it("refuses with no prompt when a check fails", async () => {
    const h = await harness({
      sessionId: ONE_SHOT,
      nextSessionId: () => ONE_SHOT,
      turns: [topicTurn()],
      config: () =>
        limitedConfig({}, [
          { type: "document", path: "/srv/repo/opencode.json", info: {} },
        ]),
    });
    const error = await h.backend
      .oneShotPrompt("label", {
        cwd: "/srv/member-repo",
        modelFamily: "gate/free",
        environmentKey: MEMBER_KEY,
        env: {},
        access: "office",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(h.fake.prompts()).toBe(0);
  });
});

// A session lives on the side of the Standard line its agent last ran at
// (session-transfer.ts). The start on the other side moves it first, and a
// read goes to the side that holds it.
describe("OpenCode below Standard: a session across the Standard line", () => {
  afterEach(cleanUpProfileFixtures);
  const crossings = [
    ["chat", "standard"],
    ["office", "standard"],
    ["folder", "standard"],
    ["web", "standard"],
    ["standard", "chat"],
  ] as const;

  it("moves a resumed session from the other side before its turn, at every stop", async () => {
    for (const [access, other] of crossings) {
      const cli = fakeCli();
      const sessionId = `ses_cross_${access}`;
      profile(openCodeProfileKey(MEMBER_KEY, other), {
        [sessionId]: "durable",
      });
      const h = await harness({
        sessionId,
        messages: () => [{ id: "msg_1" }],
      });
      const { sent } = await sendOnce(
        h.backend.resumeSession(
          sessionId,
          sessionOpts(access, newAgentId(), agentFolder()),
        ),
        h.fake,
      );
      expect({
        access,
        sent,
        exported: cli.exports.map((e) => e.sessionId),
        imports: cli.imports.length,
        keys: [...new Set(h.routed.map((r) => r.key))].sort(),
      }).toEqual({
        access,
        sent: true,
        exported: [sessionId],
        imports: 1,
        keys: [MEMBER_KEY, openCodeProfileKey(MEMBER_KEY, "chat")].sort(),
      });
      cleanUpProfileFixtures();
    }
  });

  it("refuses the turn, with no prompt, when the move fails", async () => {
    for (const [access, other] of crossings) {
      fakeCli({
        exportSession: () => Promise.reject(new Error("export broke")),
      });
      const sessionId = `ses_cross_fail_${access}`;
      profile(openCodeProfileKey(MEMBER_KEY, other), {
        [sessionId]: "durable",
      });
      const h = await harness({ sessionId, messages: () => [{ id: "msg_1" }] });
      const { sent } = await sendOnce(
        h.backend.resumeSession(
          sessionId,
          sessionOpts(access, newAgentId(), agentFolder()),
        ),
        h.fake,
      );
      expect({ access, sent }).toEqual({ access, sent: false });
      cleanUpProfileFixtures();
    }
  });

  it("reads a session's messages from the side that holds it", async () => {
    for (const [access, other] of crossings) {
      for (const held of [access, other]) {
        const sessionId = `ses_read_${access}_${held}`;
        profile(openCodeProfileKey(MEMBER_KEY, held), {
          [sessionId]: "durable",
        });
        const h = await harness({ sessionId });
        const id = newAgentId();
        const folder = agentFolder();
        await h.backend.getSessionMessages(sessionId, folder, {
          ...sessionOpts(access, id, folder),
          cwd: folder,
        });
        expect({ access, held, key: h.routed.at(-1)?.key }).toEqual({
          access,
          held,
          key: openCodeProfileKey(MEMBER_KEY, held),
        });
        cleanUpProfileFixtures();
      }
    }
  });
});
