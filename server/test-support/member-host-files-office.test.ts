// Slice 2a of task b94dfd25, through the office: each surface where an
// isolated member's agent names a file reads it through the member's host
// (internal-docs/member-os-user-design.md, section 1.4). The member host is
// the recording stand-in of member-host-fixture.ts, whose file calls are
// recorded here; the office reads with its own fs, which records nothing, so
// a surface that reads as the office leaves no call of the path.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentFs } from "../agent-host.ts";
import { sendFileRange, type FileReadInput } from "../file-read-range.ts";
import { createMember, getUserByName, updateUserById } from "../users.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import type { AgentInfo } from "../../shared/types.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 1,
]);

let iso: IsolatedMember | null = null;
let server: TestServer | null = null;
let dirs: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "member-files-office-"));
  dirs.push(d);
  return d;
}

function memberId(name: string): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const created = createMember(name, { role: "member" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

// "<op> <path>" for each file call of the member host. Its file-read entry
// runs the runner's own code in this process.
function recordFiles(member: IsolatedMember): string[] {
  const calls: string[] = [];
  const host = member.member.host as unknown as {
    fs: AgentFs;
    runEntryOut?: (name: string, input: unknown) => AsyncIterable<Uint8Array>;
  };
  const base = host.fs;
  host.fs = {
    ...base,
    stat: async (path) => {
      calls.push(`stat ${path}`);
      return base.stat(path);
    },
    readBytes: async (path, max) => {
      calls.push(`readBytes ${path}`);
      return base.readBytes(path, max);
    },
    writeText: async (path, text, options) => {
      calls.push(`writeText ${path}`);
      return base.writeText(path, text, options);
    },
  };
  host.runEntryOut = (name, input) => {
    if (name !== "file-read") throw new Error(`unexpected entry ${name}`);
    calls.push(`file-read ${(input as FileReadInput).path}`);
    return (async function* () {
      const chunks: Uint8Array[] = [];
      await sendFileRange(input as FileReadInput, (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      yield* chunks;
    })();
  };
  return calls;
}

async function office() {
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = (server = await startTestServer({ fakeBackend }));
  const owner = await srv.seedOwner("FilesMorgan");
  const room = srv.agentManager.getRooms()[0].id;
  const alice = memberId("FilesAlice");
  // Alice reaches the room, so an ask of her agent can be for her.
  if (!updateUserById(alice, { allowedRooms: [room] }).ok)
    throw new Error("allowedRooms");
  iso = await isolateMember(alice);
  const calls = recordFiles(iso);
  const cwd = folder();
  const agent = (await srv.agentManager.spawn(
    "Alice files",
    cwd,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    undefined,
    undefined,
    "FilesAlice",
    "claude",
    undefined,
    alice,
  )) as AgentInfo;
  if (!agent) throw new Error("spawn failed");
  return { srv, owner, room, alice, iso, calls, cwd, agent };
}

const reads = (calls: string[], path: string) =>
  calls.filter((c) => c.endsWith(` ${path}`)).map((c) => c.split(" ")[0]);

describe("an isolated member's agent names a file", () => {
  it("read-file and the ask's copy read it through the member's host", async () => {
    const o = await office();
    const path = join(o.cwd, "notes.txt");
    writeFileSync(path, "member notes");
    expect(
      await o.srv.agentManager.emitAgentReadFile(o.agent.id, path),
    ).toEqual({ ok: true });
    expect(reads(o.calls, path)).toEqual(["stat", "readBytes"]);
    const shown = o.srv.agentManager
      .getAgentLogs(o.agent.id)
      .flatMap((e) => e.attachments ?? []);
    expect(shown.map((a) => a.originalName)).toEqual(["notes.txt"]);
  });

  it("the editor's open, save and /isomux-edit go through the member's host, and ~ is the member's home", async () => {
    const o = await office();
    writeFileSync(join(o.iso.home, "home.txt"), "in the member's home");
    const opened = await o.srv.agentManager.openEditorFile(
      o.agent.id,
      "~/home.txt",
    );
    expect(opened.ok && opened.result.kind).toBe("ok");
    const path = join(o.iso.home, "home.txt");
    expect(reads(o.calls, path)).toEqual(["stat", "readBytes"]);
    const saved = await o.srv.agentManager.saveEditorFile(
      o.agent.id,
      "~/home.txt",
      "changed",
      0,
      undefined,
      true,
    );
    expect([saved?.kind, readFileSync(path, "utf8")]).toEqual([
      "ok",
      "changed",
    ]);
    expect(reads(o.calls, path).slice(2)).toContain("writeText");

    const edited = join(o.cwd, "edit.txt");
    writeFileSync(edited, "x");
    expect(
      await o.srv.agentManager.emitAgentEditRequest(o.agent.id, edited),
    ).toEqual({ ok: true });
    expect(reads(o.calls, edited)).toContain("readBytes");
    const slash = join(o.cwd, "slash.txt");
    writeFileSync(slash, "y");
    const res = await o.srv.http(`/api/agents/${o.agent.id}/messages`, {
      method: "POST",
      rawSessionId: o.owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `/isomux-edit ${slash}` }),
    });
    expect(res.status).toBe(200);
    const deadline = Date.now() + 3000;
    while (
      !reads(o.calls, slash).includes("readBytes") &&
      Date.now() < deadline
    )
      await Bun.sleep(20);
    expect(reads(o.calls, slash)).toContain("readBytes");
  });

  it("an ask probes an edit file, copies a read file and serves a video in place through the member's host, with a range", async () => {
    const o = await office();
    const token = mintAgentToken(o.agent.id, o.alice);
    writeFileSync(join(o.cwd, "plot.txt"), "copied");
    writeFileSync(join(o.cwd, "clip.mp4"), "0123456789");
    writeFileSync(join(o.cwd, "edit.txt"), "to edit");
    const res = await o.srv.http(`/api/agents/${o.agent.id}/asks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Look?",
        readFiles: ["plot.txt", "clip.mp4"],
        editFiles: ["edit.txt"],
      }),
    });
    const created = await res.json();
    expect([res.status, created]).toMatchObject([201, {}]);
    const ask = created as {
      id: string;
      readFiles: { filename: string; path?: string }[];
    };
    expect(reads(o.calls, join(o.cwd, "plot.txt"))).toEqual([
      "stat",
      "readBytes",
    ]);
    expect(reads(o.calls, join(o.cwd, "edit.txt"))).toEqual([
      "stat",
      "readBytes",
    ]);
    const clip = ask.readFiles.find((f) => f.path === join(o.cwd, "clip.mp4"))!;
    // The condition: the video is referenced in place, not copied.
    expect(clip).toBeDefined();
    const got = await o.srv.http(`/api/asks/${ask.id}/files/${clip.filename}`, {
      method: "GET",
      rawSessionId: o.owner.rawSessionId,
      headers: { Range: "bytes=3-5" },
    });
    expect([got.status, await got.text()]).toEqual([206, "345"]);
    expect(reads(o.calls, join(o.cwd, "clip.mp4"))).toContain("file-read");
  });

  it("an app thumbnail by path reads through the member's host", async () => {
    const o = await office();
    const token = mintAgentToken(o.agent.id, o.alice);
    const reg = await o.srv.http("/api/apps", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "alice-app",
        command: "bun run serve.ts",
        cwd: o.cwd,
      }),
    });
    expect(reg.status).toBe(201);
    const path = join(o.cwd, "shot.png");
    writeFileSync(path, PNG);
    const put = await o.srv.http("/api/apps/alice-app/thumbnail", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    });
    expect(put.status).toBe(200);
    expect(reads(o.calls, path)).toEqual(["readBytes"]);
  });

  it("a scheduled run's read-file reads through the member's host", async () => {
    const o = await office();
    const fake = new FakeBackend();
    const mgr = createCronjobManager({
      resolveBackend: () => fake,
      resolveEnv: buildEnvForUserId,
      resolveEnvironmentKey: () => "files-environment",
      resolveEnvironmentRevision: () => "files-revision",
      resolveUser: () => undefined,
      persistence: makeFakeCronPersistence(),
      clock: { now: () => Date.now() },
      scheduler: {
        setTimeout: (() => 0) as unknown as typeof setTimeout,
        clearTimeout: () => {},
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: () => {},
      },
      renderMemoryForPrompt: () => null,
    });
    const job = mgr.addCronjob({
      name: "AliceFilesJob",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd: o.cwd,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "FilesAlice",
      userId: o.alice,
    });
    const run = mgr.runCronjobNow(job.id, "FilesAlice");
    expect(run).not.toBeNull();
    try {
      const deadline = Date.now() + 3000;
      while (fake.lastSession === undefined && Date.now() < deadline)
        await Bun.sleep(10);
      const path = join(o.cwd, "run.txt");
      writeFileSync(path, "run notes");
      expect(await mgr.emitCronjobRunReadFile(job.id, run!.id, path)).toEqual({
        ok: true,
      });
      expect(reads(o.calls, path)).toEqual(["stat", "readBytes"]);
    } finally {
      fake.sessions.forEach((s) => s.close());
    }
  });
});
