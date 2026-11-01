// Isomux's file tools for a Codex agent at the folder and web stops (task
// 25015e41): one call of read_file, list_dir or grep_files, as the child
// process runs it. Every path the model names, and every file a walk reaches,
// stays inside the agent's folder; nothing follows a symlink out; a secret in
// the folder is never read, by name or by search.
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FOLDER_FILES_LIMITS,
  folderFilesCall,
  type FolderFilesRequest,
  type FolderFilesResult,
} from "./folder-files.ts";
import type { AgentAccess } from "../shared/agent-access.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// A folder and, beside it, an outside folder with a file the model must
// never see. MARK is in files on both sides, so a search shows which side
// it reached.
const MARK = "needle-25015e41";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folder-files-")));
  made.push(root);
  const folder = join(root, "agent");
  const outside = join(root, "outside");
  mkdirSync(join(folder, "sub", "deep"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(folder, "a.txt"), `alpha\n${MARK} in a\ngamma\n`);
  writeFileSync(join(folder, "sub", "b.md"), `${MARK} in b\n`);
  writeFileSync(join(folder, "sub", "deep", "c.txt"), "no match here\n");
  writeFileSync(join(outside, "secret.txt"), `${MARK} outside\n`);
  return { root, folder, outside };
}

function call(
  folder: string,
  tool: FolderFilesRequest["tool"],
  args: unknown,
  access: AgentAccess = "folder",
): FolderFilesResult {
  return folderFilesCall({ tool, args, folder, access });
}

function text(result: FolderFilesResult): string {
  expect(result).toMatchObject({ ok: true });
  return (result as { text: string }).text;
}

function refused(result: FolderFilesResult): void {
  expect(result).toMatchObject({ ok: false });
  expect((result as { error: string }).error.length).toBeGreaterThan(0);
}

describe("read_file", () => {
  it("reads a file in the folder by an absolute or a relative path, with line numbers", () => {
    const { folder } = fixture();
    for (const file_path of [
      join(folder, "a.txt"),
      "a.txt",
      "./sub/../a.txt",
    ]) {
      const out = text(call(folder, "read_file", { file_path }));
      expect({ file_path, lines: out.split("\n").filter(Boolean) }).toEqual({
        file_path,
        lines: ["L1: alpha", `L2: ${MARK} in a`, "L3: gamma"],
      });
    }
  });

  it("offset is a 1-based line and limit a count of lines", () => {
    const { folder } = fixture();
    const out = text(
      call(folder, "read_file", { file_path: "a.txt", offset: 2, limit: 1 }),
    );
    expect(out.split("\n").filter(Boolean)).toEqual([`L2: ${MARK} in a`]);
  });

  it("cuts a long line and keeps the answer under the output cap", () => {
    const { folder } = fixture();
    const long = "x".repeat(FOLDER_FILES_LIMITS.maxLineChars * 3);
    writeFileSync(join(folder, "long.txt"), `${long}\nshort\n`);
    const lines = text(call(folder, "read_file", { file_path: "long.txt" }))
      .split("\n")
      .filter(Boolean);
    expect(lines[0].startsWith("L1: x")).toBe(true);
    expect(lines[0].length).toBeLessThanOrEqual(
      "L1: ".length + FOLDER_FILES_LIMITS.maxLineChars,
    );
    expect(lines[1]).toBe("L2: short");

    // 3,000 lines of 400 characters: about 1.2 MB asked for.
    const many = Array.from({ length: 3000 }, (_, i) =>
      `${i}`.padEnd(400, "y"),
    ).join("\n");
    writeFileSync(join(folder, "many.txt"), many);
    const out = text(
      call(folder, "read_file", { file_path: "many.txt", limit: 3000 }),
    );
    expect(out.startsWith("L1: 0y")).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(
      FOLDER_FILES_LIMITS.maxOutputBytes,
    );
  });

  it("refuses a binary file", () => {
    const { folder } = fixture();
    writeFileSync(join(folder, "img.bin"), Buffer.from([0x89, 0x50, 0, 1, 2]));
    refused(call(folder, "read_file", { file_path: "img.bin" }));
  });

  it("refuses every path that leaves the folder", () => {
    const { root, folder, outside } = fixture();
    symlinkSync(join(outside, "secret.txt"), join(folder, "link-out.txt"));
    symlinkSync(outside, join(folder, "dir-out"));
    const paths = [
      join(outside, "secret.txt"),
      "../outside/secret.txt",
      "sub/../../outside/secret.txt",
      "link-out.txt",
      "dir-out/secret.txt",
      "~/secret.txt",
      "~",
      root,
      "/etc/hostname",
    ];
    for (const file_path of paths) {
      const result = call(folder, "read_file", { file_path });
      expect({ file_path, ok: result.ok }).toEqual({ file_path, ok: false });
      expect(JSON.stringify(result)).not.toContain(MARK);
    }
  });

  it("a symlink that stays inside the folder reads", () => {
    const { folder } = fixture();
    symlinkSync(join(folder, "a.txt"), join(folder, "link-in.txt"));
    expect(
      text(call(folder, "read_file", { file_path: "link-in.txt" })),
    ).toContain(MARK);
  });

  it("refuses a secret in the folder", () => {
    const { folder } = fixture();
    writeFileSync(join(folder, ".env"), "API_KEY=sk-folder-secret\n");
    const result = call(folder, "read_file", { file_path: ".env" });
    refused(result);
    expect(JSON.stringify(result)).not.toContain("sk-folder-secret");
  });

  it("reads nothing at a stop without the folder, or with a malformed call", () => {
    const { folder } = fixture();
    for (const access of ["chat", "office", "standard"] as const) {
      const result = call(folder, "read_file", { file_path: "a.txt" }, access);
      expect({ access, ok: result.ok }).toEqual({ access, ok: false });
    }
    for (const args of [null, "a.txt", {}, { file_path: 7 }]) {
      const result = call(folder, "read_file", args);
      expect({ args, ok: result.ok }).toEqual({ args, ok: false });
    }
    refused(
      folderFilesCall({
        tool: "write_file" as FolderFilesRequest["tool"],
        args: { file_path: "a.txt" },
        folder,
        access: "folder",
      }),
    );
  });
});

// list_dir's answer: one entry per line, indented by depth, "/" after a
// folder and "@" after a symlink (Codex's own list_dir format).
function entries(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("list_dir", () => {
  it("lists the folder with folders and symlinks marked, and never walks a symlink", () => {
    const { folder, outside } = fixture();
    symlinkSync(outside, join(folder, "dir-out"));
    const listed = entries(
      text(call(folder, "list_dir", { dir_path: folder, depth: 3 })),
    );
    for (const entry of ["a.txt", "sub/", "b.md", "deep/", "c.txt", "dir-out@"])
      expect({ entry, listed: listed.includes(entry) }).toEqual({
        entry,
        listed: true,
      });
    expect(listed.join("\n")).not.toContain("secret.txt");
  });

  it("depth bounds the walk", () => {
    const { folder } = fixture();
    const listed = entries(
      text(call(folder, "list_dir", { dir_path: ".", depth: 1 })),
    );
    expect(listed).toContain("sub/");
    expect(listed).not.toContain("b.md");
  });

  it("refuses a folder outside, by path or through a symlink", () => {
    const { folder, outside } = fixture();
    symlinkSync(outside, join(folder, "dir-out"));
    for (const dir_path of [outside, "..", "dir-out", "~"]) {
      const result = call(folder, "list_dir", { dir_path });
      expect({ dir_path, ok: result.ok }).toEqual({ dir_path, ok: false });
      expect(JSON.stringify(result)).not.toContain("secret.txt");
    }
  });
});

describe("grep_files", () => {
  it("names the files in the folder that match, and only those", () => {
    const { folder } = fixture();
    const out = text(call(folder, "grep_files", { pattern: MARK }));
    expect(out).toContain("a.txt");
    expect(out).toContain("b.md");
    expect(out).not.toContain("c.txt");
  });

  it("include and path narrow the search", () => {
    const { folder } = fixture();
    const byGlob = text(
      call(folder, "grep_files", { pattern: MARK, include: "*.md" }),
    );
    expect(byGlob).toContain("b.md");
    expect(byGlob).not.toContain("a.txt");
    const byPath = text(
      call(folder, "grep_files", { pattern: MARK, path: "sub" }),
    );
    expect(byPath).toContain("b.md");
    expect(byPath).not.toContain("a.txt");
  });

  it("never reaches a file outside, through a symlink or a path", () => {
    const { folder, outside } = fixture();
    symlinkSync(join(outside, "secret.txt"), join(folder, "link-out.txt"));
    symlinkSync(outside, join(folder, "dir-out"));
    const out = text(call(folder, "grep_files", { pattern: "outside" }));
    expect(out).not.toContain("link-out.txt");
    expect(out).not.toContain("secret.txt");
    for (const path of [outside, "..", "dir-out", "~"]) {
      const result = call(folder, "grep_files", { pattern: MARK, path });
      expect({ path, ok: result.ok }).toEqual({ path, ok: false });
    }
  });

  // A search answers whether a file holds a pattern: on a secret file that
  // reads the secret one guess at a time.
  it("never searches a secret in the folder", () => {
    const { folder } = fixture();
    writeFileSync(join(folder, ".env"), "API_KEY=sk-folder-secret\n");
    mkdirSync(join(folder, "keys"));
    writeFileSync(join(folder, "keys", "id_ed25519"), "sk-folder-secret\n");
    writeFileSync(join(folder, "plain.txt"), "sk-folder-secret\n");
    const out = text(call(folder, "grep_files", { pattern: "sk-folder" }));
    // The control: the same text in a plain file is found.
    expect(out).toContain("plain.txt");
    expect(out).not.toContain(".env");
    expect(out).not.toContain("id_ed25519");
  });

  it("reads a file only up to the per-file cap", () => {
    const { folder } = fixture();
    const tail = "late-needle-25015e41";
    writeFileSync(
      join(folder, "big.log"),
      `${"z".repeat(FOLDER_FILES_LIMITS.maxBytesPerFile + 1024)}\n${tail}\n`,
    );
    writeFileSync(join(folder, "small.log"), `${tail}\n`);
    const out = text(call(folder, "grep_files", { pattern: tail }));
    expect(out).toContain("small.log");
    expect(out).not.toContain("big.log");
  });

  it("limit bounds the answer, and a bad pattern is an error", () => {
    const { folder } = fixture();
    for (let i = 0; i < 5; i++)
      writeFileSync(join(folder, `m${i}.txt`), `${MARK}\n`);
    const out = text(call(folder, "grep_files", { pattern: MARK, limit: 2 }));
    expect(
      out.split("\n").filter((l) => l.includes(".txt") || l.includes(".md"))
        .length,
    ).toBe(2);
    refused(call(folder, "grep_files", { pattern: "(" }));
  });
});
