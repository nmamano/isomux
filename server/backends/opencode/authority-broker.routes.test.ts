import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { startTestServer } from "../../test-support/harness.ts";
import { mintAgentToken, revokeAgentToken } from "../../identity/tokens.ts";
import { getUserByName } from "../../users.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(privileged = true) {
  const srv = await startTestServer();
  cleanup.push(() => srv.stop());
  const owner = await srv.seedOwner("Boss");
  const token = mintAgentToken(
    "broker-agent",
    getUserByName(owner.username)!.id,
    privileged,
  );
  const root = mkdtempSync(join(tmpdir(), "broker-routes-"));
  const socketPath = join(root, "authority.sock");
  const broker = new OpenCodeAuthorityBroker(
    socketPath,
    process.getuid?.() ?? -1,
    srv.baseUrl,
  );
  cleanup.push(() => {
    broker.close();
    rmSync(root, { recursive: true, force: true });
  });
  const handle = broker.bind("broker-agent", token).activate(process.pid);

  async function request(path: string, init: RequestInit = {}) {
    const req = new Request(`http://isomux${path}`, init);
    // Materialize Bun's lazy multipart header before consuming its body.
    const headers = Array.from(req.headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const body = Buffer.from(await req.arrayBuffer());
    const wire = Buffer.concat([
      Buffer.from(
        `${req.method} ${path} HTTP/1.1\r\nHost: isomux\r\nX-Isomux-Turn: ${handle}\r\n${headers}Content-Length: ${body.length}\r\n\r\n`,
      ),
      body,
    ]);
    const chunks: Buffer[] = [];
    let sent = 0;
    const write = (socket: Bun.Socket) => {
      const wrote = socket.write(wire.subarray(sent));
      if (wrote > 0) sent += wrote;
    };
    await new Promise<void>((resolve, reject) => {
      void Bun.connect({
        unix: socketPath,
        socket: {
          open: write,
          drain: write,
          data(_socket, data) {
            chunks.push(Buffer.from(data));
          },
          close() {
            resolve();
          },
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch(reject);
    });
    const bytes = Buffer.concat(chunks);
    const split = bytes.indexOf("\r\n\r\n");
    const status = Number(
      /^HTTP\/1\.1 (\d+)/.exec(bytes.subarray(0, split).toString())?.[1],
    );
    return { status, body: bytes.subarray(split + 4) };
  }
  return { request, srv, owner, socketPath, handle };
}

it("stores multipart bytes through the broker and returns the stored file", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const form = new FormData();
  form.append(
    "files",
    new File([bytes], "sample.bin", { type: "application/octet-stream" }),
  );
  const uploaded = await f.request("/api/members-chat/uploads", {
    method: "POST",
    body: form,
  });
  expect(uploaded.status, uploaded.body.toString()).toBe(200);
  const { attachments } = JSON.parse(uploaded.body.toString());
  expect(attachments).toHaveLength(1);
  const stored = await f.request(
    `/api/members-chat/files/${attachments[0].filename}`,
  );
  expect(stored.status).toBe(200);
  expect(createHash("sha256").update(stored.body).digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

it("relays the server thumbnail limit refusal for a streamed upload", async () => {
  const f = await fixture();
  const registered = await f.request("/api/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "hello",
      command: "bun server.ts",
      cwd: f.srv.stateRoot,
    }),
  });
  expect(registered.status, registered.body.toString()).toBe(201);
  const res = await f.request("/api/apps/hello/thumbnail", {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  });
  expect(res.status, res.body.toString()).toBe(413);
  expect(JSON.parse(res.body.toString()).error.code).toBe("payload_too_large");
});

it("keeps the actual token's capability check in the executor", async () => {
  const f = await fixture(false);
  const res = await f.request("/api/members-chat");
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body.toString()).error.code).toBe("forbidden");
});

it("returns the executor's refusal for a revoked token", async () => {
  const f = await fixture();
  expect((await f.request("/api/tasks")).status).toBe(200);
  revokeAgentToken("broker-agent");
  const res = await f.request("/api/tasks");
  expect(res.status).toBe(401);
  expect(JSON.parse(res.body.toString()).error.code).toBe("unauthenticated");
});

it("leaves no stored file at client close for a truncated multipart body", async () => {
  const f = await fixture();
  const filesDir = join(f.srv.stateRoot, "members-chat", "files");
  const count = () => (existsSync(filesDir) ? readdirSync(filesDir).length : 0);
  const before = count();
  // This checks storage and the client response at close. The stub-upstream
  // streaming test separately proves that the pending body read is aborted.
  const form = new FormData();
  form.append("file", new File(["must not be stored"], "truncated.txt"));
  const encoded = new Request("http://isomux", { method: "POST", body: form });
  const type = encoded.headers.get("content-type");
  const body = Buffer.from(await encoded.arrayBuffer());
  // Sends the body and closes, announcing `missing` more bytes than it sends.
  const upload = (missing: number) =>
    new Promise<string>((resolve, reject) => {
      let response = "";
      const socket = createConnection(f.socketPath, () => {
        socket.end(
          Buffer.concat([
            Buffer.from(
              `POST /api/members-chat/uploads HTTP/1.1\r\nHost: isomux\r\nX-Isomux-Turn: ${f.handle}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length + missing}\r\n\r\n`,
            ),
            body,
          ]),
        );
      });
      socket.on("data", (data) => {
        response += data.toString();
      });
      socket.on("close", () => resolve(response));
      socket.on("error", reject);
    });
  // The control: the same upload, complete, is stored.
  expect((await upload(0)).startsWith("HTTP/1.1 200")).toBe(true);
  expect(count()).toBe(before + 1);
  expect((await upload(10)).startsWith("HTTP/1.1 200")).toBe(false);
  expect(count()).toBe(before + 1);
});
