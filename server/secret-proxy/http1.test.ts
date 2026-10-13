import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
  bodyFraming,
  ByteReader,
  HttpError,
  readBody,
  readHead,
} from "./http1.ts";

function readerOf(...parts: string[]) {
  const stream = new PassThrough();
  const reader = new ByteReader(stream);
  for (const part of parts) stream.write(Buffer.from(part, "latin1"));
  stream.end();
  return reader;
}

async function status(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

describe("readHead", () => {
  test("reads a head and leaves the body", async () => {
    const reader = readerOf(
      "GET / HTTP/1.1\r\nHost: a.test\r\nX-A:  1 \r\n\r\nrest",
    );
    const head = await readHead(reader);
    expect(head).toEqual({
      startLine: "GET / HTTP/1.1",
      headers: [
        ["Host", "a.test"],
        ["X-A", "1"],
      ],
    });
    expect(reader.pending().toString()).toBe("rest");
  });

  test("a head split across writes", async () => {
    const head = await readHead(
      readerOf("GET / HT", "TP/1.1\r\nHo", "st: a\r\n\r", "\n"),
    );
    expect(head?.headers).toEqual([["Host", "a"]]);
  });

  test("null at a clean end", async () => {
    expect(await readHead(readerOf())).toBeNull();
  });

  test("refuses loose forms", async () => {
    const cases = [
      "GET / HTTP/1.1\r\nHost: a\r\n  folded\r\n\r\n",
      "GET / HTTP/1.1\r\nHost : a\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a\nX: b\r\n\r\n",
      "\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n",
      "GET / HTTP/1.1\r\n: a\r\n\r\n",
      "GET / HTTP/1.1\r\nX: a\u0001b\r\n\r\n",
    ];
    for (const raw of cases)
      expect(await status(readHead(readerOf(raw)))).toBe(400);
  });

  test("a head over the limit gets 431", async () => {
    const big = `GET / HTTP/1.1\r\nX: ${"a".repeat(70 * 1024)}\r\n\r\n`;
    expect(await status(readHead(readerOf(big)))).toBe(431);
  });
});

describe("bodyFraming", () => {
  const strict = { strict: true };
  test("requests: CL with TE, two CL, another coding are refused", () => {
    const refuse = (headers: [string, string][]) => {
      try {
        bodyFraming(headers, strict);
        return "ok";
      } catch (error) {
        return (error as HttpError).status;
      }
    };
    expect(
      refuse([
        ["Content-Length", "1"],
        ["Transfer-Encoding", "chunked"],
      ]),
    ).toBe(400);
    expect(
      refuse([
        ["Content-Length", "1"],
        ["Content-Length", "1"],
      ]),
    ).toBe(400);
    expect(refuse([["Transfer-Encoding", "gzip, chunked"]])).toBe(400);
    expect(refuse([["Transfer-Encoding", "identity"]])).toBe(400);
    expect(refuse([["Content-Length", "-1"]])).toBe(400);
    expect(bodyFraming([], strict)).toEqual({ kind: "none" });
    expect(bodyFraming([["Content-Length", "3"]], strict)).toEqual({
      kind: "length",
      length: 3,
    });
  });

  test("responses: no length runs to the close", () => {
    expect(bodyFraming([], { strict: false })).toEqual({ kind: "close" });
    expect(
      bodyFraming([["Content-Length", "9"]], { strict: false, noBody: true }),
    ).toEqual({
      kind: "none",
    });
  });
});

describe("readBody", () => {
  test("decodes chunked framing and drops trailers", async () => {
    const reader = readerOf(
      "3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\nX-T: 1\r\n\r\nnext",
    );
    let body = "";
    for await (const piece of readBody(reader, { kind: "chunked" }))
      body += piece.toString();
    expect(body).toBe("abcde");
    expect(reader.pending().toString()).toBe("next");
  });

  test("a body that ends early fails", async () => {
    const consume = async () => {
      for await (const piece of readBody(readerOf("ab"), {
        kind: "length",
        length: 5,
      }))
        void piece;
    };
    expect(await status(consume())).toBe(400);
  });
});
