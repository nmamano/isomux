// App thumbnails and the archive flag on the REST surface (opIds
// apps.{setThumbnail,getThumbnail,archive,unarchive}). The handler-level
// races (an upload that outlives its registration, a registry write that
// fails after the file landed) are pinned with injected deps at the bottom,
// where the timing can be forced.
//
// Seam: startTestServer() with the fake app supervisor. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { UNKNOWN_RUNTIME, type AppRuntime } from "../app-supervisor.ts";
import { createAppMessageLimiter } from "../app-message-limits.ts";
import {
  MAX_APP_THUMBNAIL_BYTES,
  createAppThumbnailStore,
  readCappedBody,
  readCappedFile,
  sniffAppThumbnailType,
} from "../app-thumbnails.ts";
import { resolveEditorPath } from "../file-editor.ts";
import type { AppWire } from "../../shared/contract-shapes.ts";
import type { AgentInfo, AppListWire, AppRecord } from "../../shared/types.ts";
import { appsHandlers, type AppsDeps } from "../routes/handlers/apps.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";

let server: TestServer | null = null;
const tmpDirs: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true });
});

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 1,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 2]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 3,
]);

interface Res {
  status: number;
  body: unknown;
}

async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    json?: unknown;
    raw?: Uint8Array<ArrayBuffer>;
    contentType?: string;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  if (init.contentType) headers["Content-Type"] = init.contentType;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.raw !== undefined ? { body: init.raw } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (r: Res): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// An office with an owner, a member who can see the app (room access) and a
// member who cannot, and one app registered by the owner's agent.
async function seed() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const viewer = await srv.seedMember("Viewer");
  const outsider = await srv.seedMember("Outsider");
  const bot = await spawnAgent(srv, "AppBot");
  expect(
    updateUserById(getUserByName("Viewer")!.id, { allowedRooms: [bot.roomId] })
      .ok,
  ).toBe(true);
  expect(
    updateUserById(getUserByName("Outsider")!.id, { allowedRooms: [] }).ok,
  ).toBe(true);
  const token = mintAgentToken(bot.id, getUserByName("Boss")!.id);
  const reg = await api(srv, "/api/apps", {
    method: "POST",
    bearer: token,
    json: { name: "hello", command: "bun run serve.ts", cwd: srv.stateRoot },
  });
  expect(reg.status).toBe(201);
  return { srv, owner, viewer, outsider, token };
}

const thumbDir = () => join(STATE_ROOT, "apps", "thumbnails", "hello");

async function getThumb(
  srv: TestServer,
  rawSessionId: string,
  query = "",
): Promise<Response> {
  return srv.http(`/api/apps/hello/thumbnail${query}`, { rawSessionId });
}

describe("routes/apps REST: thumbnails", () => {
  it("the app's agent uploads a PNG and every viewer is served the same bytes", async () => {
    const { srv, owner, viewer, token } = await seed();
    const put = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
      contentType: "image/png",
    });
    expect(put.status).toBe(200);
    const version = (put.body as AppWire).thumbnailUpdatedAt;
    expect(typeof version).toBe("number");

    for (const who of [owner, viewer]) {
      const res = await getThumb(srv, who.rawSessionId, `?v=${version}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
        Array.from(PNG),
      );
    }
    // The list tells a viewer the version too, so its page can build the URL.
    const list = await api(srv, "/api/apps", {
      rawSessionId: viewer.rawSessionId,
    });
    expect((list.body as AppListWire[])[0]).toMatchObject({
      canManage: false,
      thumbnailUpdatedAt: version,
    });
  });

  it("caches for good only the current version", async () => {
    const { srv, owner, token } = await seed();
    const put = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    const version = (put.body as AppWire).thumbnailUpdatedAt!;
    for (const query of ["", `?v=${version - 1}`, "?v=banana"]) {
      const res = await getThumb(srv, owner.rawSessionId, query);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    }
  });

  it("the bytes decide the type, whatever Content-Type says", async () => {
    const { srv, owner, token } = await seed();
    for (const [image, type, declared] of [
      [JPEG, "image/jpeg", "image/png"],
      [WEBP, "image/webp", undefined],
      [PNG, "image/png", "application/octet-stream"],
    ] as const) {
      const put = await api(srv, "/api/apps/hello/thumbnail", {
        method: "PUT",
        bearer: token,
        raw: image,
        ...(declared ? { contentType: declared } : {}),
      });
      expect(put.status).toBe(200);
      const res = await getThumb(srv, owner.rawSessionId);
      expect(res.headers.get("content-type")).toBe(type);
    }
    const text = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: new TextEncoder().encode("<svg onload=alert(1)>"),
      contentType: "image/png",
    });
    expect(text.status).toBe(415);
    expect(errCode(text)).toBe("unsupported_image");
    const empty = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: new Uint8Array(0),
    });
    expect(empty.status).toBe(400);
  });

  it("refuses an image over 2 MB and keeps the one it had", async () => {
    const { srv, owner, token } = await seed();
    const first = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    const big = new Uint8Array(MAX_APP_THUMBNAIL_BYTES + 1);
    big.set(PNG);
    const res = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: big,
    });
    expect(res.status).toBe(413);
    const after = await api(srv, "/api/apps/hello", {
      rawSessionId: owner.rawSessionId,
    });
    expect((after.body as AppWire).thumbnailUpdatedAt).toBe(
      (first.body as AppWire).thumbnailUpdatedAt,
    );
  });

  it("a replacement gets a newer version and the old file goes", async () => {
    const { srv, token } = await seed();
    const a = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    const b = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: JPEG,
    });
    const va = (a.body as AppWire).thumbnailUpdatedAt!;
    const vb = (b.body as AppWire).thumbnailUpdatedAt!;
    expect(vb).toBeGreaterThan(va);
    expect(readdirSync(thumbDir())).toEqual([`1-${vb}`]);
  });

  it("only the app's managers upload; only its viewers read", async () => {
    const { srv, viewer, outsider, token } = await seed();
    for (const who of [viewer, outsider]) {
      const put = await api(srv, "/api/apps/hello/thumbnail", {
        method: "PUT",
        rawSessionId: who.rawSessionId,
        raw: PNG,
      });
      expect(put.status).toBe(403);
    }
    await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    // The outsider gets the answer an unknown name gets.
    expect((await getThumb(srv, outsider.rawSessionId)).status).toBe(404);
    expect(
      (
        await srv.http("/api/apps/nope/thumbnail", {
          rawSessionId: outsider.rawSessionId,
        })
      ).status,
    ).toBe(404);
    expect((await getThumb(srv, viewer.rawSessionId)).status).toBe(200);
  });

  it("the app's agent uploads by a path relative to its cwd", async () => {
    const { srv, owner, token } = await seed();
    writeFileSync(join(srv.stateRoot, "shot.png"), JPEG);
    const put = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      json: { path: "shot.png" },
    });
    expect(put.status).toBe(200);
    const res = await getThumb(srv, owner.rawSessionId);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
      Array.from(JPEG),
    );
  });

  it("a path to no usable file is refused and the picture stays", async () => {
    const { srv, owner, token } = await seed();
    const first = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    const big = new Uint8Array(MAX_APP_THUMBNAIL_BYTES + 1);
    big.set(PNG);
    writeFileSync(join(srv.stateRoot, "big.png"), big);
    writeFileSync(join(srv.stateRoot, "notes.txt"), "not an image");
    for (const path of ["missing.png", ".", "big.png"]) {
      const res = await api(srv, "/api/apps/hello/thumbnail", {
        method: "PUT",
        bearer: token,
        json: { path },
      });
      expect(res.status).toBe(400);
      expect(errCode(res)).toBe("invalid_request");
      // The answer does not echo where the path resolved.
      expect(JSON.stringify(res.body)).not.toContain(srv.stateRoot);
    }
    const text = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      json: { path: "notes.txt" },
    });
    expect(text.status).toBe(415);
    expect(errCode(text)).toBe("unsupported_image");
    const after = await api(srv, "/api/apps/hello", {
      rawSessionId: owner.rawSessionId,
    });
    expect((after.body as AppWire).thumbnailUpdatedAt).toBe(
      (first.body as AppWire).thumbnailUpdatedAt,
    );
  });

  it("a member cannot upload by path, only by bytes", async () => {
    const { srv, owner } = await seed();
    const file = join(srv.stateRoot, "shot.png");
    writeFileSync(file, PNG);
    const byPath = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      json: { path: file },
    });
    expect(byPath.status).toBe(403);
    expect(existsSync(thumbDir())).toBe(false);
    const byBytes = await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      raw: PNG,
    });
    expect(byBytes.status).toBe(200);
  });

  it("an app with no thumbnail is a 404", async () => {
    const { srv, owner } = await seed();
    expect((await getThumb(srv, owner.rawSessionId)).status).toBe(404);
  });

  it("survives a restart", async () => {
    const { srv, owner, token } = await seed();
    await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    server = await srv.restart();
    const res = await getThumb(server, owner.rawSessionId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("delete removes the file, and a new app with the name has no picture", async () => {
    const { srv, owner, token } = await seed();
    await api(srv, "/api/apps/hello/thumbnail", {
      method: "PUT",
      bearer: token,
      raw: PNG,
    });
    const del = await api(srv, "/api/apps/hello", {
      method: "DELETE",
      bearer: token,
    });
    expect(del.status).toBe(204);
    expect(existsSync(thumbDir())).toBe(false);
    const again = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      json: { name: "hello", command: "bun run serve.ts", cwd: srv.stateRoot },
    });
    expect(again.status).toBe(201);
    expect(again.body as AppWire).not.toHaveProperty("thumbnailUpdatedAt");
    expect((await getThumb(srv, owner.rawSessionId)).status).toBe(404);
  });
});

describe("routes/apps REST: archive", () => {
  const stop = (srv: TestServer, token: string) =>
    api(srv, "/api/apps/hello/stop", { method: "POST", bearer: token });

  it("refuses a running app, and archives a stopped one for every viewer", async () => {
    const { srv, viewer, token } = await seed();
    const running = await api(srv, "/api/apps/hello/archive", {
      method: "POST",
      bearer: token,
    });
    expect(running.status).toBe(409);
    expect(errCode(running)).toBe("app_running");

    await stop(srv, token);
    const archived = await api(srv, "/api/apps/hello/archive", {
      method: "POST",
      bearer: token,
    });
    expect(archived.status).toBe(200);
    expect((archived.body as AppWire).archived).toBe(true);
    // Shared, not per viewer: a member who only views the app sees it too.
    const list = await api(srv, "/api/apps", {
      rawSessionId: viewer.rawSessionId,
    });
    expect((list.body as AppListWire[])[0]).toMatchObject({ archived: true });
    // Stored in the registry.
    const file = JSON.parse(
      readFileSync(join(STATE_ROOT, "apps", "apps.json"), "utf8"),
    ) as { apps: Array<{ name: string; archived?: boolean }> };
    expect(file.apps.find((a) => a.name === "hello")?.archived).toBe(true);
  });

  it("a repeat is a 200 that changes nothing; unarchive clears it", async () => {
    const { srv, token } = await seed();
    await stop(srv, token);
    for (let i = 0; i < 2; i++) {
      const r = await api(srv, "/api/apps/hello/archive", {
        method: "POST",
        bearer: token,
      });
      expect(r.status).toBe(200);
      expect((r.body as AppWire).archived).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      const r = await api(srv, "/api/apps/hello/unarchive", {
        method: "POST",
        bearer: token,
      });
      expect(r.status).toBe(200);
      expect(r.body as AppWire).not.toHaveProperty("archived");
    }
  });

  for (const verb of ["start", "restart"] as const) {
    it(`${verb} takes the app out of the archive`, async () => {
      const { srv, token } = await seed();
      await stop(srv, token);
      await api(srv, "/api/apps/hello/archive", {
        method: "POST",
        bearer: token,
      });
      const r = await api(srv, `/api/apps/hello/${verb}`, {
        method: "POST",
        bearer: token,
      });
      expect(r.status).toBe(200);
      expect(r.body as AppWire).not.toHaveProperty("archived");
    });
  }

  it("stop keeps the flag; only the app's managers may set it", async () => {
    const { srv, viewer, token } = await seed();
    await stop(srv, token);
    await api(srv, "/api/apps/hello/archive", {
      method: "POST",
      bearer: token,
    });
    const stopped = await stop(srv, token);
    expect((stopped.body as AppWire).archived).toBe(true);
    for (const verb of ["archive", "unarchive"]) {
      const r = await api(srv, `/api/apps/hello/${verb}`, {
        method: "POST",
        rawSessionId: viewer.rawSessionId,
      });
      expect(r.status).toBe(403);
    }
  });
});

// --- Handler-level ordering, with injected deps ----------------------------

function record(over: Partial<AppRecord> = {}): AppRecord {
  return {
    name: "hello",
    hostLabel: "hello",
    hostGen: 1,
    port: 21000,
    command: "bun run serve.ts",
    cwd: "/tmp",
    dataDir: "/tmp/data/hello",
    userId: "u-alice",
    username: "alice",
    createdBy: "Agent1",
    createdAt: 1,
    ...over,
  };
}

function deps(over: Partial<AppsDeps>): AppsDeps {
  const unexpected = (what: string) => () => {
    throw new Error(`unexpected ${what}`);
  };
  return {
    appHostingUnsupportedReason: () => null,
    list: () => [record()],
    get: () => record(),
    register: unexpected("register"),
    remove: () => record(),
    update: unexpected("update"),
    registrationGeneration: (app) => app.hostGen,
    thumbnails: {
      write: unexpected("write"),
      read: () => null,
      remove: () => {},
      removeRegistration: () => {},
    },
    resolveAgentPath: unexpected("resolveAgentPath"),
    readThumbnailFile: unexpected("readThumbnailFile"),
    now: () => 1000,
    resolveMessageTarget: () => "ok",
    attributionFor: () => ({ createdBy: "Agent1", username: "alice" }),
    validateCwd: (cwd) => ({ ok: true, resolved: cwd }),
    projectForList: (_identity, _record, wire) => wire,
    publicUrl: () => null,
    canAccess: () => true,
    announce: () => {},
    announceRemoved: () => {},
    provisionToken: () => true,
    revokeToken: () => {},
    retireRegistration: () => {},
    invalidateRegistration: () => {},
    install: () => {},
    reinstall: () => {},
    teardown: () => {},
    start: () => {},
    stop: () => {},
    restart: () => {},
    states: () => new Map(),
    logs: () => [],
    sendAsApp: () => ({ ok: true, messageId: "m-1" }),
    limiter: createAppMessageLimiter(),
    ...over,
  };
}

const ctx = (req: Request = new Request("http://localhost/")) =>
  ({
    identity: { scope: "user", userId: "u-alice", role: "owner" },
    params: { name: "hello" },
    body: undefined,
    rawBody: "",
    query: new URLSearchParams(),
    req,
  }) as unknown as RouteHandlerContext;

const upload = (bytes: Uint8Array<ArrayBuffer>) =>
  new Request("http://localhost/", { method: "PUT", body: bytes });

const uploadPath = (path: string) =>
  new Request("http://localhost/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

const asAgent = (req: Request) =>
  ({
    ...ctx(req),
    identity: { scope: "agent", agentId: "agent-1", userId: "u-alice" },
  }) as unknown as RouteHandlerContext;

const running = (state: AppRuntime["state"]) =>
  new Map([["hello", { ...UNKNOWN_RUNTIME, state }]]);

describe("routes/apps: thumbnail upload ordering", () => {
  it("an upload whose app was re-registered during the body read writes nothing", async () => {
    // The first read is the authorized registration (generation 1); every
    // later read sees the name taken again (generation 2).
    let reads = 0;
    const touched: string[] = [];
    const result = await appsHandlers(
      deps({
        get: () => record({ hostGen: reads++ === 0 ? 1 : 2 }),
        update: () => {
          touched.push("update");
          return record();
        },
        thumbnails: {
          write: () => touched.push("write"),
          read: () => null,
          remove: () => {},
          removeRegistration: () => {},
        },
      }),
    )["apps.setThumbnail"](ctx(upload(PNG)));
    expect(result).toMatchObject({ kind: "error", status: 404 });
    expect(touched).toEqual([]);
  });

  it("a failed registry write removes only the new file", async () => {
    const calls: string[] = [];
    const handlers = appsHandlers(
      deps({
        get: () => record({ thumbnailUpdatedAt: 500 }),
        update: () => {
          throw new Error("disk full");
        },
        thumbnails: {
          write: (_n, gen, v) => calls.push(`write:${gen}-${v}`),
          read: () => null,
          remove: (_n, gen, v) => calls.push(`remove:${gen}-${v}`),
          removeRegistration: () => {},
        },
      }),
    );
    let thrown: unknown = null;
    try {
      await handlers["apps.setThumbnail"](ctx(upload(PNG)));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error | null)?.message).toBe("disk full");
    // The file the record still names (version 500) is never touched.
    expect(calls).toEqual(["write:1-1000", "remove:1-1000"]);
  });

  it("a clock that does not move still gives each upload a newer version", async () => {
    const versions: number[] = [];
    let current = record({ thumbnailUpdatedAt: 1000 });
    const handlers = appsHandlers(
      deps({
        now: () => 1000,
        get: () => current,
        update: (_n, patch) => {
          versions.push(patch.thumbnailUpdatedAt!);
          current = record({ thumbnailUpdatedAt: patch.thumbnailUpdatedAt });
          return current;
        },
        thumbnails: {
          write: () => {},
          read: () => null,
          remove: () => {},
          removeRegistration: () => {},
        },
      }),
    );
    await handlers["apps.setThumbnail"](ctx(upload(PNG)));
    await handlers["apps.setThumbnail"](ctx(upload(PNG)));
    expect(versions).toEqual([1001, 1002]);
  });

  it("delete removes the files of the deleted registration only, after the removal", () => {
    const calls: string[] = [];
    void appsHandlers(
      deps({
        get: () => record({ hostGen: 3 }),
        remove: () => {
          calls.push("remove");
          return record({ hostGen: 3 });
        },
        thumbnails: {
          write: () => {},
          read: () => null,
          remove: () => {},
          removeRegistration: (name, gen) =>
            calls.push(`thumbnails:${name}:${gen}`),
        },
      }),
    )["apps.delete"](ctx());
    expect(calls).toEqual(["remove", "thumbnails:hello:3"]);
  });
});

describe("routes/apps: thumbnail by path, refusals", () => {
  // The real read-file check behind the dep, with every call recorded.
  const recorded = () => {
    const calls: string[] = [];
    const over: Partial<AppsDeps> = {
      resolveAgentPath: (agentId, raw) => {
        calls.push(`resolve:${agentId}:${raw}`);
        const r = resolveEditorPath(raw, "/srv/agent-cwd");
        return r.kind === "ok" ? r.path : null;
      },
      readThumbnailFile: (path) => {
        calls.push(`read:${path}`);
        return { ok: false };
      },
    };
    return { calls, over };
  };

  it("a blank path is refused before any file is read", async () => {
    const { calls, over } = recorded();
    const handler = appsHandlers(deps(over))["apps.setThumbnail"];
    const empty = await handler(asAgent(uploadPath("")));
    expect(empty).toMatchObject({ kind: "error", status: 400 });
    // Whitespace passes the handler and reaches the shared check, which
    // refuses it.
    const blank = await handler(asAgent(uploadPath("  \t ")));
    expect(blank).toMatchObject({ kind: "error", status: 400 });
    expect(calls).toEqual(["resolve:agent-1:  \t "]);
    // A path the check accepts does reach the read, resolved against the cwd.
    await handler(asAgent(uploadPath("shot.png")));
    expect(calls.slice(1)).toEqual([
      "resolve:agent-1:shot.png",
      "read:/srv/agent-cwd/shot.png",
    ]);
  });

  it("a caller that is not an agent is refused before its body is read", async () => {
    const { calls, over } = recorded();
    const req = uploadPath("/srv/agent-cwd/shot.png");
    const result = await appsHandlers(deps(over))["apps.setThumbnail"](
      ctx(req),
    );
    expect(result).toMatchObject({ kind: "error", status: 403 });
    expect(calls).toEqual([]);
    expect(req.bodyUsed).toBe(false);
  });
});

describe("routes/apps: archive ordering", () => {
  it("refuses a starting app like a running one", () => {
    const result = appsHandlers(deps({ states: () => running("starting") }))[
      "apps.archive"
    ](ctx());
    expect(result).toMatchObject({
      kind: "error",
      status: 409,
      code: "app_running",
    });
  });

  it("a start that worked answers 200 even when clearing the flag fails", () => {
    const result = appsHandlers(
      deps({
        get: () => record({ archived: true }),
        update: () => {
          throw new Error("disk full");
        },
        states: () => running("running"),
      }),
    )["apps.start"](ctx());
    expect(result).toMatchObject({
      kind: "json",
      body: { state: "running", archived: true },
    });
  });

  it("a start that threw leaves the flag alone", () => {
    let updated = false;
    const handler = appsHandlers(
      deps({
        get: () => record({ archived: true }),
        start: () => {
          throw new Error("systemd said no");
        },
        update: () => {
          updated = true;
          return record();
        },
      }),
    )["apps.start"];
    expect(() => handler(ctx())).toThrow("systemd said no");
    expect(updated).toBe(false);
  });
});

// --- The store and the body reader -----------------------------------------

describe("app-thumbnails", () => {
  it("knows PNG, JPEG and WebP by their bytes and nothing else", () => {
    expect(sniffAppThumbnailType(PNG)).toBe("image/png");
    expect(sniffAppThumbnailType(JPEG)).toBe("image/jpeg");
    expect(sniffAppThumbnailType(WEBP)).toBe("image/webp");
    expect(sniffAppThumbnailType(PNG.slice(0, 7))).toBeNull();
    expect(
      sniffAppThumbnailType(new TextEncoder().encode("GIF89a........")),
    ).toBeNull();
    // RIFF but not WEBP (a WAV file).
    const wav = WEBP.slice();
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffAppThumbnailType(wav)).toBeNull();
  });

  it("stops reading at the cap, even inside one large chunk", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request("http://localhost/", {
      method: "PUT",
      body: stream,
      // @ts-expect-error - Bun accepts duplex for a streamed request body.
      duplex: "half",
    });
    expect(await readCappedBody(req, 9)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    const exact = await readCappedBody(
      new Request("http://localhost/", {
        method: "PUT",
        body: new Uint8Array(9),
      }),
      9,
    );
    expect(exact.ok && exact.bytes.length).toBe(9);
  });

  it("refuses a declared length over the cap before reading", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request("http://localhost/", {
      method: "PUT",
      body: stream,
      headers: { "Content-Length": "10" },
      // @ts-expect-error - Bun accepts duplex for a streamed request body.
      duplex: "half",
    });
    expect(await readCappedBody(req, 9)).toEqual({ ok: false });
    expect(pulled).toBe(false);
  });

  it("reads a regular file up to the cap and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-file-"));
    tmpDirs.push(dir);
    const exact = join(dir, "exact");
    writeFileSync(exact, new Uint8Array(9));
    const read = readCappedFile(exact, 9);
    expect(read.ok && read.bytes.length).toBe(9);
    expect(readCappedFile(exact, 8)).toEqual({ ok: false });
    expect(readCappedFile(join(dir, "missing"), 9)).toEqual({ ok: false });
    expect(readCappedFile(dir, 9)).toEqual({ ok: false });
    // A device reads like an empty file; it is not a regular one.
    expect(readCappedFile("/dev/null", 9)).toEqual({ ok: false });
    // A FIFO with no writer: refused at once, not waited on.
    const fifo = join(dir, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(readCappedFile(fifo, 9)).toEqual({ ok: false });
  });

  it("keeps each registration's files apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "thumbs-"));
    tmpDirs.push(dir);
    const store = createAppThumbnailStore(dir);
    store.write("hello", 1, 10, PNG);
    store.write("hello", 11, 20, JPEG);
    store.removeRegistration("hello", 1);
    expect(store.read("hello", 1, 10)).toBeNull();
    expect(Array.from(store.read("hello", 11, 20)!)).toEqual(Array.from(JPEG));
    store.remove("hello", 11, 20);
    expect(existsSync(join(dir, "hello"))).toBe(false);
  });
});
