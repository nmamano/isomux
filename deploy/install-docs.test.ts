import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const INSTALL_URL =
  "https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh";
const INSTALL_FETCH =
  /https:\/\/raw\.githubusercontent\.com\/nmamano\/isomux\/main\/deploy\/install\.sh/g;

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

function trackedMarkdown(): string[] {
  return trackedFiles().filter((relative) => relative.endsWith(".md"));
}

function fencedShellBlocks(source: string): string[] {
  return [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1],
  );
}

function isSafeInstallerFetch(block: string): boolean {
  const stage =
    /curl[^\n]*deploy\/install\.sh[^\n]*\s-o\s+["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?["']?/.exec(
      block,
    );
  if (!stage) return false;
  const runsStaged = new RegExp(
    `\\bbash\\s+["']?\\$\\{?${stage[1]}\\}?["']?(?:\\s|$)`,
  ).test(block);
  return runsStaged;
}

describe("documented installer transport", () => {
  it("accepts any consistent staged-file variable name", () => {
    expect(
      isSafeInstallerFetch(
        'f=$(mktemp)\ncurl -fsSL https://example/deploy/install.sh -o "$f"\nbash "$f"\n',
      ),
    ).toBe(true);
    expect(
      isSafeInstallerFetch(
        'f=$(mktemp)\ncurl -fsSL https://example/deploy/install.sh -o "$f"\nbash "$installer"\n',
      ),
    ).toBe(false);
  });

  it("stages every Markdown Isomux installer fetch", () => {
    const root = new URL("..", import.meta.url).pathname;
    for (const relative of trackedMarkdown()) {
      const source = readFileSync(join(root, relative), "utf8");
      const fetches = [...source.matchAll(INSTALL_FETCH)];
      if (fetches.length === 0) continue;

      const blocks = fencedShellBlocks(source).filter((block) =>
        block.includes(INSTALL_URL),
      );
      expect(blocks.length, relative).toBe(fetches.length);
      for (const block of blocks)
        expect(isSafeInstallerFetch(block)).toBe(true);
    }
  });

  it("keeps inline and piped Isomux installer recipes out of tracked files", () => {
    const root = new URL("..", import.meta.url).pathname;
    for (const relative of trackedFiles()) {
      if (relative === "deploy/install-docs.test.ts") continue;
      const source = readFileSync(join(root, relative), "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes(INSTALL_URL)) continue;
        expect(line.includes("$("), relative).toBe(false);
        const pipe = line.indexOf("|");
        if (pipe !== -1) {
          expect(/\b(?:bash|sh)\b/.test(line.slice(pipe + 1)), relative).toBe(
            false,
          );
        }
      }
    }
  });

  it("runs a payload above 131072 bytes from a staged file", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-install-docs-"));
    const installer = join(dir, "install.sh");
    const payload = `#${"x".repeat(140_000)}\nprintf 'staged-ok\\n'\n`;
    try {
      expect(Buffer.byteLength(payload)).toBeGreaterThan(131_072);
      writeFileSync(installer, payload);
      const staged = Bun.spawnSync(["bash", installer]);
      expect(staged.exitCode).toBe(0);
      expect(staged.stdout.toString()).toBe("staged-ok\n");

      try {
        // Observation only: some kernels accept this payload as one argument.
        const argument = Bun.spawnSync(["bash", "-c", payload]);
        if (argument.exitCode !== 0) expect(argument.exitCode).not.toBe(0);
      } catch (error) {
        expect(String(error)).toContain("E2BIG");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const live = process.env.ISOMUX_TEST_INSTALL_FETCH === "1" ? it : it.skip;
  live(
    "stages and parses the complete installer from the documented URL",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "isomux-install-fetch-"));
      const installer = join(dir, "install.sh");
      const headers = join(dir, "headers");
      try {
        const fetched = Bun.spawnSync([
          "curl",
          "-fsSL",
          "--dump-header",
          headers,
          "--write-out",
          "%{size_download}",
          INSTALL_URL,
          "-o",
          installer,
        ]);
        expect(fetched.exitCode).toBe(0);
        const downloaded = Number(fetched.stdout.toString());
        const lengths = [
          ...readFileSync(headers, "utf8").matchAll(
            /^content-length:\s*(\d+)\s*$/gim,
          ),
        ];
        const declared = Number(lengths.at(-1)?.[1]);
        expect(declared).toBeGreaterThan(131_072);
        expect(downloaded).toBe(declared);
        expect(statSync(installer).size).toBe(downloaded);
        expect(Bun.spawnSync(["bash", "-n", installer]).exitCode).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
