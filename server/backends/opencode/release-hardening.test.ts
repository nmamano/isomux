import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OPENCODE_CLI_VERSION, resolveOpenCodeBinary } from "./runtime";

const repoRoot = join(import.meta.dir, "../../..");

describe("OpenCode release pin", () => {
  // Nil, 2026-10-23 and 2026-10-25: @opencode/cli 2.1.4, exact, with no
  // OpenCode 1 package left beside it (task e47be82a).
  it("pins the package exactly, the selected platform package, and every Linux lock entry", async () => {
    const manifest = await Bun.file(join(repoRoot, "package.json")).json();
    expect(OPENCODE_CLI_VERSION).toBe("2.1.4");
    expect(manifest.dependencies["@opencode/cli"]).toBe(OPENCODE_CLI_VERSION);
    expect(
      Object.entries(manifest.dependencies as Record<string, string>).filter(
        ([name, spec]) =>
          name.startsWith("opencode") || spec.includes("opencode-ai"),
      ),
      "no OpenCode 1 package",
    ).toEqual([]);

    const packageRoot = dirname(dirname(resolveOpenCodeBinary()));
    const selectedPackage = await Bun.file(
      join(packageRoot, "package.json"),
    ).json();
    expect(selectedPackage.version).toBe(OPENCODE_CLI_VERSION);

    const lock = await readFile(join(repoRoot, "bun.lock"), "utf8");
    const entries = [
      ...lock.matchAll(
        /^\s*"(@opencode\/cli-linux-[^"]+)": \["[^"]+@([^"]+)", "",[^\n]+"(sha512-[^"]+)"\],$/gm,
      ),
    ];
    // The six Linux builds of 2.1.4 (gate S10, mg-s10-update-pin.json).
    expect(entries.map((entry) => entry[1]).sort()).toEqual([
      "@opencode/cli-linux-arm64",
      "@opencode/cli-linux-arm64-musl",
      "@opencode/cli-linux-x64",
      "@opencode/cli-linux-x64-baseline",
      "@opencode/cli-linux-x64-baseline-musl",
      "@opencode/cli-linux-x64-musl",
    ]);
    for (const [, , version, integrity] of entries) {
      expect(version).toBe(OPENCODE_CLI_VERSION);
      expect(integrity).toStartWith("sha512-");
    }
  });
});
