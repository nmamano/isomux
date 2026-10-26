// find runs other commands (-exec, -execdir, -ok, -okdir), deletes (-delete)
// and writes files (-fprint and its family). The hooks judge each of those as
// they judge the plain command (task 230d4a04). These commands are classified
// only; none of them execute.

import { describe, expect, it } from "bun:test";
import { homedir } from "os";
import { basename, join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  evaluateProposedAction,
  type PolicyContext,
  type PolicyDecision,
} from "./safety-policy.ts";

const OUTSIDE = "/tmp/probe-project";

// A shell whose home is a folder under the state root. No production shell
// runs with one any more (task 956b994b), and the policy must still refuse
// such an input through find's forms.
const profile = join(STATE_ROOT, "opencode", "profiles", "k");
const openCode: PolicyContext = {
  shellHome: join(profile, "home"),
  shellTmpDir: join(profile, "tmp"),
};

const run = (
  command: string,
  cwd: string = OUTSIDE,
  context: PolicyContext = {},
): PolicyDecision =>
  evaluateProposedAction({ kind: "shell", command }, { ...context, cwd });

// A denial names the command it refused, last; take that out to compare
// reasons. The reason itself can quote the plain command too.
const reasonWithout = (decision: PolicyDecision, command: string) => {
  if (decision.decision !== "deny") return null;
  const at = decision.reason.lastIndexOf(command);
  return at === -1
    ? decision.reason
    : decision.reason.slice(0, at) +
        "<command>" +
        decision.reason.slice(at + command.length);
};

// Test names stay the same from run to run.
const named = (command: string, cwd?: string) =>
  (cwd ? `${command} (cwd ${cwd})` : command)
    .split(STATE_ROOT)
    .join("<state root>");

const startPaths = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${OUTSIDE}/${prefix}${i}`).join(" ");
const overCap = `find ${startPaths("over", 129)} -exec grep x {} +`;
const script = (bytes: number) => "echo x; ".repeat(bytes / 8);
const singleQuoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// A find whose list runs bash -c with the next find, `levels` deep.
const nestedFinds = (levels: number, starts: number): string => {
  let line = `find ${startPaths(`${levels}-`, starts)} -exec grep x {} +`;
  for (let level = levels - 1; level > 0; level--)
    line = `find ${startPaths(`${level}-`, starts)} -exec bash -c ${singleQuoted(line)} x {} \\;`;
  return line;
};

type Refusal = {
  name?: string;
  command: string;
  // Plain commands that are refused for the reason the find form must give.
  // More than one when either path that {} stands for can be the one judged.
  plain: string[];
  cwd?: string;
  context?: PolicyContext;
};

const refused: Refusal[] = [
  // The task's three forms, and the other three exec actions.
  {
    command: "find . -name x -exec cp {} ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  {
    command: "find ~/.isomux/x -exec rm {} +",
    plain: ["rm ~/.isomux/x"],
  },
  { command: "find ~/.isomux/x -delete", plain: ["rm -r ~/.isomux/x"] },
  {
    command: `find ${STATE_ROOT}/x -delete`,
    plain: [`rm -r ${STATE_ROOT}/x`],
  },
  {
    command: "find . -name x -execdir cp {} ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  {
    command: "find . -name x -ok cp {} ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  {
    command: "find . -name x -okdir cp {} ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  {
    command: "find . -name x -exec cp {} ~/.isomux/x ';'",
    plain: ["cp a ~/.isomux/x"],
  },
  // {} is the start path itself: {}x appends to its name.
  {
    command: "find ~/.isomu -maxdepth 0 -exec touch {}x \\;",
    plain: ["touch ~/.isomux"],
  },
  // {} is a path below the start path.
  {
    command: "find ~/.isomux -exec cp a {}.bak \\;",
    plain: ["cp a ~/.isomux/f.bak"],
  },
  // The start path is a variable that holds the state root.
  {
    command: "D=~/.isomux; find $D -exec rm {} +",
    plain: ["D=~/.isomux; rm $D/x"],
  },
  // The exec word carries its own variable.
  {
    command: "X=x; find ~/.isomu -maxdepth 0 -exec touch {}$X \\;",
    plain: ["X=x; touch ~/.isomu$X"],
  },
  // + ends the list only right after {}; here it is cp's source operand.
  {
    command: "find . -exec cp + ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  // A second list after the first one ends.
  {
    command: "find . -exec echo {} + -exec cp a ~/.isomux/x \\;",
    plain: ["cp a ~/.isomux/x"],
  },
  // -execdir runs in the directory of each path find visits.
  {
    command: "find ~/.isomux -execdir touch new \\;",
    plain: ["cd ~/.isomux && touch new"],
  },
  // For a start path itself, -execdir runs in the directory that holds it.
  {
    command: "find ~/x -maxdepth 0 -execdir touch .isomux/y \\;",
    plain: ["cd ~ && touch .isomux/y"],
  },
  // The directory that holds ~ is the one above the home directory.
  {
    name: "find ~ -maxdepth 0 -execdir touch <home name>/.isomux/x",
    command: `find ~ -maxdepth 0 -execdir touch ${basename(homedir())}/.isomux/x \\;`,
    plain: [`cd ~/.. && touch ${basename(homedir())}/.isomux/x`],
  },
  // ~ is the shell's home, and HOME set on the line moves it, as for cd.
  {
    name: "find ~ -maxdepth 0 -execdir touch ../data/x (OpenCode shell)",
    command: "find ~ -maxdepth 0 -execdir touch ../data/x \\;",
    plain: ["cd ~ && touch ../data/x"],
    context: openCode,
  },
  {
    command: "HOME=~/.isomux; find ~ -execdir touch x \\;",
    plain: ["HOME=~/.isomux; cd ~ && touch x"],
  },
  {
    command: "find $X -execdir touch new \\;",
    plain: ["cd $X && touch new"],
  },
  // -exec runs in the directory find runs in.
  {
    command: `find ${OUTSIDE} -exec touch new \\;`,
    plain: ["touch new"],
    cwd: STATE_ROOT,
  },
  // The list is a command of its own: wrappers, shells and find again.
  {
    command: "find . -exec sudo cp a ~/.isomux/x \\;",
    plain: ["sudo cp a ~/.isomux/x"],
  },
  {
    command: "find . -exec bash -c 'cp a ~/.isomux/x' \\;",
    plain: ["bash -c 'cp a ~/.isomux/x'"],
  },
  {
    command: "find . -exec find ~/.isomux/x -delete \\;",
    plain: ["rm -r ~/.isomux/x"],
  },
  // -delete with no start path, or a relative one, deletes below the cwd.
  {
    command: "find -name x -delete",
    plain: ["rm -r ."],
    cwd: STATE_ROOT,
  },
  {
    command: "find . -name x -delete",
    plain: ["rm -r ."],
    cwd: STATE_ROOT,
  },
  // Leading options come before the start paths.
  {
    command: "find -L -O3 ~/.isomux/x -delete",
    plain: ["rm -r ~/.isomux/x"],
  },
  {
    command: "find -D stat ~/.isomux/x -delete",
    plain: ["rm -r ~/.isomux/x"],
  },
  // find creates or truncates the file each of these names.
  { command: "find . -fprint ~/.isomux/x", plain: ["cp a ~/.isomux/x"] },
  { command: "find . -fprint0 ~/.isomux/x", plain: ["cp a ~/.isomux/x"] },
  { command: "find . -fls ~/.isomux/x", plain: ["cp a ~/.isomux/x"] },
  {
    command: "find . -fprintf ~/.isomux/x '%p\\n'",
    plain: ["cp a ~/.isomux/x"],
  },
  // The other checks judge the list as they judge a bash -c payload.
  { command: "find /tmp -exec pkill bun \\;", plain: ["pkill bun"] },
  {
    command: "find /tmp -exec bash -c 'pkill bun' \\;",
    plain: ["bash -c 'pkill bun'"],
  },
  { command: "find . -exec cat .env \\;", plain: ["cat .env"] },
  {
    command: "find ~/.isomux/secrets -exec cat {} +",
    plain: ["cat ~/.isomux/secrets", "cat ~/.isomux/secrets/{}"],
  },
  // The runs of one line are bounded, finds inside bash -c payloads included:
  // each level multiplies them. Past the bound, the line is refused as one
  // find with too many start paths is.
  {
    name: "find with 8 start paths, nested 3 deep through bash -c",
    command: nestedFinds(3, 8),
    plain: [overCap],
  },
  // Every check parses each run again, so the text of the runs is bounded too.
  {
    name: "find with a 20 KB bash -c payload in a {} list",
    command: `find . -exec bash -c '${script(20 * 1024)}' x {} \\;`,
    plain: [overCap],
  },
  // A {} grows by the length of the start path in each run.
  {
    name: "find with 128 long start paths and 20 {} words",
    command: `find ${startPaths("d".repeat(180), 128)} -exec echo ${"{} ".repeat(20)}\\;`,
    plain: [overCap],
  },
  // The bound is known from the start paths and the lists, before any run is
  // made. Making the 10000 runs first takes seconds.
  {
    name: "find with 5000 start paths and 500 {} words",
    command: `find ${startPaths("many", 5000)} -exec echo ${"{} ".repeat(500)}\\;`,
    plain: [overCap],
  },
];

const allowed: { command: string; cwd?: string }[] = [
  // The refused forms on paths outside the state root.
  { command: `find . -name x -exec cp {} ${OUTSIDE}/x \\;` },
  { command: `find ${OUTSIDE}/x -exec rm {} +` },
  { command: `find ${OUTSIDE}/x -delete` },
  { command: `find . -name x -execdir cp {} ${OUTSIDE}/x \\;` },
  { command: `find . -name x -ok cp {} ${OUTSIDE}/x \\;` },
  { command: `find . -name x -okdir cp {} ${OUTSIDE}/x \\;` },
  { command: `find ${OUTSIDE} -maxdepth 0 -exec touch {}x \\;` },
  { command: `find ${OUTSIDE} -exec cp a {}.bak \\;` },
  { command: `D=${OUTSIDE}; find $D -exec rm {} +` },
  { command: `X=x; find ${OUTSIDE} -maxdepth 0 -exec touch {}$X \\;` },
  { command: `find . -exec cp + ${OUTSIDE}/x \\;` },
  { command: `find . -exec echo {} + -exec cp a ${OUTSIDE}/x \\;` },
  { command: `find ${OUTSIDE} -execdir touch new \\;` },
  // -execdir does not run in the directory find runs in.
  { command: `find ${OUTSIDE} -execdir touch new \\;`, cwd: STATE_ROOT },
  { command: `find . -exec sudo cp a ${OUTSIDE}/x \\;` },
  { command: `find . -exec bash -c 'cp a ${OUTSIDE}/x' \\;` },
  { command: "find -name x -delete" },
  { command: `find -L -O3 ${OUTSIDE}/x -delete` },
  { command: `find . -fprint ${OUTSIDE}/x` },
  { command: `find . -fls ${OUTSIDE}/x` },
  // The format of -fprintf is text, not a file.
  { command: `find . -fprintf ${OUTSIDE}/x ~/.isomux` },
  { command: `find ~/.isomux -fprintf ${OUTSIDE}/x -delete` },
  // The value of -D is not a start path.
  { command: `find -D stat ${OUTSIDE}/x -delete`, cwd: STATE_ROOT },
  // Reading the state root stays allowed.
  { command: `find ~/.isomux -name x -exec cat {} \\;` },
  { command: `find ~/.isomux -name '*.json' -exec cp {} ${OUTSIDE}/ \\;` },
  { command: "find ~/.isomux/logs -exec cat {} +" },
  { command: "find /tmp -exec pgrep bun \\;" },
  { command: nestedFinds(3, 1) },
  { command: `find . -exec bash -c '${script(2 * 1024)}' x {} \\;` },
  { command: `HOME=${OUTSIDE}/h; find ~ -execdir touch x \\;` },
  // A start path above the state root is not a write to it (as for rm -r).
  { command: "find ~ -name '*.pyc' -delete" },
];

describe("find runs, deletes and writes", () => {
  for (const { name, command, plain, cwd, context } of refused) {
    it(`refuses ${name ?? named(command, cwd)}`, () => {
      const expected = plain.map((p) => reasonWithout(run(p, cwd, context), p));
      // The plain commands must themselves be refused.
      expect(expected).not.toContain(null);
      const reason = reasonWithout(run(command, cwd, context), command);
      expect(reason).not.toBeNull();
      expect(expected).toContain(reason);
    });
  }

  for (const { command, cwd } of allowed) {
    it(`allows ${named(command, cwd)}`, () => {
      expect(run(command, cwd).decision).toBe("allow");
    });
  }
});
