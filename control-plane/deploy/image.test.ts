// What goes into the provisioner's image, held by a test rather than by care.
//
// Two things drift silently and cost a lot when they do:
//
//   THE DEPENDENCY SPEC. The image installs its own one-line manifest, so a
//   `pg` bumped in the repository would leave the deployed provisioner on the
//   old one - running a version the suite never ran against, which is the
//   quietest kind of difference between what was tested and what is deployed.
//
//   THE BUILD CONTEXT. `COPY control-plane` carries control-plane/web unless
//   /.dockerignore excludes it, and web is 901 MB of the directory's 903 MB. A
//   rule that stops working does not fail; it just ships a web app into a
//   machine that holds provider credentials.
//
// The context check is INTENT, not an emulation of Docker. The matcher it
// implements the rules with - deny-all, re-include, `**` at any depth, last
// match wins - moved to build-context.ts, because the deploy guard in
// provisioner-move-run.ts asks the same question about the same rules and two
// copies of it would eventually answer differently. What stays here is the
// decision for named paths. Docker's own answer is checked once more against
// reality when a build reports its context size, which control-plane/README.md
// records.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { assertRuntimeFiles } from "./assert-runtime-files.ts";
import { patternToRegExp, shipsToImage } from "./build-context.ts";

const REPO = path.join(import.meta.dir, "..", "..");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function dependencies(file: string): Record<string, string> {
  const value = readJson(file).dependencies;
  return (value ?? {}) as Record<string, string>;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "web" || entry.name === "node_modules"
        ? []
        : sourceFiles(file);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [file]
      : [];
  });
}

const included = shipsToImage;

describe("the deploy manifest", () => {
  test("names exactly one dependency", () => {
    const deploy = dependencies(path.join(import.meta.dir, "package.json"));
    expect(Object.keys(deploy)).toEqual(["pg"]);
  });

  test("pins pg to the same spec as the repository", () => {
    const deploy = dependencies(path.join(import.meta.dir, "package.json"));
    const repo = dependencies(path.join(REPO, "package.json"));
    expect(deploy.pg).toBe(repo.pg);
  });

  test("the lockfile is committed beside it", () => {
    expect(fs.existsSync(path.join(import.meta.dir, "bun.lock"))).toBe(true);
  });
});

describe("the build context", () => {
  const rules = fs
    .readFileSync(path.join(REPO, ".dockerignore"), "utf8")
    .split("\n");

  test("the matcher itself matches what these patterns mean", () => {
    // The matcher is the part that broke silently once, so it is checked
    // directly rather than only through the decisions it feeds.
    const matches = (pattern: string, subject: string) =>
      patternToRegExp(pattern).test(subject);

    expect(matches("**/*.test.ts", "control-plane/store.test.ts")).toBe(true);
    expect(matches("**/*.test.ts", "store.test.ts")).toBe(true);
    expect(matches("**/*.test.ts", "store.test.tsx")).toBe(false);
    expect(matches("**/node_modules", "control-plane/web/node_modules")).toBe(
      true,
    );
    // One path component, so a deny-all hits top-level entries and reaches
    // what is under them through their ancestors, not through the pattern.
    expect(matches("*", "server")).toBe(true);
    expect(matches("*", ".git")).toBe(true);
    expect(matches("*", "server/isomux-office.ts")).toBe(false);
    expect(matches("control-plane/web", "control-plane/web")).toBe(true);
    expect(matches("control-plane/web", "control-plane/webhooks")).toBe(false);
  });

  test("carries the provisioner", () => {
    for (const kept of [
      "control-plane/cli.ts",
      "control-plane/store.ts",
      "control-plane/remote/mint-invite.sh",
      "control-plane/contabo/adapter.ts",
      "control-plane/deploy/package.json",
      "control-plane/deploy/bun.lock",
      "deploy/install.sh",
    ]) {
      expect({ path: kept, sent: included(rules, kept) }).toEqual({
        path: kept,
        sent: true,
      });
    }
  });

  test("carries nothing else", () => {
    for (const dropped of [
      "control-plane/web/app/page.tsx",
      "control-plane/web/node_modules/next/index.js",
      "control-plane/store.test.ts",
      "control-plane/deploy/image.test.ts",
      "node_modules/pg/lib/index.js",
      "server/isomux-office.ts",
      "ui/app.tsx",
      "site/index.html",
      ".git/config",
      "package.json",
      "deploy/oom-protect.sh",
    ]) {
      expect({ path: dropped, sent: included(rules, dropped) }).toEqual({
        path: dropped,
        sent: false,
      });
    }
  });

  test("the web directory is excluded by a rule of its own", () => {
    // Not merely as a side effect of the deny-all: `!control-plane` brings the
    // whole directory back, so web needs its own line, and this is what fails
    // if somebody removes it.
    const withoutWebRule = rules.filter(
      (r) => r.trim() !== "control-plane/web",
    );
    expect(included(withoutWebRule, "control-plane/web/app/page.tsx")).toBe(
      true,
    );
    expect(included(rules, "control-plane/web/app/page.tsx")).toBe(false);
  });

  test("asserts every runtime-read repository file inside the image", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dir, "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("COPY deploy/install.sh ./deploy/install.sh");
    expect(dockerfile).toContain(
      "RUN bun control-plane/deploy/assert-runtime-files.ts",
    );
    expect(() => assertRuntimeFiles()).not.toThrow();

    const emptyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "isomux-runtime-files-"),
    );
    try {
      expect(() => assertRuntimeFiles(emptyRoot)).toThrow(
        `Missing provisioner runtime file: ${emptyRoot}/control-plane/remote/authorized-keys.sh`,
      );
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("bakes an actual payload digest and only accepts a well-formed source claim", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dir, "Dockerfile"),
      "utf8",
    );
    const start = dockerfile.indexOf("RUN payload_sha256=");
    const end = dockerfile.indexOf("\n\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-bake-"));
    const output = path.join(
      root,
      "control-plane",
      "deploy",
      "release-identity.json",
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const payload = path.join(root, "control-plane", "payload.ts");
    fs.writeFileSync(payload, "first\n");
    const script = dockerfile
      .slice(start, end)
      .replace(/^RUN /, "")
      .replaceAll("\\\n", " ")
      .replaceAll("/app", root);
    const run = (commit = "", started = "") => {
      fs.rmSync(output, { force: true });
      return Bun.spawnSync(["sh", "-c", script], {
        env: {
          PATH: process.env.PATH ?? "",
          ISOMUX_RELEASE_COMMIT: commit,
          ISOMUX_DEPLOY_STARTED_AT: started,
        },
      });
    };
    try {
      const absent = run();
      expect(absent.exitCode).toBe(0);
      const first = JSON.parse(fs.readFileSync(output, "utf8")) as Record<
        string,
        unknown
      >;
      expect(first).toEqual({
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      fs.writeFileSync(payload, "second\n");
      expect(run().exitCode).toBe(0);
      const second = JSON.parse(fs.readFileSync(output, "utf8")) as Record<
        string,
        unknown
      >;
      expect(second.payload_sha256).not.toBe(first.payload_sha256);

      const commit = "a".repeat(40);
      const started = "2026-08-20T12:34:56.789Z";
      expect(run(commit, started).exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        commit,
        deploy_started_at: started,
      });

      for (const [badCommit, badStarted] of [
        ["abc", started],
        [commit, "not-a-timestamp"],
        [commit, ""],
        ["", started],
      ]) {
        expect(run(badCommit, badStarted).exitCode).not.toBe(0);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime payload paths cannot bypass the inventory", () => {
    const bypasses: string[] = [];
    for (const file of sourceFiles(path.join(REPO, "control-plane"))) {
      if (file.endsWith("/runtime-files.ts")) continue;
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          node.text.endsWith(".sh") &&
          !path.isAbsolute(node.text)
        ) {
          bypasses.push(`${path.relative(REPO, file)}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(bypasses).toEqual([]);
  });
});
