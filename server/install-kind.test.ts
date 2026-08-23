import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readInstallKind } from "./install-kind.ts";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function marker(value: string): string {
  dir = mkdtempSync(join(tmpdir(), "isomux-install-kind-"));
  const path = join(dir, "install-kind");
  writeFileSync(path, value);
  return path;
}

describe("install kind marker", () => {
  it("recognizes only the exact hosted line", () => {
    expect(readInstallKind(marker("hosted\n"))).toBe("hosted");
  });

  it("treats absent, unreadable-shaped, or unrecognized content as self-hosted", () => {
    expect(readInstallKind("/no/such/isomux-install-kind")).toBe("self-hosted");
    expect(readInstallKind(marker("Hosted\n"))).toBe("self-hosted");
    expect(readInstallKind(marker("hosted\n\n"))).toBe("self-hosted");
  });
});
