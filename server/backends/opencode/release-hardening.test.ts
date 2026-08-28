import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OPENCODE_CLI_VERSION, resolveOpenCodeBinary } from "./runtime";

const repoRoot = join(import.meta.dir, "../../..");

describe("OpenCode release pin", () => {
  it("pins the alias, selected platform package, and every Linux lock entry", async () => {
    const manifest = await Bun.file(join(repoRoot, "package.json")).json();
    expect(manifest.dependencies["opencode-v1"]).toBe(
      `npm:opencode-ai@${OPENCODE_CLI_VERSION}`,
    );

    const packageRoot = dirname(dirname(resolveOpenCodeBinary()));
    const selectedPackage = await Bun.file(join(packageRoot, "package.json")).json();
    expect(selectedPackage.version).toBe(OPENCODE_CLI_VERSION);

    const lock = await readFile(join(repoRoot, "bun.lock"), "utf8");
    const entries = [
      ...lock.matchAll(
        /^\s*"(opencode-linux-[^"]+)": \["[^"]+@([^"]+)", "",[^\n]+"(sha512-[^"]+)"\],$/gm,
      ),
    ];
    expect(entries.map((entry) => entry[1]).sort()).toEqual([
      "opencode-linux-arm64",
      "opencode-linux-arm64-musl",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64-musl",
    ]);
    for (const [, , version, integrity] of entries) {
      expect(version).toBe(OPENCODE_CLI_VERSION);
      expect(integrity).toStartWith("sha512-");
    }
  });
});
