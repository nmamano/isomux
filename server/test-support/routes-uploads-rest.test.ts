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
//   - Both are USER/browser surfaces: an AGENT token is 403 (lacks the caps).
//   - The legacy /api/upload + /api/files + /api/images keep their old paths -
//     no collision - and apply the room check too (a miss and a denial are the
//     same 404). A killed agent's files follow its last room, or office owners
//     once that room is gone; cronjob-run files follow cron:read.
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
import {
  cronjobRunStreamId,
  type AgentInfo,
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
    const owner = await srv.seedOwner("Boss");
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

  it("a member WITH a room grant can upload + getFile (access-by-grant, not just owner-rule)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    // Grant the member access to the agent's room.
    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });

    const up = await upload(
      srv,
      agent.id,
      [{ name: "m.txt", content: "mine" }],
      {
        rawSessionId: member.rawSessionId,
      },
    );
    expect(up.status).toBe(200);
    const fname = (
      (await up.json()).attachments as Array<{ filename: string }>
    )[0].filename;
    const got = await getFile(srv, agent.id, fname, {
      rawSessionId: member.rawSessionId,
    });
    expect(got.status).toBe(200);
  });

  it("a member WITHOUT access is 403 on BOTH upload and getFile (the [behavior-change])", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    // Seed a real file via the owner so getFile would otherwise resolve.
    const up = await upload(
      srv,
      agent.id,
      [{ name: "secret.txt", content: "s" }],
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    const fname = (
      (await up.json()).attachments as Array<{ filename: string }>
    )[0].filename;

    expect(
      (
        await upload(srv, agent.id, [{ name: "x.txt", content: "x" }], {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await getFile(srv, agent.id, fname, {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
  });
});

describe("routes/uploads REST: validation + resolver safety", () => {
  it("more than 5 files -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}.txt`,
      content: "x",
    }));
    const up = await upload(srv, agent.id, files, {
      rawSessionId: owner.rawSessionId,
    });
    expect(up.status).toBe(400);
  });

  it("unknown filename -> 404; path-traversal filename -> 404 (getFilePath is the only resolver)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
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

describe("routes/uploads REST: agent token is a 403 (browser surfaces)", () => {
  it("an AGENT token cannot upload or getFile (lacks file:upload / office:read)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    expect(
      (
        await upload(srv, agent.id, [{ name: "a.txt", content: "a" }], {
          bearer: token,
        })
      ).status,
    ).toBe(403);
    expect(
      (await getFile(srv, agent.id, "whatever.txt", { bearer: token })).status,
    ).toBe(403);
  });
});

describe("routes/uploads REST: legacy paths untouched (no collision)", () => {
  it("legacy /api/upload + /api/files + /api/images still serve with the old paths/auth", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);

    // Legacy upload: POST /api/upload/:agentId (cookie-walled, not /api/agents/...).
    const fd = new FormData();
    fd.append("file", new File(["legacy"], "leg.txt", { type: "text/plain" }));
    const up = await srv.http(`/api/upload/${agent.id}`, {
      method: "POST",
      body: fd,
      rawSessionId: owner.rawSessionId,
    });
    expect(up.status).toBe(200);
    const fname = (
      (await up.json()).attachments as Array<{ filename: string }>
    )[0].filename;

    // Legacy serve: /api/files/:agentId/:filename and the /api/images alias.
    const f = await srv.http(`/api/files/${agent.id}/${fname}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(f.status).toBe(200);
    expect(await f.text()).toBe("legacy");
    const img = await srv.http(`/api/images/${agent.id}/${fname}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(img.status).toBe(200);
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
    const owner = await srv.seedOwner("Boss");
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
  it("a member without access gets the same 404 as a miss; a grant opens it", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const att = saveFile(agent.id, Buffer.from("s"), "text/plain", "s.txt")!;

    const legacyPaths = (name: string) => [
      `/api/files/${agent.id}/${name}`,
      `/api/images/${agent.id}/${name}`,
    ];
    for (const path of legacyPaths(att.filename)) {
      const denied = await srv.http(path, {
        rawSessionId: member.rawSessionId,
      });
      expect(denied.status).toBe(404);
    }
    for (const path of legacyPaths("missing.txt")) {
      const miss = await srv.http(path, { rawSessionId: member.rawSessionId });
      expect(miss.status).toBe(404);
    }

    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });
    for (const path of legacyPaths(att.filename)) {
      const got = await srv.http(path, { rawSessionId: member.rawSessionId });
      expect(got.status).toBe(200);
      expect(await got.text()).toBe("s");
    }
  });

  it("an unknown agent id is a 404 even when its files dir exists", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const att = saveFile("agent-gone", Buffer.from("x"), "text/plain", "x.txt")!;
    const res = await srv.http(`/api/files/agent-gone/${att.filename}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
  });

  it("a cronjob run's files follow cron:read: a member reads them, an ordinary agent does not", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory"); // allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const stream = cronjobRunStreamId("run1");
    const att = saveFile(stream, Buffer.from("r"), "text/plain", "r.txt")!;
    const path = `/api/files/${stream}/${att.filename}`;

    const got = await srv.http(path, { rawSessionId: member.rawSessionId });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("r");
    expectSandboxed(got);

    const byAgent = await srv.http(path, {
      headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)!}` },
    });
    expect(byAgent.status).toBe(404);
  });
});

describe("routes/uploads REST: a killed agent's files follow its last room", () => {
  it("a member with the room's grant reads them; one without does not", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
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
    expect(denied.status).toBe(404);
  });

  it("once that room is gone, only office owners read them", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Grace");
    const roomId = srv.agentManager.createRoom("Lab");
    const agent = await spawnAgent(srv, "Worker", roomId);
    // The grant outlives the room, so it must not be what decides.
    updateUserById(getUserByName("Grace")!.id, { allowedRooms: [roomId] });
    const att = saveFile(agent.id, Buffer.from("k"), "text/plain", "k.txt")!;
    await srv.agentManager.kill(agent.id);
    expect(srv.agentManager.closeRoom(roomId)).toBe(true);
    const path = `/api/files/${agent.id}/${att.filename}`;

    const denied = await srv.http(path, { rawSessionId: member.rawSessionId });
    expect(denied.status).toBe(404);
    const got = await srv.http(path, { rawSessionId: owner.rawSessionId });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("k");
  });
});

describe("routes/uploads REST: legacy /api/upload follows room access", () => {
  it("a member without access gets the unknown-agent 404; a grant opens it", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
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
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());

    updateUserById(getUserByName("Mallory")!.id, { allowedRooms: [room.id] });
    const allowed = await legacyUpload();
    expect(allowed.status).toBe(200);
    expect(
      ((await allowed.json()).attachments as unknown[]).length,
    ).toBe(1);
  });
});
