import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isHostedAccess, readInstallKind } from "./install-kind.ts";

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

describe("access install kind", () => {
  it("uses the marker even with no hosted origin", () => {
    expect(isHostedAccess("hosted", "https://custom.example")).toBe(true);
    expect(isHostedAccess("hosted", null)).toBe(true);
  });
  it("recognizes the configured hosted suffix without a marker", () => {
    expect(isHostedAccess("self-hosted", "https://office.isomux.app")).toBe(
      true,
    );
    expect(isHostedAccess("self-hosted", "https://OFFICE.ISOMUX.APP")).toBe(
      true,
    );
    expect(isHostedAccess("self-hosted", "https://isomux.app")).toBe(true);
  });
  it("leaves other origins self-hosted, including lookalikes", () => {
    for (const origin of [
      null,
      "invalid",
      "http://office.isomux.app",
      "https://notisomux.app",
      "https://office.isomux.app.evil.example",
      "https://isomux.app@custom.example",
      "https://custom.example/isomux.app",
    ]) {
      expect(isHostedAccess("self-hosted", origin)).toBe(false);
    }
  });
});
