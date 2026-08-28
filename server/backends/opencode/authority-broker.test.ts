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
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        authorization: request.headers.get("authorization"),
        path: `${url.pathname}${url.search}`,
      });
      if (url.searchParams.has("leak")) return new Response("token-b");
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
  return { broker, socketPath, seen };
}

async function request(socketPath: string, handle?: string, path = "/agents") {
  return await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      let text = "";
      void Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(
              `GET ${path} HTTP/1.1\r\nHost: isomux\r\n${handle ? `X-Isomux-Turn: ${handle}\r\n` : ""}\r\n`,
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
  it("requires an active per-turn handle and proxies with the bound token", async () => {
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
  });

  it("rejects a peer outside the bound server ancestry and non-allowlisted routes", async () => {
    const { broker, socketPath } = fixture();
    const wrongServer = broker.bind("agent-b", "token-b").activate(1);
    expect((await request(socketPath, wrongServer)).status).toBe(403);
    const handle = broker.bind("agent-c", "token-c").activate(process.pid);
    expect((await request(socketPath, handle, "/api/invites")).status).toBe(
      403,
    );
    expect(
      (await request(socketPath, handle, "http://example.com/agents")).status,
    ).toBe(400);
  });

  it("limits calls for each turn", async () => {
    const { broker, socketPath } = fixture();
    const handle = broker.bind("agent-b", "token-b").activate(process.pid);
    for (let index = 0; index < 32; index++)
      expect((await request(socketPath, handle)).status).toBe(200);
    expect((await request(socketPath, handle)).status).toBe(429);
  });
});
