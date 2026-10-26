// A shell write to office state through a variable (task 7ea62548). The hook
// follows the NAME=value assignments on the line, and treats the variables
// Isomux sets to state paths as state paths. It does not ban variable paths
// in general: a variable that holds a path outside the state root stays
// allowed.

import { describe, expect, it } from "bun:test";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  buildEnvForUserId,
  setPersonalProviderActiveProvider,
} from "./env-loader.ts";
import { openCodeToolEnvironment } from "./backends/opencode/config-layers.ts";
import {
  evaluateProposedAction,
  STATE_PATH_EXCLUSIONS,
  STATE_PATH_VARIABLES,
} from "./safety-policy.ts";

// These commands are classified only; none of them execute.
const cwd = "/tmp/safety-variables";

function decide(command: string) {
  return evaluateProposedAction({ kind: "shell", command }, { cwd });
}

// The reason paragraph of a denial, without the echoed command or target.
function reason(command: string): string {
  const result = decide(command);
  if (result.decision !== "deny") throw new Error(`not denied: ${command}`);
  return result.reason.split("\n\n")[1];
}

// Reference denials: a literal write to office state, and a write target
// the hook cannot resolve.
const stateRoot = reason("cp a ~/.isomux/x");
const nonLiteral = reason('cat > "$HOME/.isomux/x"');

describe("a variable that holds a state path", () => {
  it.each([
    // The incident line (task e4d1636d), in shape.
    `P=${STATE_ROOT}/opencode/profiles/abc; D=$P/data/opencode; mv -n $D/x.tmp $D/x`,
    "T=~/.isomux/a; echo hi > $T/pw",
    "T=~/.isomux/a; echo hi >> ${T}/pw",
    "D=~/.isomux/a; cp x $D/y",
    "D=~/.isomux/a; ls | tee $D/y",
    "D=~/.isomux/a; dd if=/dev/zero of=$D/y",
    "D=~/.isomux/a; ln -s /tmp/x $D/y",
    "D=~/.isomux/a; rsync x $D/y",
    "D=~/.isomux/a; install -m 600 /dev/null $D/y",
    // An mv source leaves office state too.
    "D=~/.isomux; mv $D/x /tmp/y",
  ])("denies %p as a state-root write", (command) => {
    expect(reason(command)).toBe(stateRoot);
  });

  it.each([
    'export D=~/.isomux/a; cp a "${D}/b"',
    "declare -x D=~/.isomux/a; cp a $D/b",
    "readonly D=~/.isomux/a; cp a $D/b",
    "typeset D=~/.isomux/a; cp a $D/b",
    "local D=~/.isomux/a; cp a $D/b",
  ])("follows a declaration builtin: %p", (command) => {
    expect(reason(command)).toBe(stateRoot);
  });

  it("follows a command-prefix assignment", () => {
    // bash expands $D before the prefix binds, so this runs with the old
    // value. The hook takes the new one on purpose: it fails closed.
    expect(reason("D=~/.isomux mv a $D/y")).toBe(stateRoot);
  });

  it.each([
    "env D=~/.isomux/a sh -c 'cp x $D/y'",
    "sudo D=~/.isomux/a sh -c 'cp x $D/y'",
    "nohup env D=~/.isomux/a bash -c 'echo hi > $D/y'",
  ])("follows an assignment a wrapper passes on: %p", (command) => {
    expect(reason(command)).toBe(stateRoot);
  });

  it("follows a for-loop variable", () => {
    expect(reason("for d in /tmp/a ~/.isomux/a; do cp x $d/; done")).toBe(
      stateRoot,
    );
  });

  it("resolves a value with the names set before it", () => {
    expect(reason("A=~; B=$A/.isomux; cp a $B/x")).toBe(stateRoot);
    expect(reason(`A=${STATE_ROOT}; B=$A/x; cp a "$B/y"`)).toBe(stateRoot);
  });

  it("checks every value a name gets on the line, not only the last", () => {
    // In bash the first assignment wins here: the || branch does not run.
    expect(reason("D=~/.isomux/x || D=/tmp; cp a $D/y")).toBe(stateRoot);
  });

  it("expands a name anywhere in the target, not only at the start", () => {
    expect(reason("D=.isomux; cp a ~/$D/x")).toBe(stateRoot);
  });

  it("checks the target after every name in it is expanded", () => {
    // No value and no written word names .isomux; the expansion does.
    const result = reason("E=.iso; F=mux; D=$HOME; cp a $D/$E$F/x");
    expect([stateRoot, nonLiteral]).toContain(result);
    expect(reason("E=.iso; F=mux; cp a ~/$E$F/x")).toBe(stateRoot);
  });

  it.each([
    "D=(~/.isomux/a); cp x $D/y",
    "D=(/tmp ~/.isomux/a); cp x ${D[1]}/y",
  ])("follows an array element: %p", (command) => {
    expect(reason(command)).toBe(stateRoot);
  });

  it.each([
    'D=~/.isomux/a; bash -c "cp x $D/y"',
    'D=~/.isomux/a; eval "cp x \\$D/y"',
    "bash -c 'D=~/.isomux/a; cp x $D/y'",
  ])("follows names into a nested shell: %p", (command) => {
    expect(reason(command)).toBe(stateRoot);
  });
});

describe("a write target the hook cannot resolve", () => {
  it.each([
    'mv a "$(echo ~/.isomux)/x"',
    'D="$(cd ~/.isomux; pwd)"; cp a $D/x',
    "D=`echo ~/.isomux`; cp a $D/x",
  ])("denies a substitution that names .isomux: %p", (command) => {
    expect(reason(command)).toBe(nonLiteral);
  });

  it("denies a name set by printf -v", () => {
    expect(reason("printf -v D %s ~/.isomux/a; cp x $D/y")).toBe(nonLiteral);
  });

  it.each([
    "declare -n R=D; D=~/.isomux/a; cp x $R/y",
    "local -n R=D; D=~/.isomux/a; cp x $R/y",
    "typeset -xn R; R=D; D=~/.isomux/a; cp x $R/y",
  ])("denies a nameref: %p", (command) => {
    expect(reason(command)).toBe(nonLiteral);
  });

  it("denies an indirect expansion", () => {
    expect(reason("ref=D; D=~/.isomux/a; cp x ${!ref}/y")).toBe(nonLiteral);
  });

  it("denies a name with too many values, and stays fast", () => {
    // Each D=$D/x adds a value; past the cap the name is unresolvable.
    const chain = "D=/tmp/v; " + "D=$D/x; ".repeat(40) + "cp a $D/y";
    expect(reason(chain)).toBe(nonLiteral);
    // Twenty names with two values each: 2^20 expansions if nothing caps them.
    const names = Array.from({ length: 20 }, (_, i) => `N${i}`);
    const combos =
      names.map((n) => `${n}=p || ${n}=q; `).join("") +
      `cp a /tmp/${names.map((n) => `$${n}`).join("/")}`;
    const started = performance.now();
    expect(reason(combos)).toBe(nonLiteral);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("Isomux's own state-path variables", () => {
  it.each([...STATE_PATH_VARIABLES])(
    "denies a write through $%s and allows a read",
    (name) => {
      expect(reason(`cp a $${name}/x`)).toBe(stateRoot);
      expect(reason(`echo hi > "\${${name}}/x"`)).toBe(stateRoot);
      expect(decide(`cat $${name}/x`).decision).toBe("allow");
      // A cp source is read, not written.
      expect(decide(`cp $${name}/x /tmp/y`).decision).toBe("allow");
    },
  );

  it("denies whatever path follows the variable", () => {
    expect(reason("cp a ${CLAUDE_CONFIG_DIR:-/tmp}/x")).toBe(stateRoot);
    expect(reason("cp a $CLAUDE_CONFIG_DIR/../../tmp/x")).toBe(stateRoot);
    // A new value on the line does not clear it.
    expect(reason("CLAUDE_CONFIG_DIR=/tmp/c; cp a $CLAUDE_CONFIG_DIR/x")).toBe(
      stateRoot,
    );
  });

  it.each(Object.keys(STATE_PATH_EXCLUSIONS))(
    "keeps writes through $%s allowed",
    (name) => {
      expect(decide(`cp a $${name}/x`).decision).toBe("allow");
    },
  );

  it("lists each variable the server sets to a state path", () => {
    const listed = new Set([
      ...STATE_PATH_VARIABLES,
      ...Object.keys(STATE_PATH_EXCLUSIONS),
    ]);
    const atOrBelowStateRoot = (value: string | undefined) =>
      value !== undefined &&
      (value === STATE_ROOT || value.startsWith(STATE_ROOT + "/"));
    const previous = setPersonalProviderActiveProvider(() => true);
    let session: Record<string, string | undefined>;
    try {
      session = buildEnvForUserId("u-state-vars", {})!;
    } finally {
      setPersonalProviderActiveProvider(previous);
    }
    const openCode = openCodeToolEnvironment(
      {},
      join(STATE_ROOT, "opencode", "profiles", "k"),
    );
    // The condition this test depends on: both builders set state paths.
    expect(atOrBelowStateRoot(session.CLAUDE_CONFIG_DIR)).toBe(true);
    expect(atOrBelowStateRoot(openCode.XDG_DATA_HOME)).toBe(true);
    const unlisted = Object.entries({ ...session, ...openCode })
      .filter(([name, value]) => atOrBelowStateRoot(value) && !listed.has(name))
      .map(([name]) => name);
    expect(unlisted).toEqual([]);
  });
});

describe("a variable path outside the state root", () => {
  it.each([
    "D=/tmp/x; mv a $D/y",
    "D=/tmp/x; echo hi > $D/y",
    'P=/tmp/a/key; install -m 600 /dev/null "$P"',
    "cp -p conf/$p.json conf/$p.json.bak-$S",
    "for f in a b; do cp $f /tmp/out/; done",
    'while read f; do mv "$f" /tmp/out/; done < /tmp/list',
    // A sibling of the state root is not the state root.
    "D=~/.isomux-backup; cp a $D/x",
    // Reads of a state path stay allowed.
    "D=~/.isomux/a; cat $D/x",
    "D=~/.isomux; cp $D/x /tmp/y",
  ])("allows %p", (command) => {
    expect(decide(command).decision).toBe("allow");
  });
});
