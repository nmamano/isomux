import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { shipsToImage } from "../../control-plane/deploy/build-context.ts";
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

// The container's rescue command runs scripts/rescue.ts inside the office
// container (install-update-support.sh), and the owner export route runs
// server/office-export-main.ts (task cdd7883d). Each, and every file it
// imports, must be in the image by both build paths: the production context
// (context.py's allowed()) and the Dockerfile's own rules.
test("the image holds the rescue command and the export child, with every file they import", () => {
  const repo = new URL("../..", import.meta.url).pathname;
  // The relative-import closure of the two entries.
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue = ["scripts/rescue.ts", "server/office-export-main.ts"];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(repo, file), "utf8");
    for (const { path } of transpiler.scanImports(source)) {
      if (!path.startsWith(".")) continue;
      const target = relative(repo, resolve(repo, dirname(file), path));
      queue.push(existsSync(join(repo, target)) ? target : `${target}.ts`);
    }
  }
  const files = [...seen].sort();
  expect(files.length).toBeGreaterThan(2);

  const refused = spawnSync(
    "python3",
    [
      "-c",
      "import json, sys; sys.path.insert(0, sys.argv[1]); import context; " +
        "print(json.dumps([p for p in json.loads(sys.argv[2]) if not context.allowed(p)]))",
      dirname(exporter),
      JSON.stringify(files),
    ],
    { encoding: "utf8" },
  );
  expect(refused.status).toBe(0);
  const rules = readFileSync(
    new URL("./Dockerfile.dockerignore", import.meta.url),
    "utf8",
  ).split("\n");
  expect({
    contextPy: JSON.parse(refused.stdout),
    dockerignore: files.filter((file) => !shipsToImage(rules, file)),
  }).toEqual({ contextPy: [], dockerignore: [] });
});
