// Phase 3a slice 3a.3b - uploads + file-serving on the unified REST surface
// (opIds agents.upload / agents.getFile).
//
// What this freezes:
//   - agents.upload (POST /api/agents/:id/uploads, file:upload + room access):
//     multipart, ≤5 files / 200MB each / 400MB total (Nil-confirmed), persists via
//     saveFile, returns { attachments }.
//   - agents.getFile (GET /api/agents/:id/files/:filename, office:read + room
//     access) is a [behavior-change]: room-ACL-gated, where legacy /api/files was
//     public-to-authenticated. Access-by-grant works; absence of access is a 403.
//   - getFilePath stays the only resolver: path traversal -> 404.
//   - Both are USER/browser surfaces: an AGENT token lacks the caps
//     (identity-tokens.test.ts pins the AGENT set, routes-table.test.ts the
//     route caps).
//   - The legacy /api/upload + /api/files + /api/images keep their old paths -
//     no collision - and apply the room check too (a miss and a denial are the
//     same 404). A killed agent's files follow its last room, or office owners
//     once that room is gone; cronjob-run files follow the job's visibility.
//   - Every file response carries the sandbox headers, so an opened HTML or
//     SVG file runs in an opaque origin, not as office content, and a private
//     cache header, so no shared cache stores it.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { saveFile } from "../persistence.ts";
import { saveRuns } from "../cronjob-persistence.ts";
import {
  cronjobRunStreamId,
  type AgentInfo,
  type CronjobRun,
  type LogEntry,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
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
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

interface UpOpts {
  rawSessionId?: string;
  bearer?: string;
}
async function upload(
  srv: TestServer,
  agentId: string,
  files: { name: string; content: string }[],
  opts: UpOpts,
): Promise<Response> {
  const fd = new FormData();
  for (const f of files) {
    fd.append("file", new File([f.content], f.name, { type: "text/plain" }));
  }
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  // No Content-Type: fetch sets multipart/form-data + boundary.
  return srv.http(`/api/agents/${agentId}/uploads`, {
    method: "POST",
    body: fd,
    headers,
    rawSessionId: opts.rawSessionId,
  });
}
function getFile(
  srv: TestServer,
  agentId: string,
  filename: string,
  opts: UpOpts,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return srv.http(`/api/agents/${agentId}/files/${filename}`, {
    headers,
    rawSessionId: opts.rawSessionId,
  });
}

describe("routes/uploads REST: upload + getFile happy path + room-ACL", () => {
  it("owner uploads, then getFile serves the bytes with a private cache header", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);

    const up = await upload(
      srv,
      agent.id,
      [{ name: "note.txt", content: "hello" }],
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(up.status).toBe(200);
    const attachments = (await up.json()).attachments as Array<{
      filename: string;
      originalName: string;
      size: number;
    }>;
    expect(attachments.length).toBe(1);
    expect(attachments[0].originalName).toBe("note.txt");

    const got = await getFile(srv, agent.id, attachments[0].filename, {
      rawSessionId: owner.rawSessionId,
    });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("hello");
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("a member without access is 403 on upload and getFile; a room grant opens both", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    // Seed a real file via the owner so getFile would otherwise resolve.
    const up = await upload(
      srv,
      agent.id,
      [{ name: "secret.txt", content: "s" }],
      { rawSessionId: owner.rawSessionId },
    );
    const fname = (
      (await up.json()).attachments as Array<{ filename: string }>
    )[0].filename;
    const asMember = { rawSessionId: member.rawSessionId };

    expect(
      (await upload(srv, agent.id, [{ name: "x.txt", content: "x" }], asMember))
        .status,
    ).toBe(403);
    expect((await getFile(srv, agent.id, fname, asMember)).status).toBe(403);

    // Access by grant, not just the owner rule.
    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });
    const mine = await upload(
      srv,
      agent.id,
      [{ name: "m.txt", content: "mine" }],
      asMember,
    );
    expect(mine.status).toBe(200);
    const mineName = (
      (await mine.json()).attachments as Array<{ filename: string }>
    )[0].filename;
    const got = await getFile(srv, agent.id, mineName, asMember);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("mine");
  });
});

describe("routes/uploads REST: resolver safety", () => {
  it("unknown filename -> 404; path-traversal filename -> 404 (getFilePath is the only resolver)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    expect(
      (
        await getFile(srv, agent.id, "missing.txt", {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(404);
    // Encoded slash decodes to "../secret" in the :filename param -> getFilePath
    // rejects it (contains a separator) -> 404. Never escapes the files/ dir.
    const traversal = await getFile(srv, agent.id, "..%2Fsecret", {
      rawSessionId: owner.rawSessionId,
    });
    expect(traversal.status).toBe(404);
  });
});

// The browser must give an opened file an opaque origin (sandbox without
// allow-same-origin) and must not reinterpret its type (nosniff).
function expectSandboxed(res: Response): void {
  const csp = res.headers.get("content-security-policy") ?? "";
  const directives = csp.split(";").map((d) => d.trim().split(/\s+/));
  const sandbox = directives.filter((d) => d[0] === "sandbox");
  expect(sandbox).toEqual([["sandbox", "allow-scripts"]]);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
}

describe("routes/uploads REST: agent files cannot run as office content", () => {
  it("a file planted through read-file is served sandboxed on every file route, and SVG renders as an image", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const sock = await srv.connectWs(owner.rawSessionId);

    const html = "<script>fetch('/api/agents')</script>";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
    writeFileSync(join(srv.stateRoot, "evil.html"), html);
    writeFileSync(join(srv.stateRoot, "pic.svg"), svg);
    const planted: Record<string, string> = {};
    for (const name of ["evil.html", "pic.svg"]) {
      const r = await srv.http(`/api/agents/${agent.id}/read-file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ path: name }),
      });
      expect(r.status).toBe(200);
    }
    const deadline = Date.now() + 2000;
    while (Object.keys(planted).length < 2 && Date.now() < deadline) {
      for (const m of sock.messages as {
        type?: string;
        entry?: LogEntry;
      }[]) {
        const att = m.entry?.kind === "file-view" && m.entry.attachments?.[0];
        if (m.type === "log_entry" && att)
          planted[att.originalName] = att.mediaType;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // An image/* media type is what makes the chat render it inline (<img>).
    expect(planted).toEqual({
      "evil.html": "text/html",
      "pic.svg": "image/svg+xml",
    });

    for (const path of [
      `/api/files/${agent.id}/evil.html`,
      `/api/images/${agent.id}/evil.html`,
      `/api/agents/${agent.id}/files/evil.html`,
    ]) {
      const res = await srv.http(path, { rawSessionId: owner.rawSessionId });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(await res.text()).toBe(html);
      expectSandboxed(res);
    }
    const pic = await srv.http(`/api/files/${agent.id}/pic.svg`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(pic.headers.get("content-type")).toBe("image/svg+xml");
    expectSandboxed(pic);
  });
});

describe("routes/uploads REST: legacy /api/files + /api/images follow room access", () => {
  it("a member without access is refused whether or not the file exists; a grant opens it", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const att = saveFile(agent.id, Buffer.from("s"), "text/plain", "s.txt")!;

    const legacyPaths = (name: string) => [
      `/api/files/${agent.id}/${name}`,
      `/api/images/${agent.id}/${name}`,
    ];
    // A denial does not show whether the file exists: both answers are the
    // same refusal.
    for (const name of [att.filename, "missing.txt"]) {
      for (const path of legacyPaths(name)) {
        const denied = await srv.http(path, {
          rawSessionId: member.rawSessionId,
        });
        expect(denied.status).toBe(403);
        expect((await denied.json()).error.code).toBe("forbidden");
      }
    }

    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });
    for (const path of legacyPaths(att.filename)) {
      const got = await srv.http(path, { rawSessionId: member.rawSessionId });
      expect(got.status).toBe(200);
      expect(await got.text()).toBe("s");
    }
    // With access, a miss is a miss.
    for (const path of legacyPaths("missing.txt")) {
      const miss = await srv.http(path, { rawSessionId: member.rawSessionId });
      expect(miss.status).toBe(404);
    }
  });

  it("an unknown agent id is refused like a denial, even when its files dir exists", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const att = saveFile(
      "agent-gone",
      Buffer.from("x"),
      "text/plain",
      "x.txt",
    )!;
    const res = await srv.http(`/api/files/agent-gone/${att.filename}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("a cronjob run's files follow the job's room: a member of it reads them; another member and an ordinary agent do not", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const granted = await srv.seedMember("Grace");
    const other = await srv.seedMember("Mallory"); // allowedRooms []
    const roomId = srv.agentManager.createRoom("Lab");
    updateUserById(getUserByName("Grace")!.id, { allowedRooms: [roomId] });
    const agent = await spawnAgent(srv, "Worker", roomId);
    const job = srv.cronjobManager.addCronjob({
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Morgan",
      userId: getUserByName("Morgan")!.id,
      roomId,
    });
    saveRuns(job.id, [
      { id: "run1", cronjobId: job.id, startedAt: 1 } as unknown as CronjobRun,
    ]);
    const stream = cronjobRunStreamId("run1");
    const att = saveFile(stream, Buffer.from("r"), "text/plain", "r.txt")!;
    const path = `/api/files/${stream}/${att.filename}`;

    const got = await srv.http(path, { rawSessionId: granted.rawSessionId });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("r");
    expectSandboxed(got);

    const denied = await srv.http(path, { rawSessionId: other.rawSessionId });
    expect(denied.status).toBe(403);
    const byAgent = await srv.http(path, {
      headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)!}` },
    });
    expect(byAgent.status).toBe(403);
  });
});

describe("routes/uploads REST: a killed agent's files follow its last room", () => {
  it("a member with the room's grant reads them and one without does not; once the room is gone, only office owners do", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const granted = await srv.seedMember("Grace");
    const other = await srv.seedMember("Mallory"); // allowedRooms []
    const roomId = srv.agentManager.createRoom("Lab");
    const agent = await spawnAgent(srv, "Worker", roomId);
    updateUserById(getUserByName("Grace")!.id, { allowedRooms: [roomId] });
    const att = saveFile(agent.id, Buffer.from("k"), "text/plain", "k.txt")!;
    await srv.agentManager.kill(agent.id);
    const path = `/api/files/${agent.id}/${att.filename}`;

    const got = await srv.http(path, { rawSessionId: granted.rawSessionId });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("k");
    expectSandboxed(got);
    const denied = await srv.http(path, { rawSessionId: other.rawSessionId });
    expect(denied.status).toBe(403);

    // The grant outlives the room, so it must not be what decides.
    expect(srv.agentManager.closeRoom(roomId)).toBe(true);
    const gone = await srv.http(path, { rawSessionId: granted.rawSessionId });
    expect(gone.status).toBe(403);
    const ownerRead = await srv.http(path, {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.text()).toBe("k");
  });
});

describe("routes/uploads REST: legacy /api/upload follows room access", () => {
  it("a member without access gets the unknown-agent refusal; a grant opens it", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const legacyUpload = async (): Promise<Response> => {
      const fd = new FormData();
      fd.append("file", new File(["u"], "u.txt", { type: "text/plain" }));
      return srv.http(`/api/upload/${agent.id}`, {
        method: "POST",
        body: fd,
        rawSessionId: member.rawSessionId,
      });
    };
    const unknown = await srv.http("/api/upload/agent-unknown", {
      method: "POST",
      body: new FormData(),
      rawSessionId: member.rawSessionId,
    });

    const denied = await legacyUpload();
    expect(unknown.status).toBe(403);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(await unknown.json());

    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });
    const allowed = await legacyUpload();
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()).attachments as unknown[]).length).toBe(1);
  });

  // Reading follows a killed agent's last room and a run's job, but an upload
  // goes to a live agent only: nobody can attach a file to a chat that has
  // ended.
  it("refuses an upload to a killed agent or a cronjob run, even for an office owner", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const job = srv.cronjobManager.addCronjob({
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Morgan",
      userId: getUserByName("Morgan")!.id,
      roomId: room.id,
    });
    saveRuns(job.id, [
      { id: "run1", cronjobId: job.id, startedAt: 1 } as unknown as CronjobRun,
    ]);
    const upload = async (id: string): Promise<Response> => {
      const fd = new FormData();
      fd.append("file", new File(["u"], "u.txt", { type: "text/plain" }));
      return srv.http(`/api/upload/${id}`, {
        method: "POST",
        body: fd,
        rawSessionId: owner.rawSessionId,
      });
    };
    // The enabling condition: the owner uploads to the live agent, and reads
    // the run's and (below) the killed agent's files.
    expect((await upload(agent.id)).status).toBe(200);
    const unknown = await upload("agent-unknown");
    expect(unknown.status).toBe(403);
    const unknownBody = await unknown.json();

    const stream = cronjobRunStreamId("run1");
    const runFile = saveFile(stream, Buffer.from("r"), "text/plain", "r.txt")!;
    expect(
      (
        await srv.http(`/api/files/${stream}/${runFile.filename}`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
    const run = await upload(stream);
    expect(run.status).toBe(403);
    expect(await run.json()).toEqual(unknownBody);

    const att = saveFile(agent.id, Buffer.from("k"), "text/plain", "k.txt")!;
    await srv.agentManager.kill(agent.id);
    const read = await srv.http(`/api/files/${agent.id}/${att.filename}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(read.status).toBe(200);
    const killed = await upload(agent.id);
    expect(killed.status).toBe(403);
    expect(await killed.json()).toEqual(unknownBody);
  });
});
it("audits each saved multipart file when the sixth file is rejected, including legacy uploads", async () => {
  const { officeAuditStore } = await import("../audit-store.ts");
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("UploadAuditor");
  const agent = await spawnAgent(
    srv,
    "UploadAgent",
    srv.agentManager.getRooms()[0].id,
  );
  for (const [path, operation] of [
    [`/api/agents/${agent.id}/uploads`, "agents.upload"],
    [`/api/upload/${agent.id}`, "chatFiles.upload"],
  ]) {
    const form = new FormData();
    for (let n = 0; n < 6; n++)
      form.append(
        "file",
        new File([`file-${operation}-${n}`], `file-${n}.txt`),
      );
    const response = await srv.http(path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: form,
    });
    expect(response.status).toBe(400);
    const rows = officeAuditStore().list({ operation }).items;
    expect(rows).toHaveLength(5);
    expect(
      rows.every(
        (row) =>
          row.actor.kind === "member" && row.actor.name === "UploadAuditor",
      ),
    ).toBe(true);
    expect(rows.every((row) => row.fields.length === 0)).toBe(true);
    const fileIds = rows.flatMap((row) =>
      row.targets.filter((target) => target.startsWith(agent.id + "/")),
    );
    expect(new Set(fileIds).size).toBe(5);
  }
});
