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
// The context check is INTENT, not an emulation of Docker. It implements the
// rules this file's patterns use - deny-all, re-include, `**` at any depth,
// last match wins - and asserts the decision for named paths. Docker's own
// answer is checked once more against reality when a build reports its context
// size, which control-plane/README.md records.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.join(import.meta.dir, "..", "..");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function dependencies(file: string): Record<string, string> {
  const value = readJson(file).dependencies;
  return (value ?? {}) as Record<string, string>;
}

/**
 * One .dockerignore pattern, as a regular expression over a whole path.
 *
 * Scanned character by character rather than through a chain of replacements.
 * A chain needs a placeholder to hold `**` while `*` is being rewritten, and a
 * placeholder is a character that can turn out to mean something else: the
 * first version of this function used one, and two of its rules silently
 * matched nothing.
 */
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        out += "(?:.*/)?"; // any number of leading directories, or none
      } else {
        out += ".*";
      }
    } else if (character === "*") {
      out += "[^/]*"; // one path component
    } else if (character === "?") {
      out += "[^/]";
    } else {
      out += character.replace(/[.+^${}()|[\]\\/]/, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Would Docker send this path, given those rules?
 *
 * A pattern matches a path when it matches the path itself or any of its
 * ancestors, because excluding a directory excludes what is under it. The last
 * matching rule decides, which is what makes `!control-plane` able to bring
 * back one branch of a deny-all.
 */
function included(dockerignore: string[], filePath: string): boolean {
  const parts = filePath.split("/");
  const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let keep = true;
  for (const raw of dockerignore) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const expression = patternToRegExp(negated ? line.slice(1) : line);
    if (ancestors.some((a) => expression.test(a))) keep = negated;
  }
  return keep;
}

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
});
