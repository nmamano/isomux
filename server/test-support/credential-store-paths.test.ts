// The credential directories (secrets/, user-env/, office-env/, mcp-servers/)
// and the paths that read or write a file by path: the editor, read-file (agent and
// scheduled run), validate.env, the safety hooks and the browser upload. Each
// refuses them, through a symlink or ".." too, and none returns a value.
// Accident protection, not a boundary: see server/credential-store-paths.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { STATE_ROOT } from "../config.ts";
import { isCredentialStorePath } from "../credential-store-paths.ts";
import { evaluateProposedAction } from "../safety-policy.ts";
import { BrowserUploadError, readBrowserUpload } from "../browser-upload.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { FakeBackend } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type { AgentInfo } from "../../shared/types.ts";

const FAKE = "fake-secret-value-0000-paths";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// One file in each credential directory, a temp file, and a symlink and a
// ".." path that lead into the store.
function seedStore(root: string) {
  const store = join(root, "secrets", "office.json");
  const user = join(root, "secrets", "users", "u-test.json");
  const userEnv = join(root, "user-env", "u-test.env");
  const officeEnvTemp = join(root, "office-env", ".office.1.a.tmp");
  // A registered MCP server URL can carry a token in its path.
  const mcpServers = join(root, "mcp-servers", "users", "u-test.json");
  for (const path of [store, user, userEnv, officeEnvTemp, mcpServers])
    mkdirSync(join(path, ".."), { recursive: true });
  // A one-line JSON store holds no "=": a dotenv parser would quote it.
  writeFileSync(store, `{"secrets":[{"value":"${FAKE}"}]}`);
  writeFileSync(user, `{"secrets":[{"value":"${FAKE}"}]}`);
  writeFileSync(userEnv, `GH_TOKEN='${FAKE}'\n${FAKE}\n`);
  writeFileSync(officeEnvTemp, `${FAKE}\n`);
  writeFileSync(
    mcpServers,
    `{"servers":[{"url":"https://x.example.com/${FAKE}"}]}`,
  );
  const linkDir = join(root, "linked");
  mkdirSync(linkDir, { recursive: true });
  const link = join(linkDir, "store-link.json");
  if (!existsSync(link)) symlinkSync(store, link);
  const dirLink = join(linkDir, "secrets-dir");
  if (!existsSync(dirLink)) symlinkSync(join(root, "secrets"), dirLink);
  return {
    store,
    user,
    userEnv,
    officeEnvTemp,
    mcpServers,
    link,
    viaDirLink: join(dirLink, "office.json"),
    dotDot: join(root, "linked", "..", "secrets", "office.json"),
  };
}

describe("isCredentialStorePath", () => {
  it("matches the four directories, their temp files, symlinks and '..'", () => {
    const paths = seedStore(STATE_ROOT);
    for (const path of Object.values(paths))
      expect(isCredentialStorePath(path)).toBe(true);
    expect(isCredentialStorePath(join(STATE_ROOT, "secrets"))).toBe(true);
    expect(isCredentialStorePath(join(STATE_ROOT, "secrets", "new.json"))).toBe(
      true,
    );
    expect(isCredentialStorePath(join(STATE_ROOT, "pager.json"))).toBe(false);
    expect(isCredentialStorePath(join(STATE_ROOT, "secrets-old"))).toBe(false);
    expect(isCredentialStorePath("secrets/office.json")).toBe(false);
  });
});

describe("the safety hooks and the browser upload", () => {
  it("refuse agent reads of the credential directories", async () => {
    const paths = seedStore(STATE_ROOT);
    for (const path of Object.values(paths)) {
      expect(
        evaluateProposedAction(
          { kind: "read-files", toolName: "Read", input: { file_path: path } },
          { cwd: "/tmp" },
        ).decision,
      ).toBe("deny");
      expect(
        evaluateProposedAction(
          { kind: "shell", command: `cat ${path}` },
          { cwd: "/tmp" },
        ).decision,
      ).toBe("deny");
      const upload = await readBrowserUpload(path).then(
        () => null,
        (error: unknown) => error,
      );
      expect(upload).toBeInstanceOf(BrowserUploadError);
    }
    // A relative path, resolved against the agent's cwd.
    expect(
      evaluateProposedAction(
        { kind: "shell", command: "cat secrets/office.json" },
        { cwd: STATE_ROOT },
      ).decision,
    ).toBe("deny");
    expect(
      evaluateProposedAction(
        {
          kind: "read-files",
          toolName: "Read",
          input: { file_path: "user-env/u-test.env" },
        },
        { cwd: STATE_ROOT },
      ).decision,
    ).toBe("deny");
    // The forms an agent writes by hand: ~/.isomux, a symlink in the temp
    // directory, other readers and an input redirect, and a search tool
    // pointed at the store's directory.
    const tmpLink = join(mkdtempSync(join(tmpdir(), "store-link-")), "x.json");
    symlinkSync(paths.store, tmpLink);
    const denied = (action: Parameters<typeof evaluateProposedAction>[0]) =>
      evaluateProposedAction(action, { cwd: "/tmp" }).decision;
    for (const action of [
      {
        kind: "read-files" as const,
        toolName: "Read",
        input: { file_path: "~/.isomux/secrets/office.json" },
      },
      {
        kind: "read-files" as const,
        toolName: "Read",
        input: { file_path: tmpLink },
      },
      {
        kind: "read-files" as const,
        toolName: "Grep",
        input: { pattern: "value", path: join(STATE_ROOT, "secrets") },
      },
      {
        kind: "read-files" as const,
        toolName: "Glob",
        input: { pattern: "**/*.json", path: join(STATE_ROOT, "secrets") },
      },
      { kind: "shell" as const, command: `head -c 200 ${paths.store}` },
      { kind: "shell" as const, command: `cat < ${paths.store}` },
      {
        kind: "shell" as const,
        command: "cat ~/.isomux/secrets/users/u-test.json",
      },
      { kind: "shell" as const, command: `cat ${tmpLink}` },
    ])
      expect(denied(action)).toBe("deny");
    // Other state files keep today's rule.
    expect(
      evaluateProposedAction(
        {
          kind: "read-files",
          toolName: "Read",
          input: { file_path: join(STATE_ROOT, "pager.json") },
        },
        { cwd: "/tmp" },
      ).decision,
    ).toBe("allow");
  });
});

async function spawnAgent(srv: TestServer, roomId: string): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    "Worker",
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
  if (!info) throw new Error("spawn failed");
  return info;
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: {
    body?: unknown;
    session?: string;
    bearer?: string;
    connectionId?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.connectionId) headers["X-Isomux-Connection-Id"] = init.connectionId;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // No JSON body.
  }
  return { status: response.status, text, body };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe("routes that take a path", () => {
  it("the editor neither opens nor saves a credential file", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const agent = await spawnAgent(srv, room);
    const sock = await srv.connectWs(owner.rawSessionId);
    await sock.waitFor("session_context");
    const ctx = sock.messages.find(
      (m) => (m as { type?: string }).type === "session_context",
    ) as { context?: { connectionId?: string } };
    const connectionId = ctx.context?.connectionId ?? "";
    const paths = seedStore(srv.stateRoot);

    for (const path of Object.values(paths)) {
      const opened = await call(
        srv,
        "GET",
        `/api/agents/${agent.id}/file?path=${encodeURIComponent(path)}`,
        { session: owner.rawSessionId, connectionId },
      );
      expect(opened.status).toBe(403);
      expect((opened.body as { error: { code: string } }).error.code).toBe(
        "credential_path",
      );
      expect(opened.text).not.toContain(FAKE);

      const before = readFileSync(path, "utf8");
      const saved = await call(srv, "PUT", `/api/agents/${agent.id}/file`, {
        session: owner.rawSessionId,
        body: { path, content: "overwritten", expectedMtime: 0, force: true },
      });
      expect(saved.status).toBe(403);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    sock.close();
  });

  it("an agent's read-file refuses a credential file and copies nothing", async () => {
    server = await startTestServer();
    const srv = server;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const agent = await spawnAgent(srv, room);
    const token = getAgentTokenRaw(agent.id)!;
    const paths = seedStore(srv.stateRoot);

    for (const path of [...Object.values(paths), "secrets/office.json"]) {
      const res = await call(srv, "POST", `/api/agents/${agent.id}/read-file`, {
        bearer: token,
        body: { path },
      });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain(FAKE);
    }
    for (const file of filesUnder(join(srv.stateRoot, "logs")))
      expect(readFileSync(file).includes(Buffer.from(FAKE))).toBe(false);
  });

  it("validate.env quotes no line of a credential file", async () => {
    server = await startTestServer();
    const srv = server;
    const member = await srv.seedMember("Alice");
    await srv.seedOwner("Boss");
    const paths = seedStore(srv.stateRoot);
    for (const path of Object.values(paths)) {
      const res = await call(srv, "POST", "/api/validate/env", {
        session: member.rawSessionId,
        body: { scope: "user", username: "Alice", path },
      });
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(FAKE);
    }
  });
});

describe("a scheduled run's read-file", () => {
  it("refuses a credential file", async () => {
    const paths = seedStore(STATE_ROOT);
    const backend = new FakeBackend();
    const mgr = createCronjobManager({
      resolveBackend: () => backend,
      resolveEnv: () => ({}),
      resolveEnvironmentKey: () => "test-environment",
      resolveEnvironmentRevision: () => "test-revision",
      resolveUser: () => undefined,
      persistence: makeFakeCronPersistence(),
      renderMemoryForPrompt: () => null,
      clock: { now: () => Date.now() },
      // Nothing fires on its own: the test starts the run.
      scheduler: {
        setTimeout: (() => 0) as unknown as typeof setTimeout,
        clearTimeout: () => {},
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: () => {},
      },
    });
    const job = mgr.addCronjob({
      name: "ReadFileJob",
      schedule: { type: "interval", minutes: 60 },
      prompt: "read",
      cwd: STATE_ROOT,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Nil",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    try {
      for (const path of [...Object.values(paths), "secrets/office.json"])
        expect(mgr.emitCronjobRunReadFile(job.id, run.id, path)).toEqual({
          ok: false,
          status: 403,
          error: expect.any(String),
        });
      // The run itself is live: an ordinary file reads.
      writeFileSync(join(STATE_ROOT, "plain.txt"), "hello");
      expect(
        mgr.emitCronjobRunReadFile(
          job.id,
          run.id,
          join(STATE_ROOT, "plain.txt"),
        ),
      ).toEqual({ ok: true });
    } finally {
      backend.sessions.forEach((session) => session.close());
    }
  });
});
