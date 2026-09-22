import { describe, expect, it } from "bun:test";
import { parseBrowserParams, describeShot } from "./browser-actions";
describe("parseBrowserParams", () => {
  it("rejects a body that is not an object", () => {
    for (const body of ["x", 3, null, ["goto"]]) {
      const r = parseBrowserParams(body);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an unknown or missing action", () => {
    for (const body of [{}, { action: "evaluate" }, { action: 7 }]) {
      const r = parseBrowserParams(body);
      expect(r.ok).toBe(false);
    }
  });

  it("accepts every documented action with its required fields", () => {
    const bodies = [
      { action: "goto", url: "http://localhost:4000/" },
      { action: "snapshot" },
      { action: "text" },
      { action: "click", selector: "#go" },
      { action: "fill", selector: "#name", text: "nil" },
      {
        action: "upload",
        selector: "input[type=file]",
        path: "/fixture/file.png",
      },
      { action: "press", key: "Enter" },
      { action: "press", key: "Enter", selector: "#name" },
      { action: "screenshot" },
      { action: "screenshot", fullPage: true },
      { action: "close" },
    ];
    for (const body of bodies) {
      expect(parseBrowserParams(body).ok).toBe(true);
    }
  });

  it("rejects a URL that is not http or https", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "about:blank",
      "chrome://version",
      "javascript:alert(1)",
    ]) {
      expect(parseBrowserParams({ action: "goto", url }).ok).toBe(false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    const r = parseBrowserParams({
      action: "goto",
      url: "https://user:pw@example.test/",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a URL that is not a URL, and one that is too long", () => {
    expect(parseBrowserParams({ action: "goto", url: "not a url" }).ok).toBe(
      false,
    );
    const long = `https://example.test/${"a".repeat(3000)}`;
    expect(parseBrowserParams({ action: "goto", url: long }).ok).toBe(false);
  });

  it("requires the field each action needs", () => {
    expect(parseBrowserParams({ action: "goto" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "click" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "fill", selector: "#a" }).ok).toBe(
      false,
    );
    expect(parseBrowserParams({ action: "fill", text: "x" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "press" }).ok).toBe(false);
  });

  it("keeps the viewport range strict, with no clamping", () => {
    for (const viewport of [
      { width: 100, height: 800 },
      { width: 1280, height: 9000 },
      { width: 1280.5, height: 800 },
      { width: "1280", height: 800 },
      [1280, 800],
    ]) {
      expect(parseBrowserParams({ action: "snapshot", viewport }).ok).toBe(
        false,
      );
    }
    const ok = parseBrowserParams({
      action: "snapshot",
      viewport: { width: 320, height: 2560 },
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects a non-boolean fullPage", () => {
    expect(
      parseBrowserParams({ action: "screenshot", fullPage: "yes" }).ok,
    ).toBe(false);
  });
});

// --- the pool ---------------------------------------------------------------

describe("screenshot provenance", () => {
  it("omits query and fragment from the caption and filename", () => {
    expect(
      describeShot("https://example.test/path?q=private#fragment"),
    ).toEqual({
      filename: "example.test-path.png",
      caption: "https://example.test/path",
    });
    expect(describeShot("file:///private/file")).toEqual({
      filename: "page.png",
      caption: "",
    });
  });
});

it("tabs and opaque targets have a bounded explicit schema", () => {
  expect(parseBrowserParams({ action: "tabs" })).toMatchObject({
    ok: true,
    action: "tabs",
  });
  const target = crypto.randomUUID();
  expect(parseBrowserParams({ action: "snapshot", target })).toMatchObject({
    ok: true,
    target,
  });
  for (const invalid of [7, "7", "", "x".repeat(1000), null, {}])
    expect(
      parseBrowserParams({ action: "snapshot", target: invalid }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
  expect(parseBrowserParams({ action: "tabs", target })).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
});

it("frame paths are bounded structural hints for reads and element actions", () => {
  for (const action of [
    "click",
    "fill",
    "press",
    "upload",
    "snapshot",
    "text",
  ]) {
    expect(
      parseBrowserParams({
        action,
        selector: "input",
        framePath: [0, 1],
        text: "fixture",
        key: "Enter",
        path: "/tmp/fixture.txt",
      }),
    ).toMatchObject({ ok: true, framePath: [0, 1] });
  }
  for (const framePath of [
    null,
    "iframe",
    [-1],
    [0.5],
    [Infinity],
    [Number.MAX_SAFE_INTEGER + 1],
    Array(9).fill(0),
    ["0"],
  ])
    expect(
      parseBrowserParams({ action: "click", selector: "button", framePath }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
  for (const action of ["goto", "tabs", "close", "screenshot", "press"])
    expect(parseBrowserParams({ action, framePath: [] })).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
});

it("read scopes accept an optional strict selector and frame independently", () => {
  for (const action of ["snapshot", "text"]) {
    expect(parseBrowserParams({ action, framePath: [0] })).toMatchObject({
      ok: true,
      framePath: [0],
    });
    expect(parseBrowserParams({ action, selector: "#late" })).toMatchObject({
      ok: true,
      selector: "#late",
    });
    for (const selector of [null, 1, "", "x".repeat(501)])
      expect(parseBrowserParams({ action, selector })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
  }
});
