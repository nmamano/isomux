import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const exporter = new URL("./context.py", import.meta.url).pathname;
test("production context uses committed regular files and excludes private and untracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "container-context-"));
  const run = (...args: string[]) =>
    spawnSync(args[0], args.slice(1), { cwd: root, encoding: "utf8" });
  try {
    expect(run("git", "init", "-q").status).toBe(0);
    mkdirSync(join(root, "server/private"), { recursive: true });
    writeFileSync(join(root, "server/main.ts"), "committed");
    writeFileSync(join(root, "server/private/note"), "synthetic-private");
    writeFileSync(join(root, ".mcp.json"), "synthetic-private");
    expect(run("git", "add", ".").status).toBe(0);
    expect(
      run(
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ).status,
    ).toBe(0);
    writeFileSync(join(root, "server/main.ts"), "dirty");
    writeFileSync(join(root, "server/untracked.ts"), "synthetic-untracked");
    expect(run("python3", exporter, "HEAD", "first.tar").status).toBe(0);
    expect(
      run("tar", "tf", "first.tar").stdout.trim().split("\n").sort(),
    ).toEqual(["server/main.ts", "version-info.json"]);
    const identity = JSON.parse(
      run("tar", "xOf", "first.tar", "version-info.json").stdout,
    );
    expect(identity.commit).toBe(run("git", "rev-parse", "HEAD").stdout.trim());
    expect(identity.release).toBeNull();
    expect(identity.version).toBe(identity.commit);
    expect(run("tar", "xOf", "first.tar", "server/main.ts").stdout).toBe(
      "committed",
    );
    expect(run("python3", exporter, "HEAD", "second.tar").status).toBe(0);
    expect(readFileSync(join(root, "first.tar"))).toEqual(
      readFileSync(join(root, "second.tar")),
    );
    const selected = run("git", "rev-parse", "HEAD").stdout.trim();
    expect(run("git", "tag", "v2099.1.2", selected).status).toBe(0);
    expect(run("git", "tag", "v2099.1.10", selected).status).toBe(0);
    expect(run("python3", exporter, selected, "release.tar").status).toBe(0);
    expect(
      JSON.parse(run("tar", "xOf", "release.tar", "version-info.json").stdout),
    ).toEqual({
      commit: selected,
      release: "v2099.1.10",
      version: "v2099.1.10",
    });
    symlinkSync("/outside", join(root, "server/link"));
    expect(run("git", "add", "server/link").status).toBe(0);
    expect(
      run(
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "link",
      ).status,
    ).toBe(0);
    expect(run("python3", exporter, "HEAD", "rejected.tar").status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Render build has the same image and context contract", () => {
  for (const name of ["Dockerfile", "Dockerfile.dockerignore"]) {
    expect(
      readFileSync(new URL(`../render/${name}`, import.meta.url), "utf8"),
    ).toBe(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
  }
});
