// Raw-socket requests for the shipped Bun listeners, because fetch() will not
// send a malformed Host or leave the Host out.
//
// A Host the URL parser rejects is client garbage: each listener answers it
// with a 400 instead of a throw from new URL(req.url) (task 66c3a09f).
// A handler that does throw must not get Bun's development error page (task
// 8f6b0ce4); no request throws on purpose any more, so a child listener loads
// THROWING_HANDLER_PRELOAD and gets a throw from sendThrowing().
import { join } from "node:path";
import { expect } from "bun:test";

// Each one makes new URL(req.url) throw. Bun keeps the Host in req.url for the
// first four and gives a bare path ("/") for the others.
export const MALFORMED_HOSTS = [
  "office.example:abc",
  "a:99999",
  "[::1",
  "%zz",
  "has space.test",
  "x/y",
  "x?y",
  "x#y",
  "x@y",
  "a b:4000",
];

export interface RawAnswer {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  raw: string;
}

// Send `head` (request line and headers, no blank line) on a raw socket.
export async function sendRaw(port: number, head: string): Promise<RawAnswer> {
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("no answer")), 5000);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(`${head}\r\nConnection: close\r\n\r\n`);
        },
        data(_sock, chunk) {
          buf += new TextDecoder().decode(chunk);
        },
        close() {
          clearTimeout(timer);
          resolve(buf);
        },
        error(_sock, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch(reject);
  });
  const lines = raw.slice(0, raw.indexOf("\r\n\r\n")).split("\r\n");
  const status = parseInt(lines[0]?.split(" ")[1] ?? "0", 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
  }
  return { status, contentType: headers["content-type"] ?? "", headers, raw };
}

export function sendBadHost(
  port: number,
  host: string,
  path = "/",
): Promise<RawAnswer> {
  return sendRaw(port, `GET ${path} HTTP/1.1\r\nHost: ${host}`);
}

// Every malformed Host, and an HTTP/1.0 request with no Host (Bun gives it a
// bare-path req.url too), gets a 400. `control` is a well-formed request to
// the same listener: it proves the socket reaches the URL parse and the
// routes behind it, so a listener that 400s everything cannot pass.
export async function expectMalformedHostsRefused(
  port: number,
  control: { path: string; status: number },
): Promise<RawAnswer[]> {
  const good = await sendBadHost(port, "localhost", control.path);
  expect(good.status).toBe(control.status);
  const answers: RawAnswer[] = [];
  for (const host of MALFORMED_HOSTS)
    answers.push(await sendBadHost(port, host, control.path));
  answers.push(await sendRaw(port, `GET ${control.path} HTTP/1.0`));
  const cases = [...MALFORMED_HOSTS, "HTTP/1.0 with no Host"];
  expect(answers.map((a, i) => [cases[i], a.status])).toEqual(
    cases.map((c) => [c, 400]),
  );
  return answers;
}

// Load this in a child listener with `bun --preload`: it wraps Bun.serve so a
// request carrying THROW_HEADER throws inside the handler. Every other option,
// development included, stays as the listener sets it.
export const THROWING_HANDLER_PRELOAD = join(
  import.meta.dir,
  "throwing-handler-preload.ts",
);
// The same literal is in throwing-handler-preload.ts, which cannot import this
// file: bun:test is not loadable outside a test run.
export const THROW_HEADER = "x-isomux-test-throw";

export async function sendThrowing(port: number): Promise<RawAnswer> {
  return sendRaw(
    port,
    `GET / HTTP/1.1\r\nHost: localhost\r\n${THROW_HEADER}: 1`,
  );
}

// Bun's development error page carries the exception, the cwd, absolute frame
// paths and source lines. A bare 500 carries none of them.
export function expectNoErrorPage(answer: RawAnswer): void {
  // Bun shows the page whenever NODE_ENV is not production; bun test sets it
  // to "test", so a missing page here is the server's doing.
  expect(process.env.NODE_ENV).not.toBe("production");
  // The handler threw: Bun's answer to a throw is a 500 in both modes.
  expect(answer.status).toBe(500);
  expect(answer.contentType).not.toContain("text/html");
  expect(answer.raw).not.toContain("__bunfallback");
  expect(answer.raw).not.toContain(process.cwd());
  expect(answer.raw).not.toMatch(/\.ts\b/);
}
