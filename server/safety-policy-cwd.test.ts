import { describe, expect, it } from "bun:test";
import { homedir } from "os";
import {
  evaluateProposedAction,
  type PolicyDecision,
} from "./safety-policy.ts";
import { STATE_ROOT } from "./config.ts";
import catalogInput from "./test-support/fixtures/safety-hook-cwd-catalog.json";

// Verbatim f9a24bf9 tool input, including the quoted Catalan heredoc.
// These commands are classified only; none of them execute.
const safe = "/tmp/safety-cwd";
const home = homedir();
const missingCwd = "did not include a non-empty absolute agent cwd";
const changedCwd =
  "could not resolve the relative write target after a shell directory change";
const nonLiteral =
  "could not resolve the write target because it is not a literal path";
const protectedWrite = "Writing to ~/.isomux/ is not allowed";
type Case = {
  name: string;
  command: string;
  cwd?: string | null;
  denied: boolean;
  reason?: string;
};
const cases: Case[] = [
  {
    name: "verbatim catalog with known cwd",
    command: catalogInput.command,
    denied: false,
  },
  {
    name: "literal cd anchors without envelope cwd",
    command: "cd /tmp && cat > .isomux/x",
    cwd: "",
    denied: false,
  },
  {
    name: "single-quoted parentheses",
    command: "cd /tmp && echo 'a(b)' > out.txt",
    denied: false,
  },
  {
    name: "double-quoted parentheses",
    command: 'cd /tmp && echo "a(b)" > out.txt',
    denied: false,
  },
  {
    name: "escaped parentheses",
    command: "cd /tmp && echo a\\(b\\) > out.txt",
    denied: false,
  },
  {
    name: "comment parentheses",
    command: "cd /tmp && cat > out.txt # (note)",
    denied: false,
  },
  {
    name: "descriptor duplication 2>&1",
    command:
      "cd /tmp && sed -i 's/a/b/' probe.ts && bun run probe.ts 2>&1 | head",
    denied: false,
  },
  {
    name: "both descriptors redirect",
    command: "cd /tmp && echo x &> out.txt",
    denied: false,
  },
  {
    name: "quoted heredoc protected target",
    command: "cd ~/.isomux && cat > agents/x <<'EOF'\n// note (x)\nEOF",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "literal protected cd",
    command: `cd ${STATE_ROOT} && cat > agents/x`,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "literal home cd",
    command: "cd ~ && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "semicolon includes original cwd",
    command: "cd /tmp ; cat > .isomux/x",
    cwd: home,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "semicolon includes destination cwd",
    command: `cd ${STATE_ROOT} ; cat > agents/x`,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "semicolon safe union",
    command: "cd /tmp ; cat > out.txt",
    denied: false,
  },
  {
    name: "failed cd with && skips write",
    command: "cd /nonexistent && cat > .isomux/x",
    cwd: home,
    denied: false,
  },
  {
    name: "AND continuation newline",
    command: "cd /tmp &&\ncat > .isomux/x",
    cwd: home,
    denied: false,
  },
  {
    name: "OR uses original cwd",
    command: "cd /tmp || cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "OR excludes successful destination",
    command: `cd ${STATE_ROOT} || cat > agents/x`,
    denied: false,
  },
  {
    name: "AND OR chain preserves failed cd",
    command: "cd /tmp && true || cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "subshell checks internal write",
    command: "(cd ~ && cat > .isomux/x)",
    denied: true,
  },
  {
    name: "subshell keeps parent safe",
    command: "(cd ~) && echo x > out.txt",
    denied: false,
  },
  {
    name: "subshell keeps parent protected",
    command: "(cd /tmp) && cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "subshell redirect uses parent",
    command: "(cd /tmp) > .isomux/x",
    cwd: home,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "substitution keeps parent safe",
    command: 'echo "$(cd ~)"; cat > out.txt',
    denied: false,
  },
  {
    name: "substitution keeps parent protected",
    command: 'echo "$(cd /tmp)"; cat > .isomux/x',
    cwd: home,
    denied: true,
  },
  {
    name: "substitution checks internal write",
    command: 'echo "$(cd ~ && cat > .isomux/x)"',
    denied: true,
  },
  {
    name: "backticks keep parent protected",
    command: "echo `cd /tmp`; cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "background keeps parent protected",
    command: "cd /tmp & cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "foreground after background changes parent",
    command: "true & cd ~/.isomux; cat > agents/x",
    denied: true,
  },
  {
    name: "foreground after background safe parent",
    command: "true & cd /tmp && cat > .isomux/x",
    cwd: home,
    denied: false,
  },
  {
    name: "background checks internal write",
    command: "cd ~ && cat > .isomux/x & true",
    denied: true,
  },
  {
    name: "pipeline keeps parent safe",
    command: "cd ~ | cat; cat > out.txt",
    denied: false,
  },
  {
    name: "pipeline keeps parent protected",
    command: "cd /tmp | cat; cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "pipeline sibling starts in parent",
    command: "cd /tmp | cat > .isomux/x",
    cwd: home,
    denied: true,
  },
  {
    name: "nested shell checks internal write",
    command: "bash -c 'cd ~ && cat > .isomux/x'",
    denied: true,
  },
  {
    name: "dynamic cd fails closed",
    command: 'cd "$D" && cat > out.txt',
    denied: true,
    reason: changedCwd,
  },
  {
    name: "glob cd fails closed",
    command: "cd /home/* && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "cd dash fails closed",
    command: "cd - && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "pushd fails closed",
    command: "pushd ~ && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "parent-relative target",
    command: "cat > ../.isomux/x",
    cwd: `${home}/workspace`,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "popd fails closed",
    command: "popd && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "relative protected copy after cd",
    command: "cd ~ && cp /tmp/x .isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "OR success set includes the right side's cd",
    command: "cd /nonexistent || cd ~; cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "AND failure set includes the right side's cd",
    command: "cd ~ && cd /nonexistent; cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "pipeline right side cd does not move the parent",
    command: "cd ~ && true | cd /tmp && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "missing cwd protected candidate",
    command: "cat > .isomux/x",
    cwd: "",
    denied: true,
    reason: missingCwd,
  },
  {
    name: "nonliteral target plain",
    command: 'cat > "$HOME/.isomux/x"',
    denied: true,
    reason: nonLiteral,
  },
  {
    name: "nonliteral glob target",
    command: "cat > /tmp/*/.isomux/x",
    denied: true,
    reason: nonLiteral,
  },
  {
    name: "literal quoted glob target",
    command: "cat > '/tmp/*/.isomux/x'",
    denied: false,
  },
  {
    name: "case arm without cd keeps cwd",
    command: "case $1 in a) cat > o.txt;; esac",
    denied: false,
  },
  {
    name: "case arm without cd still checks protected cwd",
    command: "case $1 in a) cat > o.txt;; esac",
    cwd: STATE_ROOT,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "dd tilde output is protected",
    command: "dd if=/dev/null of=~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "dd dynamic output is protected",
    command: 'dd if=/dev/null of="$HOME/.isomux/x"',
    denied: true,
    reason: nonLiteral,
  },
  {
    name: "dd checks every output operand",
    command: "dd of=/tmp/a of=~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "dd input operand remains readable",
    command: "dd if=~/.isomux/agents.json of=/tmp/a",
    denied: false,
  },
  {
    name: "truncate output is protected",
    command: "truncate -s 0 ~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "truncate reference input remains readable",
    command: "truncate -r ~/.isomux/agents.json /tmp/out",
    denied: false,
  },
  {
    name: "truncate size value is not an output operand",
    command: "truncate -s 0 /tmp/out",
    cwd: STATE_ROOT,
    denied: false,
  },
  {
    name: "truncate long options keep their input and value readable",
    command: "truncate --reference=~/.isomux/agents.json --size=0 /tmp/out",
    // In the state root, so reading an option value as an output operand
    // would deny.
    cwd: STATE_ROOT,
    denied: false,
  },
  {
    name: "truncate option terminator exposes dash-prefixed output",
    command: "truncate -s 0 -- -x",
    cwd: STATE_ROOT,
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "builtin wrapper exposes cd",
    command: "builtin cd ~ && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "command wrapper exposes cd",
    command: "command cd ~ && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "if keyword exposes cd",
    command: "if cd ~; then cat > .isomux/x; fi",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "while keyword exposes cd",
    command: "while cd ~; do cat > .isomux/x; done",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "until keyword exposes cd",
    command: "until cd ~; do cat > .isomux/x; done",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "elif keyword exposes cd",
    command: "if false; then :; elif cd ~; then cat > .isomux/x; fi",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "else keyword exposes cd",
    command: "if false; then :; else cd ~ && cat > .isomux/x; fi",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "negation keyword exposes cd",
    command: "! cd ~; cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "opaque unknown keyword before cd stays denied",
    command: "f() { select cd ~; cat > .isomux/x; }; f",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "nonliteral target has bounded segment",
    command: 'cat > "$HOME/.isomux-backup/x"',
    denied: false,
  },
  // The shell removes quotes before a program parses its options, so a quoted
  // flag is still a flag.
  {
    name: "sed single-quoted in-place flag",
    command: "sed '-i' s/a/b/ ~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "sed double-quoted in-place flag",
    command: 'sed "-i" s/a/b/ ~/.isomux/agents.json',
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "sed quoted long in-place flag",
    command: "sed '--in-place' s/a/b/ ~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "sed quoted script that names -i stays a read",
    command: "sed 's/-i/x/' ~/.isomux/agents.json",
    denied: false,
  },
  {
    name: "perl quoted in-place cluster",
    command: "perl '-pi' -e 's/a/b/' ~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "perl quoted in-place flag",
    command: "perl -p '-i' -e 's/a/b/' ~/.isomux/agents.json",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "perl program text after -e is not a flag",
    command: `perl -e '-d "/tmp" and print "is dir"' ~/.isomux/agents.json`,
    denied: false,
  },
  {
    name: "perl program text attached to -e is not a flag",
    command: `perl -e'print "is dir"' ~/.isomux/agents.json`,
    denied: false,
  },
  {
    name: "perl -M module value is not an in-place cluster",
    command: "perl -MList::Util=sum -ne 'print' ~/.isomux/agents.json",
    denied: false,
  },
  {
    name: "truncate quoted reference flag keeps its input readable",
    command: "truncate '-r' ~/.isomux/agents.json /tmp/out",
    denied: false,
  },
  {
    name: "truncate quoted option terminator exposes dash-prefixed output",
    command: "truncate -s 0 '--' -x",
    cwd: STATE_ROOT,
    denied: true,
    reason: protectedWrite,
  },
  // A function body runs later, where the line's directory changes leave it.
  {
    name: "function keyword body keeps relative writes unresolved",
    command: "function f { cd ~; cat > .isomux/x; }; f",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "function as an argument is not a definition",
    command: "cd /tmp && grep function f > out",
    denied: false,
  },
  {
    name: "eval before a function call keeps relative writes unresolved",
    command: "f() { cat > .isomux/x; }; eval 'cd ~'; f",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "quoted cd before a function call keeps relative writes unresolved",
    command: "f() { cat > .isomux/x; }; 'cd' ~; f",
    denied: true,
    reason: changedCwd,
  },
  // eval runs its payload in the current shell.
  {
    name: "eval cd moves the parent",
    command: "eval cd ~ && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "quoted eval cd moves the parent",
    command: "eval 'cd ~'; cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "command wrapper exposes eval cd",
    command: "command eval cd ~ && cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "eval cd out of the protected cwd",
    command: "eval cd /tmp && cat > .isomux/x",
    cwd: home,
    denied: false,
  },
  {
    name: "eval OR branch keeps the original cwd",
    command: "eval cd ~ || cat > .isomux/x",
    denied: false,
  },
  {
    name: "eval OR branch follows the payload's failed cd",
    command: "eval 'cd ~ && cd /nonexistent' || cat > .isomux/x",
    denied: true,
    reason: protectedWrite,
  },
  {
    name: "dynamic eval OR branch fails closed",
    command: 'eval "$CMD" || cat > .isomux/x',
    denied: true,
    reason: changedCwd,
  },
  {
    name: "eval without cd keeps the cwd",
    command: "eval 'echo hi'; cat > out.txt",
    denied: false,
  },
  {
    name: "nested shell cd does not move the parent",
    command: "bash -c 'cd ~'; cat > .isomux/x",
    denied: false,
  },
  {
    name: "dynamic eval payload fails closed",
    command: 'eval "$CMD"; cat > .isomux/x',
    denied: true,
    reason: changedCwd,
  },
  {
    name: "eval past the nesting limit fails closed",
    command: "eval eval eval eval eval cd ~ && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  // CDPATH and cdable_vars let bash resolve a relative cd somewhere else.
  {
    name: "CDPATH prefix cd fails closed",
    command: "CDPATH=~ cd .isomux && cat > agents.json",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "exported CDPATH cd fails closed",
    command: "export CDPATH=~; cd .isomux && cat > agents.json",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "CDPATH reaches an eval cd",
    command: "CDPATH=~; eval cd .isomux && cat > agents.json",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "cdable_vars cd fails closed",
    command: "shopt -s cdable_vars; d=~; cd d && cat > .isomux/x",
    denied: true,
    reason: changedCwd,
  },
  {
    name: "CDPATH leaves an absolute cd resolved",
    command: "CDPATH=~ cd /tmp && cat > out.txt",
    denied: false,
  },
  {
    name: "CDPATH leaves a dot-relative cd resolved",
    command: "CDPATH=~ cd ./sub && cat > out.txt",
    denied: false,
  },
  {
    name: "relative cd without CDPATH stays resolved",
    command: "cd .isomux && cat > agents.json",
    denied: false,
  },
];

function check(
  testCase: Case,
  evaluate = evaluateProposedAction,
): PolicyDecision {
  return evaluate(
    { kind: "shell", command: testCase.command },
    { cwd: testCase.cwd ?? safe },
  );
}

describe("shell cwd flow", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = check(testCase);
      expect(result.decision === "deny").toBe(testCase.denied);
      if (testCase.reason)
        expect(result.decision === "deny" && result.reason).toContain(
          testCase.reason,
        );
    });
  }
});
