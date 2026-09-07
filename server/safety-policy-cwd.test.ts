import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { evaluateProposedAction, type PolicyDecision } from "./safety-policy.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import { evaluateCodexHookEnvelope, MISSING_CWD_WARNING } from "./backends/codex/safety-hook.ts";
import { STATE_ROOT } from "./config.ts";
import catalogInput from "./test-support/fixtures/safety-hook-cwd-catalog.json";

// Verbatim f9a24bf9 tool input, including the quoted Catalan heredoc.
// These commands are classified only; none of them execute.
const safe = "/tmp/safety-cwd";
const home = homedir();
const missingCwd = "did not include a non-empty absolute agent cwd";
const changedCwd = "could not resolve the relative write target after a shell directory change";
const nonLiteral = "could not resolve the write target because it is not a literal path";
const protectedWrite = "Writing to ~/.isomux/ is not allowed";
type Case = { name: string; command: string; cwd?: string | null; denied: boolean; reason?: string };
const cases: Case[] = [
  { name: "verbatim catalog with known cwd", command: catalogInput.command, denied: false },
  { name: "verbatim catalog without envelope cwd", command: catalogInput.command, cwd: "", denied: false },
  { name: "literal cd anchors without envelope cwd", command: "cd /tmp && cat > out.ts", cwd: "", denied: false },
  { name: "single-quoted parentheses", command: "cd /tmp && echo 'a(b)' > out.txt", denied: false },
  { name: "double-quoted parentheses", command: 'cd /tmp && echo "a(b)" > out.txt', denied: false },
  { name: "escaped parentheses", command: "cd /tmp && echo a\\(b\\) > out.txt", denied: false },
  { name: "comment parentheses", command: "cd /tmp && cat > out.txt # (note)", denied: false },
  { name: "literal quote with cd text", command: "echo 'text cd /tmp (note)' > out.txt", denied: false },
  { name: "sed program parentheses", command: "cd ~/nil/isomux && sed -i 's/foo(bar)/baz/' ui/settings-access.i18n.dom.test.tsx", denied: false },
  { name: "descriptor duplication 2>&1", command: "cd /tmp && sed -i 's/a/b/' probe.ts && bun run probe.ts 2>&1 | head", denied: false },
  { name: "descriptor duplication >&2", command: "cd /tmp && cat > out.txt; echo done >&2", denied: false },
  { name: "both descriptors redirect", command: "cd /tmp && echo x &> out.txt", denied: false },
  { name: "quoted heredoc protected target", command: "cd ~/.isomux && cat > agents/x <<'EOF'\n// note (x)\nEOF", denied: true, reason: protectedWrite },
  { name: "literal protected cd", command: `cd ${STATE_ROOT} && cat > agents/x`, denied: true, reason: protectedWrite },
  { name: "literal home cd", command: "cd ~ && cat > .isomux/x", denied: true, reason: protectedWrite },
  { name: "semicolon includes original cwd", command: "cd /tmp ; cat > .isomux/x", cwd: home, denied: true, reason: protectedWrite },
  { name: "newline includes original cwd", command: "cd /tmp\ncat > .isomux/x", cwd: home, denied: true, reason: protectedWrite },
  { name: "semicolon includes destination cwd", command: `cd ${STATE_ROOT} ; cat > agents/x`, denied: true, reason: protectedWrite },
  { name: "semicolon safe union", command: "cd /tmp ; cat > out.txt", denied: false },
  { name: "newline safe union", command: "cd /tmp\ncat > out.txt", denied: false },
  { name: "failed cd with && skips write", command: "cd /nonexistent && cat > .isomux/x", cwd: home, denied: false },
  { name: "failed cd with semicolon keeps original", command: "cd /nonexistent ; cat > .isomux/x", cwd: home, denied: true },
  { name: "AND continuation newline", command: "cd /tmp &&\ncat > .isomux/x", cwd: home, denied: false },
  { name: "OR uses original cwd", command: "cd /tmp || cat > .isomux/x", cwd: home, denied: true },
  { name: "OR excludes successful destination", command: `cd ${STATE_ROOT} || cat > agents/x`, denied: false },
  { name: "OR safe original", command: "cd ~ || true; echo x > out.txt", denied: false },
  { name: "AND OR chain preserves failed cd", command: "cd /tmp && true || cat > .isomux/x", cwd: home, denied: true },
  { name: "subshell checks internal write", command: "(cd ~ && cat > .isomux/x)", denied: true },
  { name: "subshell keeps parent safe", command: "(cd ~) && echo x > out.txt", denied: false },
  { name: "subshell keeps parent protected", command: "(cd /tmp) && cat > .isomux/x", cwd: home, denied: true },
  { name: "subshell redirect uses parent", command: "(cd /tmp) > .isomux/x", cwd: home, denied: true },
  { name: "substitution keeps parent safe", command: 'echo "$(cd ~)"; cat > out.txt', denied: false },
  { name: "substitution keeps parent protected", command: 'echo "$(cd /tmp)"; cat > .isomux/x', cwd: home, denied: true },
  { name: "substitution checks internal write", command: 'echo "$(cd ~ && cat > .isomux/x)"', denied: true },
  { name: "backticks keep parent safe", command: 'echo `cd ~`; cat > out.txt', denied: false },
  { name: "backticks keep parent protected", command: 'echo `cd /tmp`; cat > .isomux/x', cwd: home, denied: true },
  { name: "background keeps parent safe", command: "cd ~ & echo x > out.txt", denied: false },
  { name: "background keeps parent protected", command: "cd /tmp & cat > .isomux/x", cwd: home, denied: true },
  { name: "foreground after background changes parent", command: "true & cd ~/.isomux; cat > agents/x", denied: true },
  { name: "foreground after background safe parent", command: "true & cd /tmp && cat > .isomux/x", cwd: home, denied: false },
  { name: "background checks internal write", command: "cd ~ && cat > .isomux/x & true", denied: true },
  { name: "pipeline keeps parent safe", command: "cd ~ | cat; cat > out.txt", denied: false },
  { name: "pipeline keeps parent protected", command: "cd /tmp | cat; cat > .isomux/x", cwd: home, denied: true },
  { name: "pipeline sibling starts in parent", command: "cd /tmp | cat > .isomux/x", cwd: home, denied: true },
  { name: "nested shell checks internal write", command: "bash -c 'cd ~ && cat > .isomux/x'", denied: true },
  { name: "dynamic cd fails closed", command: 'cd "$D" && cat > out.txt', denied: true, reason: changedCwd },
  { name: "glob cd fails closed", command: "cd /home/* && cat > .isomux/x", denied: true, reason: changedCwd },
  { name: "cd dash fails closed", command: "cd - && cat > .isomux/x", denied: true, reason: changedCwd },
  { name: "pushd fails closed", command: "pushd ~ && cat > .isomux/x", denied: true, reason: changedCwd },
  { name: "missing cwd protected candidate", command: "cat > .isomux/x", cwd: "", denied: true, reason: missingCwd },
  { name: "non-absolute cwd protected candidate", command: "cat > .isomux/x", cwd: "relative", denied: true, reason: missingCwd },
  { name: "nonliteral target plain", command: 'cat > "$HOME/.isomux/x"', denied: true, reason: nonLiteral },
  { name: "nonliteral target after group", command: 'cd /tmp && (true) && cat > "$HOME/.isomux/x"', denied: true, reason: nonLiteral },
  { name: "nonliteral target without cwd", command: 'cat > "$HOME/.isomux/x"', cwd: "", denied: true, reason: nonLiteral },
  { name: "nonliteral glob target", command: "cat > /tmp/*/.isomux/x", denied: true, reason: nonLiteral },
  { name: "literal quoted glob target", command: "cat > '/tmp/*/.isomux/x'", denied: false },
  { name: "case arm without cd keeps cwd", command: "case $1 in a) cat > o.txt;; esac", denied: false },
  { name: "function without cd keeps cwd", command: "helper() { cat > o.txt; }; helper", denied: false },
  { name: "unmatched parenthesis without cd keeps cwd", command: "echo done) > o.txt", denied: false },
  { name: "write before case without cd keeps cwd", command: "cat > o.txt; case x in y) echo hi;; esac", denied: false },
  { name: "case arm after cd stays unresolved", command: "cd /tmp && case x in a) cat > o.txt;; esac", denied: true, reason: changedCwd },
  { name: "case arm without cd still checks protected cwd", command: "case $1 in a) cat > o.txt;; esac", cwd: STATE_ROOT, denied: true, reason: protectedWrite },
  { name: "opaque while cd stays denied", command: "f() { while cd ~; do cat > .isomux/x; done; }; f", denied: true, reason: changedCwd },
  { name: "opaque if cd stays denied", command: "f() { if cd ~; then cat > .isomux/x; fi; }; f", denied: true, reason: changedCwd },
  { name: "opaque until cd stays denied", command: "f() { until cd ~; do cat > .isomux/x; done; }; f", denied: true, reason: changedCwd },
  { name: "opaque case while cd stays denied", command: "case x in a) while cd ~; do cat > .isomux/x; done;; esac", denied: true, reason: changedCwd },
  { name: "opaque builtin cd stays denied", command: "f() { builtin cd ~; cat > .isomux/x; }; f", denied: true, reason: changedCwd },
  { name: "unsupported function keeps relative write denied", command: "f() { cd /tmp; cat > out.txt; }; f", denied: true, reason: changedCwd },
  { name: "nonliteral target has bounded segment", command: 'cat > "$HOME/.isomux-backup/x"', denied: false },
  { name: "literal dollar path is still literal", command: "cat > '$HOME/.isomux/x'", denied: false },
];

function check(testCase: Case, evaluate = evaluateProposedAction): PolicyDecision {
  return evaluate({ kind: "shell", command: testCase.command }, { cwd: testCase.cwd ?? safe });
}

describe("shell cwd flow", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = check(testCase);
      expect(result.decision === "deny").toBe(testCase.denied);
      if (testCase.reason) expect(result.decision === "deny" && result.reason).toContain(testCase.reason);
    });
  }
  it("both adapters pass cwd and resolve the verbatim catalog with or without it", async () => {
    const hook = createSafetyHooks().PreToolUse!.find((entry) => entry.matcher === "Bash")!.hooks[0];
    for (const cwd of [safe, ""]) {
      const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: catalogInput, cwd };
      expect(await hook(input as Parameters<typeof hook>[0], undefined, { signal: new AbortController().signal })).toEqual({});
      expect(evaluateCodexHookEnvelope(input)).toEqual(cwd ? {} : { systemMessage: MISSING_CWD_WARNING });
    }
  });
  it("preserves the exact missing-envelope message", () => {
    expect(check({ name: "missing", command: "cat > .isomux/x", cwd: "", denied: true })).toEqual({
      decision: "deny",
      reason: "BLOCKED by isomux safety hooks\n\n" +
        "Reason: isomux could not resolve the relative path because the tool call " +
        "did not include a non-empty absolute agent cwd.\n\n" +
        "Bash target: .isomux/x\n\n" +
        "Tell the user that the safety hook received a missing or invalid cwd, " +
        "and use an absolute write target.",
    });
  });
});

const scratch = mkdtempSync(join(tmpdir(), "isomux-cwd-mutants-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// Each mutation changes one rule; the ordinary case table supplies assertions.
// Scratch modules never edit the worktree under review.
const mutations = [
  {
    name: "opaque directory detection depends on keyword list",
    from: 'return node.words.some((word) => !word.quoted && !word.redirect && ["cd", "pushd", "popd"].includes(word.text));',
    to: `const words = node.words.filter((word) => !word.redirect);
      while (words[0] && !words[0].quoted && ["{", "}", "then", "do", "else", "!"].includes(words[0].text)) words.shift();
      return commandCandidates(words).some((candidate) => ["cd", "pushd", "popd"].includes(candidate.name));`,
    cases: ["opaque while cd stays denied", "opaque builtin cd stays denied"],
  },
  { name: "opaque syntax discards cwd without cd", from: "opaque && hasDirectoryChange ? new Set([UNKNOWN_DIRECTORY]) : input", to: "opaque ? new Set([UNKNOWN_DIRECTORY]) : input", cases: ["case arm without cd keeps cwd", "write before case without cd keeps cwd"] },
  { name: "drop original cwd from sequence union", from: "const next = unionDirectories(left.success, left.failure);", to: "const next = left.success;", cases: ["semicolon includes original cwd", "newline includes original cwd"] },
  { name: "AND trusts failed cd", from: "schedule(node.right, left.success,", to: "schedule(node.right, unionDirectories(left.success, left.failure),", cases: ["failed cd with && skips write", "AND continuation newline"] },
  { name: "OR trusts successful cd", from: "schedule(node.right, left.failure,", to: "schedule(node.right, left.success,", cases: ["OR uses original cwd", "OR excludes successful destination"] },
  { name: "subshell moves parent", from: "schedule(node.body, input, () => {", to: "schedule(node.body, input, (child) => { input = child.success;", cases: ["subshell keeps parent protected", "subshell redirect uses parent"] },
  { name: "substitution moves parent", from: "walk(substitution, directories);", to: "directories = walk(substitution, directories).success;", cases: ["substitution keeps parent protected", "backticks keep parent protected"] },
  { name: "job moves parent", from: "schedule(node.right, input, () => finish(unchanged(input)));", to: "schedule(node.right, left.success, () => finish(unchanged(input)));", cases: ["pipeline sibling starts in parent"] },
  { name: "background moves parent", from: "schedule(node.right, input, finish);", to: "schedule(node.right, left.success, finish);", cases: ["background keeps parent protected"] },
  { name: "remove nonliteral protected segment guard", from: 'if (target.dynamic && target.text.split("/").includes(".isomux")) {', to: "if (false) {", cases: ["nonliteral target plain", "nonliteral target after group"] },
  {
    name: "restore raw control co-trigger",
    from: "walk(syntax, inheritedDirectories ?? new Set([policyCwd(initialCwd)]));",
    to: String.raw`if (/(?:^|[;&|()\s])(?:cd|pushd|popd)(?:\s|$)/.test(command) && /\|\||(^|[^&])&([^&]|$)|[()]/.test(command)) return denyShellPath("raw control", false);
  walk(syntax, inheritedDirectories ?? new Set([policyCwd(initialCwd)]));`,
    cases: ["verbatim catalog with known cwd", "verbatim catalog without envelope cwd", "single-quoted parentheses", "double-quoted parentheses", "escaped parentheses", "comment parentheses", "literal quote with cd text", "sed program parentheses", "descriptor duplication 2>&1", "descriptor duplication >&2", "both descriptors redirect", "OR safe original", "subshell keeps parent safe", "substitution keeps parent safe", "background keeps parent safe"],
  },
];

describe("shell cwd flow mutations", () => {
  for (const [index, mutation] of mutations.entries()) {
    it(mutation.name, async () => {
      const source = readFileSync(join(import.meta.dir, "safety-policy.ts"), "utf8");
      expect(source.split(mutation.from).length, "mutation must match exactly once").toBe(2);
      const mutated = source.replace(mutation.from, mutation.to).replace(/from "(\.\/[^"\n]+)"/g,
        (_match, path: string) => `from ${JSON.stringify(new URL(path, import.meta.url).href)}`);
      expect(mutated).not.toBe(source);
      const path = join(scratch, `mutation-${index}.ts`);
      writeFileSync(path, mutated);
      const module = await import(path) as { evaluateProposedAction: typeof evaluateProposedAction };
      for (const name of mutation.cases) {
        const testCase = cases.find((entry) => entry.name === name)!;
        expect(check(testCase).decision === "deny", name).toBe(testCase.denied);
        expect(check(testCase, module.evaluateProposedAction).decision === "deny", name).not.toBe(testCase.denied);
      }
    });
  }
});
