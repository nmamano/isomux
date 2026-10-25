// A request whose Host the URL parser rejects, sent on a raw socket because
// fetch() will not send one. Every shipped listener parses new URL(req.url)
// first, so this is a request that throws inside the handler (task 8f6b0ce4).
import { expect } from "bun:test";

export async function sendBadHost(
  port: number,
): Promise<{ status: number; contentType: string; raw: string }> {
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("no answer")), 5000);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(
            "GET / HTTP/1.1\r\nHost: [::1\r\nConnection: close\r\n\r\n",
          );
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
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  const status = parseInt(head.split(" ")[1] ?? "0", 10);
  const contentType =
    head
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith("content-type:"))
      ?.slice("content-type:".length)
      .trim() ?? "";
  return { status, contentType, raw };
}

// Bun's development error page carries the exception, the cwd, absolute frame
// paths and source lines. A refusal or a bare 500 carries none of them.
export function expectNoErrorPage(answer: {
  status: number;
  contentType: string;
  raw: string;
}): void {
  // Bun shows the page whenever NODE_ENV is not production; bun test sets it
  // to "test", so a missing page here is the server's doing.
  expect(process.env.NODE_ENV).not.toBe("production");
  // The handler failed on the Host: a refusal (400) or a bare 500, not an
  // answer that never reached the URL parse.
  expect([400, 500]).toContain(answer.status);
  expect(answer.contentType).not.toContain("text/html");
  expect(answer.raw).not.toContain("__bunfallback");
  expect(answer.raw).not.toContain(process.cwd());
  expect(answer.raw).not.toMatch(/\.ts\b/);
}
