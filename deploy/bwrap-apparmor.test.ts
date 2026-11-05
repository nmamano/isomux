// deploy/bwrap-apparmor.sh - the exact "allow ix" rules that keep programs
// whose own AppArmor profile allows everything (Chrome) out of Ubuntu's bwrap
// stack, and deploy/install.sh's step that installs and runs it (task
// f90a80b7).
//
// The tool runs here against a fixture /etc/apparmor.d (APPARMOR_DIR), a fake
// loaded-profile list (APPARMOR_PROFILES) and an apparmor_parser stub first on
// PATH that records each call and the override file as the call saw it. One
// case copies the real /etc/apparmor.d and has the stub run the real parser
// (without loading anything) where this host has both. Nothing on the host
// changes. Zero LLM.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const SCRIPT = new URL("./bwrap-apparmor.sh", import.meta.url).pathname;
const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const BEGIN = "# BEGIN isomux-bwrap-apparmor";
const END = "# END isomux-bwrap-apparmor";
const REAL_PARSER = "/usr/sbin/apparmor_parser";

let base = "";
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "bwrap-apparmor-test-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function executable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Records each call and the override file as it was at that call. Fails a
// call whose arguments contain PARSER_FAIL_ON; with PARSER_FAIL_REPLACE_ONLY
// set, only a call that also has -r. With REAL_BASE set, it parses the
// call's file with the real parser instead, loading nothing.
const PARSER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PARSER_LOG"
{ printf -- '--- %s\\n' "$*"; cat "$APPARMOR_DIR/local/unpriv_bwrap" 2>/dev/null || echo "(absent)"; } >> "$PARSER_SNAP"
if [[ -n \${PARSER_FAIL_ON:-} && "$*" == *"$PARSER_FAIL_ON"* ]]; then
  if [[ -z \${PARSER_FAIL_REPLACE_ONLY:-} || " $* " == *" -r "* ]]; then
    echo "AppArmor parser error for $*" >&2
    exit 1
  fi
fi
if [[ -n \${REAL_BASE:-} ]]; then
  exec ${REAL_PARSER} -Q -K -T --base "$REAL_BASE" "\${@: -1}"
fi
exit 0
`;

const BWRAP_PROFILE = `abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {
  allow px /** -> bwrap//&unpriv_bwrap,
  include if exists <local/bwrap-userns-restrict>
}
profile unpriv_bwrap flags=(attach_disconnected) {
  allow pix /** -> &unpriv_bwrap,
  audit deny capability,
  include if exists <local/unpriv_bwrap>
}
`;

interface Box {
  dir: string;
  apparmor: string;
  canary: string;
  profiles: string;
  bin: string;
  /** Files under the fixture root, for attach paths that must exist. */
  root: string;
  local: string;
  parserLog: string;
  parserSnap: string;
}

interface BoxOpts {
  /** No bwrap-userns-restrict at all. */
  noProfile?: boolean;
  /** The profile without its local/unpriv_bwrap include. */
  noInclude?: boolean;
  /** disable/bwrap-userns-restrict, as aa-disable leaves it. */
  disabled?: boolean;
  /** The loaded list: "missing" for no file, "without" for no unpriv_bwrap. */
  loaded?: "yes" | "without" | "missing";
  /** local/unpriv_bwrap before the run. */
  override?: string;
}

// The fixture tree: one profile file per attach-path form the tool reads.
function makeBox(opts: BoxOpts = {}): Box {
  const dir = mkdtempSync(join(base, "box-"));
  const apparmor = join(dir, "apparmor.d");
  const root = join(dir, "root");
  const bin = join(dir, "bin");
  for (const d of [apparmor, join(apparmor, "local"), root, bin])
    mkdirSync(d, { recursive: true });
  const box: Box = {
    dir,
    apparmor,
    canary: join(dir, "lib", "isomux", "apparmor-canary"),
    profiles: join(dir, "profiles"),
    bin,
    root,
    local: join(apparmor, "local", "unpriv_bwrap"),
    parserLog: join(dir, "parser.log"),
    parserSnap: join(dir, "parser.snap"),
  };
  executable(join(bin, "apparmor_parser"), PARSER_STUB);
  writeFileSync(box.parserLog, "");

  if (!opts.noProfile)
    writeFileSync(
      join(apparmor, "bwrap-userns-restrict"),
      opts.noInclude
        ? BWRAP_PROFILE.replace(
            "  include if exists <local/unpriv_bwrap>\n",
            "",
          )
        : BWRAP_PROFILE,
    );
  if (opts.disabled) {
    mkdirSync(join(apparmor, "disable"));
    symlinkSync(
      "../bwrap-userns-restrict",
      join(apparmor, "disable", "bwrap-userns-restrict"),
    );
  }
  const loaded = opts.loaded ?? "yes";
  if (loaded !== "missing")
    writeFileSync(
      box.profiles,
      loaded === "yes"
        ? "bwrap (enforce)\nunpriv_bwrap (enforce)\nchrome (unconfined)\n"
        : "bwrap (enforce)\nchrome (unconfined)\n",
    );
  if (opts.override !== undefined) writeFileSync(box.local, opts.override);

  // Attach paths under the fixture root that the globs below match.
  mkdirSync(join(root, "opt"));
  writeFileSync(join(root, "opt", "tool-a"), "");
  writeFileSync(join(root, "opt", "tool-b"), "");
  mkdirSync(join(root, "deep"));
  writeFileSync(join(root, "deep", "x"), "");

  const profile = (name: string, header: string) =>
    writeFileSync(
      join(apparmor, name),
      `abi <abi/4.0>,\ninclude <tunables/global>\n${header} {\n  userns,\n}\n`,
    );
  profile(
    "chrome",
    "profile chrome /opt/google/chrome/chrome flags=(unconfined)",
  );
  // The same attach path twice is listed once.
  profile(
    "chrome-dup",
    "profile chrome2 /opt/google/chrome/chrome flags=(unconfined)",
  );
  profile(
    "firefox",
    "profile firefox /{usr/lib/firefox{,-esr},opt/firefox}/firefox{,-bin} flags=(unconfined)",
  );
  profile(
    "multiarch",
    "profile mt /usr/lib/@{multiarch}/libc.so.6 flags=(unconfined)",
  );
  profile("globbed", `profile g ${root}/opt/tool* flags=(unconfined)`);
  profile("globbed-none", `profile gn ${root}/opt/none* flags=(unconfined)`);
  profile("deep", `profile deep ${root}/deep/** flags=(unconfined)`);
  profile("variable", "profile v @{HOME}/bin/v flags=(unconfined)");
  profile(
    "quoted",
    'profile "Mongo Compass" "/usr/lib/mongo/Mongo Compass" flags=(unconfined)',
  );
  profile("keywordless", "/usr/bin/kwless flags=(unconfined)");
  profile(
    "multi",
    "profile multi /usr/bin/multi flags=(attach_disconnected,unconfined)",
  );
  profile("complain", "profile ping /usr/bin/ping flags=(complain)");
  profile("enforce", "profile enf /usr/bin/enf");
  profile("noattach", "profile noattach flags=(unconfined)");
  profile("control", 'profile tab "/usr/bin/a\tb" flags=(unconfined)');
  writeFileSync(
    join(apparmor, "commented"),
    "# profile commented /usr/bin/commented flags=(unconfined) {\n",
  );
  // Only top-level files are profiles.
  mkdirSync(join(apparmor, "abstractions"));
  writeFileSync(
    join(apparmor, "abstractions", "sub"),
    "profile sub /usr/bin/sub flags=(unconfined) {\n}\n",
  );
  return box;
}

// What the tool must list for makeBox's tree: every exact path, brace results
// whether or not they exist, glob results that exist, and the canary.
function expectedPaths(box: Box): string[] {
  const multiarch = readdirSync("/usr/lib")
    .filter((name) => name.includes("-linux-gnu"))
    .map((name) => `/usr/lib/${name}/libc.so.6`)
    .filter((path) => existsSync(path));
  // The enabling condition of the @{multiarch} case: it matches something here.
  expect(multiarch.length).toBeGreaterThan(0);
  return [
    "/opt/google/chrome/chrome",
    "/usr/lib/firefox/firefox",
    "/usr/lib/firefox/firefox-bin",
    "/usr/lib/firefox-esr/firefox",
    "/usr/lib/firefox-esr/firefox-bin",
    "/opt/firefox/firefox",
    "/opt/firefox/firefox-bin",
    ...multiarch,
    `${box.root}/opt/tool-a`,
    `${box.root}/opt/tool-b`,
    "/usr/lib/mongo/Mongo Compass",
    "/usr/bin/kwless",
    "/usr/bin/multi",
    box.canary,
  ].sort();
}

interface Run {
  code: number;
  out: string;
  /** Each apparmor_parser call's arguments. */
  calls: string[];
  local: string | null;
}

function runTool(
  box: Box,
  args: string[] = [],
  env: Record<string, string> = {},
): Run {
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env.PATH}`,
      APPARMOR_DIR: box.apparmor,
      CANARY: box.canary,
      APPARMOR_PROFILES: box.profiles,
      PARSER_LOG: box.parserLog,
      PARSER_SNAP: box.parserSnap,
      ...env,
    },
    encoding: "utf8",
  });
  return {
    code: res.status ?? -1,
    out: `${res.stdout}${res.stderr}`,
    calls: readFileSync(box.parserLog, "utf8").split("\n").filter(Boolean),
    local: existsSync(box.local) ? readFileSync(box.local, "utf8") : null,
  };
}

// The lines between the markers. Fails on anything there but a comment or an
// exact ix rule, so a glob or a stray rule cannot hide in the block.
function blockOf(text: string): { lines: string[]; paths: string[] } {
  const all = text.split("\n");
  expect(all.filter((l) => l === BEGIN)).toHaveLength(1);
  expect(all.filter((l) => l === END)).toHaveLength(1);
  const lines = all.slice(all.indexOf(BEGIN) + 1, all.indexOf(END));
  const paths: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = /^\s*allow ix (?:"([^"]+)"|([^\s"]+)),$/.exec(line);
    expect(m === null ? line : "rule").toBe("rule");
    paths.push(m![1] ?? m![2]);
  }
  return { lines, paths };
}

function withoutBlock(text: string): string {
  const all = text.split("\n");
  return [
    ...all.slice(0, all.indexOf(BEGIN)),
    ...all.slice(all.indexOf(END) + 1),
  ].join("\n");
}

// The calls that load a profile into the kernel.
const replaced = (calls: string[], file: string) =>
  calls.filter((c) => ` ${c} `.includes(" -r ") && c.includes(file));

describe("bwrap-apparmor: the rules it writes", () => {
  it("lists every exact attach path of a profile that allows everything, and the canary", () => {
    const box = makeBox();
    const r = runTool(box);
    expect(r.code).toBe(0);
    const { paths } = blockOf(r.local!);
    expect(paths.length).toBe(new Set(paths).size);
    expect([...paths].sort()).toEqual(expectedPaths(box));
    // A path with a space is written quoted.
    expect(r.local).toContain('allow ix "/usr/lib/mongo/Mongo Compass",');
  });

  it("reloads the bwrap profile after the block is in place", () => {
    const box = makeBox();
    const r = runTool(box);
    expect(r.code).toBe(0);
    const reloads = replaced(
      r.calls,
      join(box.apparmor, "bwrap-userns-restrict"),
    );
    expect(reloads.length).toBeGreaterThan(0);
    // The override as the last reload read it holds the block.
    const snap = readFileSync(box.parserSnap, "utf8");
    const last = snap.slice(snap.lastIndexOf(`--- ${reloads.at(-1)}`));
    expect(last).toContain(BEGIN);
    expect(last).toContain(`allow ix ${box.canary},`);
    expect(statSync(box.local).mode & 0o777).toBe(0o644);
  });

  it("keeps the operator's lines, replaces its own block, and gives the same bytes on a rerun", () => {
    const operator = [
      "# operator note",
      "allow ix /usr/local/bin/mine,",
      BEGIN,
      "allow ix /stale/path,",
      END,
      "# after the block",
      "allow ix /usr/local/bin/after,",
      "",
    ].join("\n");
    const box = makeBox({ override: operator });
    const first = runTool(box);
    expect(first.code).toBe(0);
    expect(withoutBlock(first.local!)).toBe(withoutBlock(operator));
    expect(blockOf(first.local!).paths).not.toContain("/stale/path");
    expect([...blockOf(first.local!).paths].sort()).toEqual(expectedPaths(box));
    const second = runTool(box);
    expect(second.code).toBe(0);
    expect(second.local).toBe(first.local);
  });

  it("installs a canary that runs only shell builtins, under its own profile without userns", () => {
    const box = makeBox();
    expect(runTool(box).code).toBe(0);
    expect(statSync(box.canary).mode & 0o777).toBe(0o755);
    const profile = readFileSync(
      join(box.apparmor, "isomux-apparmor-canary"),
      "utf8",
    );
    const header = new RegExp(
      `^\\s*profile\\s+isomux-apparmor-canary\\s+"?${box.canary.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"?\\s+flags=\\(unconfined\\)\\s*\\{`,
      "m",
    );
    expect(profile).toMatch(header);
    expect(profile).not.toMatch(/\buserns\b/);

    // A PATH where every program the canary could look up leaves a mark.
    const hostile = join(box.dir, "hostile");
    mkdirSync(hostile);
    for (const name of [
      "cat",
      "head",
      "tail",
      "tr",
      "sed",
      "awk",
      "printf",
      "echo",
      "ls",
      "sh",
      "bash",
      "dash",
      "env",
      "readlink",
    ])
      executable(
        join(hostile, name),
        `#!/bin/sh\ntouch "$MARK"\necho hijacked\n`,
      );
    const control = spawnSync("/bin/sh", ["-c", "cat /dev/null"], {
      env: { PATH: hostile, MARK: join(box.dir, "control-mark") },
      encoding: "utf8",
    });
    // The enabling condition: this PATH does take over a lookup.
    expect(control.stdout).toContain("hijacked");
    const mark = join(box.dir, "canary-mark");
    const res = spawnSync(box.canary, [], {
      env: { PATH: hostile, MARK: mark },
      encoding: "utf8",
    });
    expect(existsSync(mark)).toBe(false);
    let label = "";
    try {
      label = readFileSync("/proc/self/attr/apparmor/current", "utf8");
    } catch {
      // No AppArmor on this host: the canary prints nothing either.
    }
    expect(res.stdout.trim()).toBe(label.replace(/\0/g, "").trim());
  });

  it("prints the block in a dry run and changes nothing", () => {
    const box = makeBox();
    const r = runTool(box, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("allow ix /opt/google/chrome/chrome,");
    expect(r.out).toContain(`allow ix ${box.root}/opt/tool-a,`);
    expect(r.local).toBeNull();
    expect(existsSync(box.canary)).toBe(false);
    expect(existsSync(join(box.apparmor, "isomux-apparmor-canary"))).toBe(
      false,
    );
    expect(replaced(r.calls, "")).toEqual([]);
  });
});

describe("bwrap-apparmor: boxes it leaves alone", () => {
  // Each refusal is checked against the same tree that the cases above write
  // to, so "nothing written" is the refusal and not a broken fixture.
  it.each([
    ["no bwrap-userns-restrict profile", { noProfile: true }, 0],
    ["a bwrap profile the operator disabled", { disabled: true }, 0],
    ["unpriv_bwrap not loaded", { loaded: "without" }, 0],
    ["no loaded-profile list (AppArmor off)", { loaded: "missing" }, 0],
    ["a bwrap profile without the local include", { noInclude: true }, 1],
  ] as const)("%s: writes nothing", (_case, opts, code) => {
    const box = makeBox(opts as BoxOpts);
    const r = runTool(box);
    expect(r.code).toBe(code);
    expect(r.local).toBeNull();
    expect(existsSync(box.canary)).toBe(false);
    expect(existsSync(join(box.apparmor, "isomux-apparmor-canary"))).toBe(
      false,
    );
    expect(r.calls).toEqual([]);
  });
});

describe("bwrap-apparmor: a failed load leaves the box as it was", () => {
  const before = `# operator note\nallow ix /usr/local/bin/mine,\n${BEGIN}\nallow ix /old/path,\n${END}\n`;

  it.each([
    ["every parse of the bwrap profile fails", {}],
    ["only the reload fails", { PARSER_FAIL_REPLACE_ONLY: "1" }],
  ])("%s: the override keeps its old bytes", (_case, env) => {
    const box = makeBox({ override: before });
    const r = runTool(box, [], {
      PARSER_FAIL_ON: "bwrap-userns-restrict",
      ...env,
    });
    expect(r.code).toBe(1);
    // The enabling condition: the tool did reach the bwrap profile.
    expect(r.calls.some((c) => c.includes("bwrap-userns-restrict"))).toBe(true);
    expect(r.local).toBe(before);
  });

  it("removes an override it created when the reload fails", () => {
    const box = makeBox();
    const r = runTool(box, [], {
      PARSER_FAIL_ON: "bwrap-userns-restrict",
      PARSER_FAIL_REPLACE_ONLY: "1",
    });
    expect(r.code).toBe(1);
    expect(replaced(r.calls, "bwrap-userns-restrict").length).toBeGreaterThan(
      0,
    );
    expect(r.local).toBeNull();
  });

  it("removes the canary and its profile when the canary profile does not load", () => {
    const box = makeBox({ override: before });
    const r = runTool(box, [], { PARSER_FAIL_ON: "isomux-apparmor-canary" });
    expect(r.code).toBe(1);
    expect(r.calls.some((c) => c.includes("isomux-apparmor-canary"))).toBe(
      true,
    );
    expect(existsSync(box.canary)).toBe(false);
    expect(existsSync(join(box.apparmor, "isomux-apparmor-canary"))).toBe(
      false,
    );
    expect(r.local).toBe(before);
  });
});

// The real tree and the real parser: the block for this host's profiles
// compiles. Runs where the host has Ubuntu's bwrap profile and the parser.
const realTree =
  existsSync("/etc/apparmor.d/bwrap-userns-restrict") &&
  existsSync(REAL_PARSER);

describe("bwrap-apparmor: this host's profiles", () => {
  it.skipIf(!realTree)(
    "writes a block the real parser compiles, with every plain attach path",
    () => {
      const box = makeBox();
      rmSync(box.apparmor, { recursive: true });
      cpSync("/etc/apparmor.d", box.apparmor, { recursive: true });
      rmSync(join(box.apparmor, "disable", "bwrap-userns-restrict"), {
        force: true,
      });
      rmSync(box.local, { force: true });
      const r = runTool(box, [], { REAL_BASE: box.apparmor });
      expect(r.code).toBe(0);
      expect(replaced(r.calls, "bwrap-userns-restrict").length).toBeGreaterThan(
        0,
      );
      expect(r.calls.some((c) => c.includes("isomux-apparmor-canary"))).toBe(
        true,
      );
      // Independent of the tool: each top-level profile whose header is
      // "profile NAME /plain/path flags=(...unconfined...)".
      const plain: string[] = [];
      for (const name of readdirSync("/etc/apparmor.d")) {
        const path = join("/etc/apparmor.d", name);
        if (!statSync(path).isFile()) continue;
        for (const m of readFileSync(path, "utf8").matchAll(
          /^\s*profile\s+\S+\s+(\/[^\s"*?[\]{}^@]+)\s+flags=\([^)]*\bunconfined\b[^)]*\)/gm,
        ))
          plain.push(m[1]);
      }
      expect(plain.length).toBeGreaterThan(10);
      const { paths } = blockOf(r.local!);
      expect(plain.filter((p) => !paths.includes(p))).toEqual([]);
    },
  );
});

// deploy/install.sh configure_bwrap_apparmor, run with the installer's own
// write_file and run against the same fixture. The tool it installs is the
// embedded copy, so this also runs what a box gets.
describe("install.sh bwrap-apparmor step", () => {
  let prelude = "";
  beforeAll(() => {
    prelude = join(base, "prelude.sh");
    const res = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
# FIRST definition only: embedded helper scripts define their own write_file.
extract() { awk -v fn="$1() {" 'index($0, fn) == 1 {f = 1} f {print} f && /^}$/ {exit}' "$INSTALL_SH"; }
extract run
extract write_file
# The step's heredoc has its own column-0 braces: the range ends at the first
# closing brace after the delimiter.
awk 'index($0, "configure_bwrap_apparmor() {") == 1 {f = 1} f {print} f && $0 == "ISOMUX_BWRAP_APPARMOR_SH" {d = 1} f && d && /^}$/ {exit}' "$INSTALL_SH"
`,
      ],
      { env: { ...process.env, INSTALL_SH }, encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ISOMUX_BWRAP_APPARMOR_SH");
    writeFileSync(prelude, res.stdout);
  });

  function runStep(box: Box, dryRun = false) {
    const tool = join(box.dir, "sbin", "isomux-bwrap-apparmor");
    mkdirSync(join(box.dir, "sbin"));
    const script = `
set -Eeuo pipefail
source "${prelude}"
DRY_RUN="${dryRun ? "1" : ""}"
BWRAP_APPARMOR_TOOL="${tool}"
trap 'echo "ERR-TRAP: $BASH_COMMAND" >&2' ERR
log() { echo "LOG: $*"; }
outcome_add() { echo "OUTCOME: $*"; }
step() { echo "STEP: $1"; }
die() { echo "DIE: $*"; exit 1; }
configure_bwrap_apparmor
echo "REACHED-END"
`;
    const res = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${box.bin}:${process.env.PATH}`,
        APPARMOR_DIR: box.apparmor,
        CANARY: box.canary,
        APPARMOR_PROFILES: box.profiles,
        PARSER_LOG: box.parserLog,
        PARSER_SNAP: box.parserSnap,
      },
      encoding: "utf8",
    });
    const out = `${res.stdout}${res.stderr}`;
    return {
      out,
      tool,
      reachedEnd: out.includes("REACHED-END"),
      outcomes: out.split("\n").filter((l) => l.startsWith("OUTCOME: ")),
      errTraps: out.split("\n").filter((l) => l.startsWith("ERR-TRAP: ")),
      sbin: readdirSync(join(box.dir, "sbin")),
      local: existsSync(box.local) ? readFileSync(box.local, "utf8") : null,
      calls: readFileSync(box.parserLog, "utf8").split("\n").filter(Boolean),
    };
  }

  it("installs the tool as shipped and runs it", () => {
    const box = makeBox();
    const r = runStep(box);
    expect(r.out).not.toContain("command not found");
    expect(r.reachedEnd).toBe(true);
    expect(r.errTraps).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(r.sbin).toEqual(["isomux-bwrap-apparmor"]);
    expect(readFileSync(r.tool, "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
    expect(statSync(r.tool).mode & 0o777).toBe(0o755);
    // It ran: the override holds the block.
    expect([...blockOf(r.local!).paths].sort()).toEqual(expectedPaths(box));
  });

  it("tells the owner when the tool refuses, and the install goes on", () => {
    const box = makeBox({ noInclude: true });
    const r = runStep(box);
    expect(r.out).not.toContain("command not found");
    expect(r.reachedEnd).toBe(true);
    expect(r.errTraps).toEqual([]);
    expect(r.outcomes).toHaveLength(1);
    expect(r.sbin).toEqual(["isomux-bwrap-apparmor"]);
    expect(r.local).toBeNull();
  });

  it("changes nothing in a dry run", () => {
    const box = makeBox();
    const r = runStep(box, true);
    expect(r.reachedEnd).toBe(true);
    expect(r.errTraps).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(r.sbin).toEqual([]);
    expect(r.local).toBeNull();
    expect(r.calls).toEqual([]);
  });
});
