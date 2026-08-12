// Which repository paths end up inside the provisioner's image.
//
// `fly deploy .` sends the working DIRECTORY as the build context, and
// /.dockerignore decides what of it travels. Two things need that answer and
// they must not answer it differently:
//
//   deploy/image.test.ts   asserts the intent - the UI, the tests and 1.2 GB of
//                          node_modules stay out, the provisioner goes in.
//   provisioner-move-run   refuses to deploy while a SHIPPED path differs from
//                          HEAD, because the image would then carry code that
//                          is in no commit.
//
// The matcher lived in the test until now. It is here instead because the test
// says of it, correctly, that it is "the part that broke silently once": a
// second copy of a rule set with `**`, negation and last-match-wins is a copy
// that will disagree with the first one eventually, and the disagreement would
// show up as a deploy guard that passes on a file the image actually carries.
//
// This is INTENT, not an emulation of Docker. It implements the rules these
// patterns use - deny-all, re-include, `**` at any depth, last match wins - and
// Docker's own answer is checked against reality when a build reports its
// context size, which control-plane/README.md records.

import * as fs from "node:fs";
import * as path from "node:path";

/** The repository root, which is also the build context `fly deploy .` sends. */
export const REPO_ROOT = path.join(import.meta.dir, "..", "..");

/**
 * One .dockerignore pattern, as a regular expression over a whole path.
 *
 * Scanned character by character rather than through a chain of replacements.
 * A chain needs a placeholder to hold `**` while `*` is being rewritten, and a
 * placeholder is a character that can turn out to mean something else: the
 * first version of this function used one, and two of its rules silently
 * matched nothing.
 */
export function patternToRegExp(pattern: string): RegExp {
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
export function shipsToImage(
  rules: readonly string[],
  filePath: string,
): boolean {
  const parts = filePath.split("/");
  const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let keep = true;
  for (const raw of rules) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const expression = patternToRegExp(negated ? line.slice(1) : line);
    if (ancestors.some((a) => expression.test(a))) keep = negated;
  }
  return keep;
}

/** The rules as the repository carries them, read at the moment they are used. */
export function contextRules(root: string = REPO_ROOT): string[] {
  return fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n");
}
