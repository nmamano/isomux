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
//   - The legacy /api/upload + /api/files + /api/images keep their old paths and
//     old auth posture - no collision, no accidental tightening.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo } from "../../shared/types.ts";

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
  it("owner uploads, then getFile serves the bytes with the immutable cache header", async () => {
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
    expect(got.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
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
