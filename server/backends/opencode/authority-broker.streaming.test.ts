import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { BrokerResponseWriter, BODY_HIGH_WATER_MARK, StreamingRequestBody } from "./authority-request.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture(onRequest?: (req: Request) => Promise<Response>) {
  const seen: string[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    if (onRequest) return onRequest(req);
    seen.push(await req.text());
    return Response.json({ ok: true });
  } });
  const root = mkdtempSync(join(tmpdir(), "broker-stream-"));
  const path = join(root, "authority.sock");
  const broker = new OpenCodeAuthorityBroker(path, process.getuid?.() ?? -1, `http://127.0.0.1:${upstream.port}`);
  const handle = broker.bind("agent-stream", "test-token").activate(process.pid);
  cleanup.push(async () => { broker.close(); await upstream.stop(true); rmSync(root, { recursive: true, force: true }); });
  function connect(allowHalfOpen = false) {
    const socket = createConnection({ path, allowHalfOpen });
    cleanup.push(() => { socket.destroy(); });
    let text = "";
    const done = new Promise<{ status: number; text: string }>((resolve, reject) => {
      socket.on("data", data => { text += data.toString(); });
      socket.on("close", () => resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1]), text }));
      socket.on("error", reject);
    });
    return { socket, done };
  }
  function head(headers = "", path = "/api/tasks", method = "POST") {
    return `${method} ${path} HTTP/1.1\r\nHost: isomux\r\nX-Isomux-Turn: ${handle}\r\n${headers}\r\n`;
  }
  return { seen, connect, head };
}

it("forwards the first body bytes before the client sends the rest", async () => {
  let first!: () => void;
  const gotFirst = new Promise<void>(resolve => { first = resolve; });
  const received: number[] = [];
  const f = fixture(async req => {
    expect(req.headers.get("content-length")).toBe("6");
    expect(req.headers.get("transfer-encoding")).toBeNull();
    const reader = req.body!.getReader();
    const part = await reader.read();
    received.push(...part.value!);
    first();
    while (true) { const next = await reader.read(); if (next.done) break; received.push(...next.value); }
    return Response.json({ ok: true });
  });
  const { socket, done } = f.connect();
  socket.write(f.head("Content-Length: 6\r\n") + "abc");
  const streamed = await Promise.race([gotFirst.then(() => true), Bun.sleep(500).then(() => false)]);
  socket.write("def");
  expect((await done).status).toBe(200);
  expect(streamed).toBe(true);
  expect(Buffer.from(received).toString()).toBe("abcdef");
});

it("forwards exactly Content-Length and no body when length is absent", async () => {
  const f = fixture();
  for (const [headers, body, expected] of [
    ["Content-Length: 3\r\n", "abcdef", "abc"],
    ["", "ignored", ""],
  ]) {
    const { socket, done } = f.connect();
    socket.write(f.head(headers) + body);
    expect((await done).status).toBe(200);
    expect(f.seen.at(-1)).toBe(expected);
  }
});

it("refuses transfer encoding, invalid lengths and oversized heads without forwarding", async () => {
  const f = fixture();
  const headers: Array<[string, number]> = [
    ["Transfer-Encoding: chunked\r\n", 411],
    ["Transfer-Encoding: chunked\r\nContent-Length: 3\r\n", 411],
    ["Content-Length: -1\r\n", 400],
    ["Content-Length: 1.5\r\n", 400],
    ["Content-Length: 3\r\nContent-Length: 4\r\n", 400],
    ["Content-Length: 9007199254740992\r\n", 400],
    [`X-Large: ${"x".repeat(64 * 1024)}\r\n`, 413],
  ];
  for (const [header, expected] of headers) {
    const { socket, done } = f.connect();
    socket.write(f.head(header));
    expect((await done).status).toBe(expected);
  }
  expect(f.seen).toEqual([]);
});

it("refuses a forbidden head without waiting for its body", async () => {
  const f = fixture();
  const { socket, done } = f.connect();
  socket.write(f.head("Content-Length: 1000000\r\n", "/api/agents/a/privileged", "PUT"));
  expect((await done).status).toBe(403);
  expect(f.seen).toEqual([]);
});

it("pauses before admission and bounds the body queue with backpressure", async () => {
  let paused = false;
  const pump = new StreamingRequestBody(BODY_HIGH_WATER_MARK * 2, {
    pause() { paused = true; }, resume() { paused = false; },
  });
  await Bun.sleep(0); // the stream's initial pull must not resume before admission
  expect(paused).toBe(true);
  pump.admit(Buffer.alloc(BODY_HIGH_WATER_MARK));
  expect(paused).toBe(true);
  const reader = pump.stream.getReader();
  expect((await reader.read()).value?.length).toBe(BODY_HIGH_WATER_MARK);
  await Bun.sleep(0);
  expect(paused).toBe(false);
  pump.push(Buffer.alloc(BODY_HIGH_WATER_MARK));
  expect((await reader.read()).value?.length).toBe(BODY_HIGH_WATER_MARK);
  expect((await reader.read()).done).toBe(true);
});


it("never enqueues bytes beyond the declared body length", async () => {
  const body = new StreamingRequestBody(3, { pause() {}, resume() {} });
  body.admit(Buffer.from("abcdef"));
  const reader = body.stream.getReader();
  expect(Buffer.from((await reader.read()).value!).toString()).toBe("abc");
  expect((await reader.read()).done).toBe(true);
});

it("drains partial responses and stops writing after close", () => {
  const sent: number[] = [];
  let ends = 0;
  const socket = {
    write(bytes: Uint8Array) { sent.push(bytes[0]); return 1; },
    end() { ends++; },
  };
  const writer = new BrokerResponseWriter(socket as unknown as Pick<Bun.Socket, "write" | "end">);
  writer.send(Buffer.from([1, 2, 3]));
  expect(ends).toBe(0);
  writer.drain();
  expect(ends).toBe(0);
  writer.drain();
  expect(sent).toEqual([1, 2, 3]);
  expect(ends).toBe(1);
  writer.drain();
  expect(sent).toHaveLength(3);

  const interrupted = new BrokerResponseWriter(socket as unknown as Pick<Bun.Socket, "write" | "end">);
  interrupted.send(Buffer.from([4, 5]));
  interrupted.close();
  interrupted.drain();
  interrupted.send(Buffer.from([6]));
  expect(sent).toEqual([1, 2, 3, 4]);
  expect(ends).toBe(1);
});


for (const disconnect of ["fin", "destroy"] as const) {
  it(`aborts the upstream body promptly after client ${disconnect}`, async () => {
    let first!: () => void;
    const gotFirst = new Promise<void>(resolve => { first = resolve; });
    let result!: (value: string) => void;
    const bodyResult = new Promise<string>(resolve => { result = resolve; });
    const f = fixture(async req => {
      const reader = req.body!.getReader();
      try {
        const part = await reader.read();
        expect(Buffer.from(part.value!).toString()).toBe("abc");
        first();
        while (!(await reader.read()).done) { /* wait for the missing bytes */ }
        result("completed");
      } catch {
        result("rejected");
      }
      return new Response(null, { status: 400 });
    });
    // Keep the client's read half open after FIN. Bun.listen still closes its
    // socket on FIN, so the broker's close handler must abort the upstream.
    const { socket, done } = f.connect(true);
    socket.write(f.head("Content-Length: 6\r\n") + "abc");
    expect(await Promise.race([gotFirst.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true);
    if (disconnect === "fin") socket.end();
    else socket.destroy();
    expect(await Promise.race([bodyResult, Bun.sleep(1000).then(() => "timed out")])).toBe("rejected");
    await done;
  });
}


it("continues an admitted 3 MiB upload before the client sends its body", async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 97);
  let received = 0;
  const f = fixture(async req => {
    expect(req.headers.get("expect")).toBeNull();
    received = (await req.arrayBuffer()).byteLength;
    return Response.json({ ok: true });
  });
  const { socket, done } = f.connect();
  let response = "";
  let continued!: () => void;
  const gotContinue = new Promise<void>(resolve => { continued = resolve; });
  socket.on("data", bytes => {
    response += bytes.toString();
    if (response.includes("HTTP/1.1 100 Continue\r\n\r\n")) continued();
  });
  socket.write(f.head(`Expect: 100-CoNtInUe\r\nContent-Length: ${body.length}\r\n`));
  expect(await Promise.race([gotContinue.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true);
  socket.write(body);
  const result = await done;
  expect(result.text).toMatch(/HTTP\/1.1 100 Continue\r\n\r\nHTTP\/1.1 200 /);
  expect(received).toBe(body.length);
});

it("sends no Continue for a refused head", async () => {
  const f = fixture();
  const { socket, done } = f.connect();
  socket.write(f.head("Expect: 100-continue\r\nContent-Length: 3000000\r\n", "/api/agents/a/privileged", "PUT"));
  const result = await done;
  expect(result.status).toBe(403);
  expect(result.text).not.toContain("100 Continue");
  expect(f.seen).toEqual([]);
});

it("queues interim and final responses in order through partial writes", () => {
  const sent: number[] = [];
  let ends = 0;
  let flushed = false;
  const writer = new BrokerResponseWriter({
    write(bytes: Uint8Array) { sent.push(bytes[0]); return 1; },
    end() { ends++; },
  } as unknown as Pick<Bun.Socket, "write" | "end">);
  writer.interim(Buffer.from([1, 2]), () => { flushed = true; });
  writer.send(Buffer.from([3, 4]));
  expect(flushed).toBe(false);
  expect(ends).toBe(0);
  writer.drain();
  expect(flushed).toBe(true);
  expect(ends).toBe(0);
  writer.drain();
  expect(sent).toEqual([1, 2, 3, 4]);
  expect(ends).toBe(1);
});
