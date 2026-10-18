// The office id (server/office-id.ts) names this office's session cookies, so
// it must survive every restart, and a damaged file must neither crash the
// office into a loop nor silently rotate the id in place.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OFFICE_ID_PATTERN,
  officeIdFile,
  readOrCreateOfficeId,
} from "../office-id.ts";
import { officeSessionCookieNames, _testResetState } from "../auth.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { expectRejection } from "./expect-rejection.ts";

let dir: string | null = null;
let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), "office-id-"));
  return join(dir, "office-id");
}

describe("readOrCreateOfficeId", () => {
  it("creates a missing file with mode 0600, and reads the same id after", () => {
    const path = scratch();
    const first = readOrCreateOfficeId(path);
    expect(first.id).toMatch(OFFICE_ID_PATTERN);
    expect(first.replaced).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(first.id);
    expect(readOrCreateOfficeId(path).id).toBe(first.id);
  });

  it("accepts a valid id with a trailing newline, as an operator would write it", () => {
    const path = scratch();
    writeFileSync(path, "0123456789ab\n");
    expect(readOrCreateOfficeId(path)).toEqual({ id: "0123456789ab" });
  });

  for (const [label, bytes, reason] of [
    ["empty", "", "empty"],
    ["garbage", "not an id at all", "hex"],
    ["upper-case hex", "0123456789AB", "hex"],
    ["too long", "0123456789abc", "hex"],
  ] as const) {
    it(`moves a ${label} file aside with its bytes, and makes a new id once`, () => {
      const path = scratch();
      writeFileSync(path, bytes);
      const read = readOrCreateOfficeId(path, 1234);
      expect(read.id).toMatch(OFFICE_ID_PATTERN);
      expect(read.replaced?.asidePath).toBe(`${path}.invalid-1234`);
      expect(read.replaced?.problem).toContain(reason);
      // The original bytes are kept for the operator, never overwritten.
      expect(readFileSync(`${path}.invalid-1234`, "utf8")).toBe(bytes);
      expect(readFileSync(path, "utf8")).toBe(read.id);
      // The repair happens once: the next boot reads the new id.
      expect(readOrCreateOfficeId(path, 5678)).toEqual({ id: read.id });
      expect(readdirSync(dir!).sort()).toEqual(
        ["office-id", "office-id.invalid-1234"].sort(),
      );
    });
  }

  it.skipIf(process.getuid?.() === 0)(
    "throws when the file exists but cannot be read, and leaves it in place",
    () => {
      const path = scratch();
      writeFileSync(path, "0123456789ab");
      chmodSync(path, 0o000);
      try {
        expect(() => readOrCreateOfficeId(path)).toThrow();
        expect(readdirSync(dir!)).toEqual(["office-id"]);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("throws when a new id cannot be written", () => {
    const path = scratch();
    // The target's parent is a regular file, so no write can succeed.
    writeFileSync(join(dir!, "blocker"), "");
    expect(() =>
      readOrCreateOfficeId(join(dir!, "blocker", "office-id")),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("the office id at boot", () => {
  it("names the cookies, and a restart keeps the names", async () => {
    server = await startTestServer();
    const id = readFileSync(officeIdFile(), "utf8");
    expect(id).toMatch(OFFICE_ID_PATTERN);
    expect(officeSessionCookieNames()).toEqual({
      host: `__Host-isomux_session_${id}`,
      plain: `isomux_session_${id}`,
    });
    server = await server.restart();
    expect(officeSessionCookieNames().plain).toBe(`isomux_session_${id}`);
  });

  it("logs the path and the problem when it replaces a damaged file", async () => {
    server = await startTestServer();
    writeFileSync(officeIdFile(), "damaged");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      server = await server.restart();
      const lines = errors.mock.calls.map((call) => call.join(" "));
      const line = lines.find((l) => l.includes(officeIdFile())) ?? "";
      expect(line).toContain(`${officeIdFile()}.invalid-`);
      expect(line).toContain("hex");
      // Never the content.
      expect(line).not.toContain("damaged");
    } finally {
      errors.mockRestore();
    }
    const aside = readdirSync(server.stateRoot).filter((name) =>
      name.startsWith("office-id.invalid-"),
    );
    expect(aside.length).toBe(1);
    expect(readFileSync(join(server.stateRoot, aside[0]), "utf8")).toBe(
      "damaged",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses to boot when the file cannot be read",
    async () => {
      server = await startTestServer();
      const running = server;
      chmodSync(officeIdFile(), 0o000);
      try {
        await expectRejection(running.restart(), /EACCES|permission denied/i);
        server = null;
      } finally {
        chmodSync(officeIdFile(), 0o600);
        _testResetState();
      }
    },
  );
});
