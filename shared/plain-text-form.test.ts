// readPlainTextForm: how a text/plain body and its query become the body
// object a JSON caller sends. The wiring through the real server is in
// server/test-support/routes-plain-text-messages.test.ts.

import { describe, expect, it } from "bun:test";
import {
  MESSAGE_PLAIN_TEXT_PARAMS,
  readPlainTextForm,
  type PlainTextForm,
} from "./plain-text-form.ts";

const TEXT_PLAIN = "text/plain";

function read(
  search: string,
  rawBody = "hello",
  contentType = TEXT_PLAIN,
  params: Record<string, "flag" | "string"> = MESSAGE_PLAIN_TEXT_PARAMS,
): PlainTextForm {
  return readPlainTextForm(params, contentType, search, rawBody);
}

function expectInvalid(form: PlainTextForm, param: string): void {
  expect(form.kind).toBe("error");
  if (form.kind !== "error") return;
  expect(form.status).toBe(422);
  expect(form.code).toBe("invalid_request");
  // The message names the parameter the caller must fix.
  expect(form.message).toContain(param);
}

describe("readPlainTextForm: the body", () => {
  it("keeps quotes, backslashes, tabs, inner line breaks and non-ASCII byte for byte", () => {
    const text =
      'say "hi" \\n is not a newline\\\n\tnext line ünï 日本 🚀 $HOME `x`';
    expect(read("", text)).toEqual({ kind: "text", body: { text } });
  });

  it("drops exactly one trailing line break, LF or CRLF", () => {
    expect(read("", "a\n")).toEqual({ kind: "text", body: { text: "a" } });
    expect(read("", "a\r\n")).toEqual({ kind: "text", body: { text: "a" } });
    expect(read("", "a\n\n")).toEqual({ kind: "text", body: { text: "a\n" } });
    expect(read("", "\n")).toEqual({ kind: "text", body: { text: "" } });
  });

  it("matches the media type case-insensitively and ignores its parameters", () => {
    for (const contentType of [
      "text/plain",
      "Text/Plain",
      "text/plain; charset=utf-8",
      "TEXT/PLAIN;charset=UTF-8",
    ])
      expect(read("?steer=1", "x", contentType)).toEqual({
        kind: "text",
        body: { text: "x", steer: true },
      });
    // A different type is not the plain-text form.
    expect(read("", "x", "text/plainer")).toEqual({ kind: "json" });
  });

  it("orders the fields text first, then in declared order, whatever the query order", () => {
    const form = read("?clientMessageId=c1&deliverAt=2026-10-18T09:00:00Z");
    expect(form.kind).toBe("text");
    if (form.kind !== "text") return;
    expect(Object.keys(form.body)).toEqual([
      "text",
      "deliverAt",
      "clientMessageId",
    ]);
  });
});

describe("readPlainTextForm: query parameters", () => {
  it("reads steer=1 and steer=true as steer:true", () => {
    for (const value of ["1", "true"])
      expect(read(`?steer=${value}`)).toEqual({
        kind: "text",
        body: { text: "hello", steer: true },
      });
  });

  it("refuses every other steer form", () => {
    for (const search of [
      "?steer",
      "?steer=",
      "?steer=0",
      "?steer=false",
      "?steer=yes",
      "?steer=TRUE",
    ])
      expectInvalid(read(search), "steer");
  });

  it("keeps a literal + in deliverAt (no form-decoding to a space)", () => {
    expect(read("?deliverAt=2026-10-18T09:00:00+02:00")).toEqual({
      kind: "text",
      body: { text: "hello", deliverAt: "2026-10-18T09:00:00+02:00" },
    });
    // Percent-encoded + decodes to the same value.
    expect(read("?deliverAt=2026-10-18T09:00:00%2B02:00")).toEqual({
      kind: "text",
      body: { text: "hello", deliverAt: "2026-10-18T09:00:00+02:00" },
    });
  });

  it("passes string values through for the handler to judge, including empty", () => {
    expect(read("?clientMessageId=a%20b&deliverAt=")).toEqual({
      kind: "text",
      body: { text: "hello", deliverAt: "", clientMessageId: "a b" },
    });
  });

  it("refuses a string parameter with no value", () => {
    expectInvalid(read("?deliverAt"), "deliverAt");
    expectInvalid(read("?clientMessageId"), "clientMessageId");
  });

  it("refuses malformed percent-encoding in a value or a name", () => {
    expectInvalid(read("?deliverAt=%ZZ"), "deliverAt");
    expectInvalid(read("?steer%ZZ=1"), "steer%ZZ");
  });

  it("refuses a repeated parameter", () => {
    expectInvalid(read("?steer=1&steer=1"), "steer");
    expectInvalid(
      read("?clientMessageId=a&clientMessageId=a"),
      "clientMessageId",
    );
  });

  it("refuses an unknown parameter and names the accepted ones", () => {
    const form = read("?stear=1");
    expectInvalid(form, "stear");
    if (form.kind === "error") expect(form.message).toContain("deliverAt");
  });

  it("refuses every parameter on a route that declares none", () => {
    expectInvalid(read("?steer=1", "x", TEXT_PLAIN, {}), "steer");
  });

  it("skips empty query segments", () => {
    expect(read("?&steer=1&")).toEqual({
      kind: "text",
      body: { text: "hello", steer: true },
    });
  });
});

describe("readPlainTextForm: other content types", () => {
  it("refuses a declared option in the query of a request that is not text/plain", () => {
    for (const contentType of [
      "application/json",
      "application/x-www-form-urlencoded",
      "",
    ]) {
      expectInvalid(read("?steer=1", '{"text":"x"}', contentType), "steer");
      expectInvalid(
        read("?deliverAt=2026-10-18T09:00:00Z", '{"text":"x"}', contentType),
        "deliverAt",
      );
    }
    // Refused even when the body sets the same field: no merge, no precedence.
    expectInvalid(
      read("?steer=1", '{"text":"x","steer":true}', "application/json"),
      "steer",
    );
  });

  it("leaves an undeclared query parameter on JSON to be ignored, as before", () => {
    expect(read("?foo=1", '{"text":"x"}', "application/json")).toEqual({
      kind: "json",
    });
    expect(read("", '{"text":"x"}', "application/json")).toEqual({
      kind: "json",
    });
  });
});

describe("readPlainTextForm: JSON sent as text/plain (fetch's default type)", () => {
  it("takes the JSON path for a plain object with a string text and no option in the query", () => {
    expect(read("", '{"text":"inner","steer":true}')).toEqual({ kind: "json" });
    // An undeclared parameter does not stop it: the JSON path ignores it.
    expect(read("?foo=1", '{"text":"inner"}')).toEqual({ kind: "json" });
  });

  it("keeps the body verbatim when an option is in the query", () => {
    const body = '{"text":"inner"}';
    expect(read("?steer=1", body)).toEqual({
      kind: "text",
      body: { text: body, steer: true },
    });
  });

  it("keeps the body verbatim when it is not an object with a string text", () => {
    for (const body of [
      '{"text":5}',
      '{"message":"inner"}',
      '["text"]',
      "null",
      '"inner"',
      "{not json",
    ])
      expect(read("", body)).toEqual({ kind: "text", body: { text: body } });
  });
});
