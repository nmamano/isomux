import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isomux-authority-broker-"));
  const socketPath = join(root, "private", "authority.sock");
  const seen: Array<{ authorization: string | null; path: string }> = [];
  const bodies: Array<{ contentType: string | null; body: string }> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        authorization: request.headers.get("authorization"),
        path: `${url.pathname}${url.search}`,
      });
      if (request.method === "PUT") {
        bodies.push({
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
      }
      if (url.searchParams.has("leak")) return new Response("token-b");
      if (url.searchParams.has("image")) {
        return new Response(IMAGE, {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.searchParams.has("large")) {
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent++ < 9) controller.enqueue(new Uint8Array(1024 * 1024));
              else controller.close();
            },
          }),
        );
      }
      return Response.json({ ok: true });
    },
  });
  const broker = new OpenCodeAuthorityBroker(
    socketPath,
    process.getuid?.() ?? -1,
    `http://127.0.0.1:${upstream.port}`,
  );
  cleanup.push(async () => {
    broker.close();
    await upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  return { broker, socketPath, seen, bodies };
}

// PNG-signed bytes that are not valid UTF-8 (0x89, 0xff, a lone 0x80), with
// the token in the middle.
const IMAGE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x80]),
  Buffer.from("token-b"),
  Buffer.from([0x00, 0xc3, 0xff]),
]);

// The response body as bytes, through curl, which the request helper's text
// decoding would change.
async function requestBytes(
  socketPath: string,
  handle: string,
  path: string,
): Promise<Buffer> {
  const curl = Bun.spawn(
    [
      "curl",
      "-sS",
      "--unix-socket",
      socketPath,
      `http://isomux${path}`,
      "-H",
      `X-Isomux-Turn: ${handle}`,
    ],
    { stdout: "pipe" },
  );
  const body = Buffer.from(await new Response(curl.stdout).arrayBuffer());
  expect(await curl.exited).toBe(0);
  return body;
}

async function request(
  socketPath: string,
  handle?: string,
  path = "/agents",
  method = "GET",
  body = "",
) {
  return await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      let text = "";
      void Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(
              `${method} ${path} HTTP/1.1\r\nHost: isomux\r\n${handle ? `X-Isomux-Turn: ${handle}\r\n` : ""}${body ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`,
            );
          },
          data(_socket, chunk) {
            text += chunk.toString();
          },
          close() {
            const match = /^HTTP\/1\.1 (\d+)/.exec(text);
            resolve({
              status: Number(match?.[1]),
              body: text.split("\r\n\r\n")[1] ?? "",
            });
          },
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch(reject);
    },
  );
}

describe("OpenCode office proxy", () => {
  it("keeps one session handle across active turns and proxies with the bound token", async () => {
    const { broker, socketPath, seen } = fixture();
    const binding = broker.bind("agent-b", "token-b");
    expect((await request(socketPath)).status).toBe(403);
    const handle = binding.activate(process.pid);
    expect((await request(socketPath, "unknown")).status).toBe(403);
    expect((await request(socketPath, handle, "/agents?killed=1")).status).toBe(
      200,
    );
    expect(seen).toEqual([
      { authorization: "Bearer token-b", path: "/agents?killed=1" },
    ]);
    expect((await request(socketPath, handle, "/agents?leak=1")).body).toBe(
      "[REDACTED]",
    );
    expect(
      (await request(socketPath, handle, "/agents?large=1")).body,
    ).toContain("exceeded the size limit");
    const curl = Bun.spawn(
      [
        "curl",
        "-sS",
        "--unix-socket",
        socketPath,
        "http://isomux/agents",
        "-H",
        `X-Isomux-Turn: ${handle}`,
      ],
      { stdout: "pipe" },
    );
    expect(await curl.exited).toBe(0);
    expect(await new Response(curl.stdout).json()).toEqual({ ok: true });
    binding.deactivate();
    expect((await request(socketPath, handle)).status).toBe(403);
    expect(binding.activate(process.pid)).toBe(handle);
    expect((await request(socketPath, handle)).status).toBe(200);
  });

  it("refuses a handle from a different session", async () => {
    const { broker, socketPath } = fixture();
    const first = broker.bind("agent-b", "token-b");
    const second = broker.bind("agent-c", "token-c");
    const firstHandle = first.activate(process.pid);
    first.deactivate();
    const secondHandle = second.activate(process.pid);

    expect((await request(socketPath, firstHandle)).status).toBe(403);
    expect((await request(socketPath, secondHandle)).status).toBe(200);
  });

  it("rejects a peer outside the bound server ancestry and non-allowlisted routes", async () => {
    const { broker, socketPath } = fixture();
    let wrongServer: string;
    if (process.platform === "darwin") {
      // launchd (pid 1) belongs to root, and macOS reads process info only
      // for the same user, so binding it refuses. Bind a live unrelated
      // process of this user instead.
      expect(() => broker.bind("agent-a", "token-a").activate(1)).toThrow();
      const unrelated = Bun.spawn(["sleep", "30"]);
      cleanup.push(async () => {
        unrelated.kill();
        await unrelated.exited;
      });
      wrongServer = broker.bind("agent-b", "token-b").activate(unrelated.pid);
    } else {
      wrongServer = broker.bind("agent-b", "token-b").activate(1);
    }
    expect((await request(socketPath, wrongServer)).status).toBe(403);
    const handle = broker.bind("agent-c", "token-c").activate(process.pid);
    expect((await request(socketPath, handle, "/api/invites")).status).toBe(
      403,
    );
    expect(
      (await request(socketPath, handle, "http://example.com/agents")).status,
    ).toBe(400);
  });

  it("lets an agent reply to a remote API token's inbox", async () => {
    const { broker, socketPath, seen } = fixture();
    const handle = broker.bind("agent-b", "token-b").activate(process.pid);
    const inbox = "/api/api-token-inboxes/pat-123/messages";
    expect(
      (await request(socketPath, handle, inbox, "POST", '{"text":"hi"}'))
        .status,
    ).toBe(200);
    expect(seen).toEqual([{ authorization: "Bearer token-b", path: inbox }]);
    expect((await request(socketPath, handle, inbox)).status).toBe(403);
  });

  it("carries the thumbnail upload by path and serves the image bytes unchanged", async () => {
    const { broker, socketPath, seen, bodies } = fixture();
    const handle = broker.bind("agent-b", "token-b").activate(process.pid);
    const thumbnail = "/api/apps/hello/thumbnail";
    expect(
      (
        await request(
          socketPath,
          handle,
          thumbnail,
          "PUT",
          '{"path":"shot.png"}',
        )
      ).status,
    ).toBe(200);
    expect(bodies).toEqual([
      { contentType: "application/json", body: '{"path":"shot.png"}' },
    ]);
    const image = await requestBytes(
      socketPath,
      handle,
      `${thumbnail}?v=1&image=1`,
    );
    // Every byte survives except the token itself.
    expect(Array.from(image)).toEqual(
      Array.from(
        Buffer.concat([
          IMAGE.subarray(0, 10),
          Buffer.from("[REDACTED]"),
          IMAGE.subarray(17),
        ]),
      ),
    );
    expect(seen.map((s) => s.path)).toEqual([
      thumbnail,
      `${thumbnail}?v=1&image=1`,
    ]);
  });

  it("limits calls for each turn", async () => {
    const { broker, socketPath } = fixture();
    const binding = broker.bind("agent-b", "token-b");
    const handle = binding.activate(process.pid);
    for (let index = 0; index < 32; index++)
      expect((await request(socketPath, handle)).status).toBe(200);
    expect((await request(socketPath, handle)).status).toBe(429);
    binding.deactivate();
    expect(binding.activate(process.pid)).toBe(handle);
    expect((await request(socketPath, handle)).status).toBe(200);
  });
});
