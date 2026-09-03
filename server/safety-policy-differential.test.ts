import { afterAll, describe, expect, it } from "bun:test";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { createSafetyHooks } from "./safety-hooks.ts";

const BASELINE_COMMIT = "b6a2e52";
const BASELINE_BLOB = "7cce10438f6a66cbb2b03b23211c73aac5f28366";
const BASELINE_SHA256 =
  "553e6f1e3b7ea9e704f33e03619b1a413fcc9cbf1195126bdedef5fd80fff53b";

type Hooks = Partial<Record<string, HookCallbackMatcher[]>>;
type HookFactory = () => Hooks;
type Case = {
  name: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: unknown;
  intendedDivergence?: { baselineDenied: boolean; currentDenied: boolean };
};
type Decision = { denied: boolean; reason: string };

const scratch = mkdtempSync(join(tmpdir(), "isomux-policy-differential-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function sha256(source: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  return hasher.digest("hex");
}

async function decide(factory: HookFactory, testCase: Case): Promise<Decision> {
  const matchers = factory().PreToolUse ?? [];
  const hooks = matchers
    .filter((matcher) => matcher.matcher === testCase.toolName)
    .flatMap((matcher) => matcher.hooks);
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: testCase.toolName,
    tool_input: testCase.toolInput,
    cwd: testCase.cwd === undefined ? "/tmp/probe" : testCase.cwd,
  } as unknown as Parameters<HookCallback>[0];

  for (const hook of hooks) {
    const output: HookJSONOutput = await hook(input, undefined, {
      signal: new AbortController().signal,
    });
    const specific = (
      output as {
        hookSpecificOutput?: Record<string, unknown>;
      }
    ).hookSpecificOutput;
    if (specific?.permissionDecision === "deny") {
      return {
        denied: true,
        reason: String(specific.permissionDecisionReason),
      };
    }
  }
  return { denied: false, reason: "" };
}

async function baselineFactory(): Promise<HookFactory> {
  expect(
    git("rev-parse", `${BASELINE_COMMIT}:server/safety-hooks.ts`).trim(),
  ).toBe(BASELINE_BLOB);
  const source = git("cat-file", "blob", BASELINE_BLOB);
  expect(sha256(source)).toBe(BASELINE_SHA256);

  // This is the only mechanical change to the git-derived bytes: the scratch
  // module needs the production config import resolved back into this checkout.
  const configUrl = new URL("./config.ts", import.meta.url).href;
  const importable = source.replace(
    'from "./config.ts"',
    `from ${JSON.stringify(configUrl)}`,
  );
  expect(importable).not.toBe(source);
  expect(
    importable.replace(
      `from ${JSON.stringify(configUrl)}`,
      'from "./config.ts"',
    ),
  ).toBe(source);
  const path = join(scratch, "baseline-safety-hooks.ts");
  writeFileSync(path, importable);
  const module = (await import(path)) as { createSafetyHooks: HookFactory };
  return module.createSafetyHooks;
}

async function mutantFactory(
  name: string,
  mutatePolicy: (source: string) => string = (source) => source,
  mutateAdapter: (source: string) => string = (source) => source,
  mutateCredentialPaths: (source: string) => string = (source) => source,
): Promise<HookFactory> {
  const policySource = readFileSync(
    join(import.meta.dir, "safety-policy.ts"),
    "utf8",
  );
  const adapterSource = readFileSync(
    join(import.meta.dir, "safety-hooks.ts"),
    "utf8",
  );
  const credentialPathsSource = readFileSync(
    join(import.meta.dir, "backend-credential-paths.ts"),
    "utf8",
  );
  const configUrl = new URL("./config.ts", import.meta.url).href;
  const policyPath = join(scratch, `${name}-policy.ts`);
  const adapterPath = join(scratch, `${name}-hooks.ts`);
  const credentialPathsPath = join(
    scratch,
    `${name}-backend-credential-paths.ts`,
  );
  const importablePolicy = policySource
    .replace('from "./config.ts"', `from ${JSON.stringify(configUrl)}`)
    .replace(
      'from "./backend-credential-paths.ts"',
      `from "./${name}-backend-credential-paths.ts"`,
    );
  const importableAdapter = adapterSource.replace(
    'from "./safety-policy.ts"',
    `from "./${name}-policy.ts"`,
  );
  const policy = mutatePolicy(importablePolicy);
  const adapter = mutateAdapter(importableAdapter);
  const credentialPaths = mutateCredentialPaths(credentialPathsSource);
  expect(
    policy !== importablePolicy ||
      adapter !== importableAdapter ||
      credentialPaths !== credentialPathsSource,
    `${name} mutation changed no bytes`,
  ).toBe(true);
  writeFileSync(policyPath, policy);
  writeFileSync(adapterPath, adapter);
  writeFileSync(credentialPathsPath, credentialPaths);
  const module = (await import(adapterPath)) as {
    createSafetyHooks: HookFactory;
  };
  return module.createSafetyHooks;
}

const shell = (name: string, command: string): Case => ({
  name,
  toolName: "Bash",
  toolInput: { command },
});
const tool = (
  name: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Case => ({ name, toolName, toolInput });

const divergence = (
  testCase: Case,
  baselineDenied: boolean,
  currentDenied: boolean,
): Case => ({
  ...testCase,
  intendedDivergence: { baselineDenied, currentDenied },
});

// Each rule family has a deny and an allow control. The mixed safe/destructive
// and safe/tunnel cases detect ordering changes that ordinary examples cannot.
const corpus: Case[] = [
  shell("ordinary allow", "git status --short"),
  shell("checkout path deny", "git checkout -- README.md"),
  shell("checkout ref path deny", "git checkout HEAD -- README.md"),
  shell("restore deny", "git restore README.md"),
  shell("restore worktree deny", "git restore --worktree README.md"),
  shell("reset hard deny", "git reset --hard HEAD"),
  shell("reset merge deny", "git reset --merge HEAD"),
  shell("git clean force deny", "git clean -f"),
  shell("git push force deny", "git push origin main --force"),
  shell("git push short force deny", "git push origin main -f"),
  shell("branch force delete deny", "git branch -D topic"),
  shell("rm root deny", "rm -rf /"),
  shell("rm reverse cluster root deny", "rm -fr /"),
  shell("rm mixed cluster deny", "rm -Rvf ./build"),
  shell("rm separate flags deny", "rm -r -f ./build"),
  shell("rm long flags deny", "rm --recursive --force ./build"),
  shell("stash drop deny", "git stash drop"),
  shell("stash clear deny", "git stash clear"),
  shell("safe checkout allow", "git checkout -b topic"),
  shell("safe restore allow", "git restore --staged README.md"),
  shell("safe clean allow", "git clean -n"),
  shell("safe temp rm allow", "rm -rf /tmp/isomux-probe"),
  shell("safe reverse temp rm allow", "rm -fr /tmp/isomux-probe"),
  shell("safe var temp rm allow", "rm -Rvf /var/tmp/isomux-probe"),
  shell("safe tmpdir rm allow", "rm -fr $TMPDIR/isomux-probe"),
  shell(
    "safe fragment short-circuits destructive fragment",
    "git clean -n; git reset --hard HEAD",
  ),
  shell("tunnel precedes safe fragment", "git clean -n; ngrok http 4000"),
  shell("quoted shell reader deny", 'bash -c "cat ~/.env"'),
  shell("quoted shell kill deny", 'bash -c "pkill -f bun"'),
  shell("quoted prose allow", 'echo "cat ~/.env; pkill -f bun"'),
  shell("protected command write deny", "tee ~/.isomux/agents.json"),
  shell(
    "quoted redirect prose now allows",
    `cd /tmp/rev1-copy && jq -n --arg t '<prose containing parens (x) and git diff HEAD > /tmp/frozen-x.diff>' '{text:$t}' | curl localhost:4000 -d @- | sed -E 's/[A-Za-z0-9_-]{30,}/REDACTED/g'`,
  ),
  shell(
    "compound sed program is not a write target",
    `cd /tmp/rev1-copy && python3 - <<'EOF'\nprint("rendered (copy)")\nEOF\nsed -n 82,86p /tmp/rev1-copy/shared/identity.ts`,
  ),
  shell(
    "compound bun subcommand is not a write target",
    `cd /tmp/rev1-copy && cat > /tmp/rev1-render.ts <<'EOF'\nconsole.log("rendered (copy)")\nEOF\nbun run /tmp/rev1-render.ts`,
  ),
  divergence(
    shell(
      "protected sed read now allows",
      `sed -n '44p' ${join(STATE_ROOT, "agents.json")}`,
    ),
    true,
    false,
  ),
  divergence(
    shell(
      "protected awk read now allows",
      `awk '{print}' ${join(STATE_ROOT, "agents.json")}`,
    ),
    true,
    false,
  ),
  divergence(
    shell(
      "protected perl read now allows",
      `perl -ne 'print' ${join(STATE_ROOT, "agents.json")}`,
    ),
    true,
    false,
  ),
  shell(
    "clustered sed in-place remains denied",
    `sed -ni.bak 's/a/b/' ${join(STATE_ROOT, "agents.json")}`,
  ),
  shell(
    "perl in-place remains denied",
    `perl -pi -e 's/a/b/' ${join(STATE_ROOT, "agents.json")}`,
  ),
  shell(
    "tee pipeline remains denied",
    `echo x | tee ${join(STATE_ROOT, "agents.json")}`,
  ),
  shell(
    "compound redirect remains denied",
    `cd /tmp && echo ok; echo x > ${join(STATE_ROOT, "agents.json")}`,
  ),
  divergence(
    shell(
      "raw parenthesis cwd co-trigger remains denied",
      "cd /tmp/c && echo 'a(b)' > out.txt",
    ),
    false,
    true,
  ),
  shell(
    "plain literal cd and relative redirect remains allowed",
    "cd /tmp/c && echo ab > out.txt",
  ),
  divergence(
    shell(
      "relative protected redirect now denies",
      "cd ~ && echo x > .isomux/agents.json",
    ),
    false,
    true,
  ),
  divergence(
    shell(
      "unresolved cd now denies relative write",
      "cd $HOME && echo x > .isomux/agents.json",
    ),
    false,
    true,
  ),
  divergence(
    shell(
      "dynamic cd now denies any relative write",
      'cd "$D" && echo x > out.txt',
    ),
    false,
    true,
  ),
  divergence(
    shell(
      "literal protected cd now denies later relative write",
      "cd ~/.isomux && echo x > agents.json",
    ),
    false,
    true,
  ),
  divergence(
    shell(
      "relative protected copy now denies",
      "cd ~ && cp /tmp/evil .isomux/agents.json",
    ),
    false,
    true,
  ),
  shell(
    "state-root true child remains denied",
    `echo x > ${join(STATE_ROOT, "logs/marker")}`,
  ),
  divergence(
    shell(
      "state-root workspace sibling now allows",
      `echo x > ${STATE_ROOT}-workspace/marker`,
    ),
    true,
    false,
  ),
  divergence(
    shell(
      "state-root homely sibling now allows",
      `echo x > ${STATE_ROOT}ly/marker`,
    ),
    true,
    false,
  ),
  tool("read sensitive deny", "Read", { file_path: "/tmp/probe/.env" }),
  tool("read ordinary allow", "Read", { file_path: "/tmp/probe/README.md" }),
  tool("write unknown shape deny", "Write", { content: "x" }),
  tool("write ordinary allow", "Write", { file_path: "/tmp/probe/out.txt" }),
  tool("write relative ordinary allow", "Write", { file_path: "out.txt" }),
  divergence(
    {
      ...tool("agent-cwd relative protected write now denies", "Write", {
        file_path: "agents.json",
      }),
      cwd: join(STATE_ROOT, "logs"),
    },
    false,
    true,
  ),
  divergence(
    {
      ...tool("missing cwd protected candidate now denies", "Write", {
        file_path: ".isomux/agents.json",
      }),
      cwd: null,
    },
    false,
    true,
  ),
  tool("notebook sensitive read deny", "NotebookEdit", {
    notebook_path: "/tmp/probe/.env",
  }),
  tool("notebook ordinary allow", "NotebookEdit", {
    notebook_path: "/tmp/probe/analysis.ipynb",
  }),
  tool("OpenCode native credential deny", "Read", {
    file_path: "/home/probe/.local/share/opencode/auth.json",
  }),
  divergence(
    tool("OpenCode native MCP credential deny", "Read", {
      file_path: "/home/probe/.local/share/opencode/mcp-auth.json",
    }),
    false,
    true,
  ),
  tool("OpenCode profile credential deny", "Read", {
    file_path: "/tmp/state/opencode/profiles/default/data/opencode/auth.json",
  }),
  divergence(
    tool("OpenCode profile MCP credential deny", "Read", {
      file_path:
        "/tmp/state/opencode/profiles/default/data/opencode/mcp-auth.json",
    }),
    false,
    true,
  ),
  tool("OpenCode nested profile path allow", "Read", {
    file_path: "/tmp/state/opencode/profiles/a/b/data/opencode/auth.json",
  }),
  tool("OpenCode project auth location allow", "Read", {
    file_path: "/tmp/some-project/opencode/auth.json",
  }),
  tool("generic project auth location allow", "Read", {
    file_path: "/tmp/some-project/auth.json",
  }),
  tool("OpenCode nested MCP profile path allow", "Read", {
    file_path: "/tmp/state/opencode/profiles/a/b/data/opencode/mcp-auth.json",
  }),
  tool("OpenCode project MCP auth location allow", "Read", {
    file_path: "/tmp/some-project/opencode/mcp-auth.json",
  }),
  tool("generic project MCP auth location allow", "Read", {
    file_path: "/tmp/some-project/mcp-auth.json",
  }),
];

const tripwires = {
  M1: corpus.find((entry) => entry.name === "quoted shell reader deny")!,
  M3: corpus.find(
    (entry) =>
      entry.name === "safe fragment short-circuits destructive fragment",
  )!,
  M4: corpus.find((entry) => entry.name === "write unknown shape deny")!,
  M5: corpus.find((entry) => entry.name === "notebook sensitive read deny")!,
  M6: corpus.find((entry) => entry.name === "tunnel precedes safe fragment")!,
  native: corpus.find(
    (entry) => entry.name === "OpenCode native credential deny",
  )!,
  profile: corpus.find(
    (entry) => entry.name === "OpenCode profile credential deny",
  )!,
  nestedProfile: corpus.find(
    (entry) => entry.name === "OpenCode nested profile path allow",
  )!,
  relativeAllow: corpus.find(
    (entry) => entry.name === "write relative ordinary allow",
  )!,
  cwdProtected: corpus.find(
    (entry) => entry.name === "agent-cwd relative protected write now denies",
  )!,
  sibling: corpus.find(
    (entry) => entry.name === "state-root workspace sibling now allows",
  )!,
  child: corpus.find(
    (entry) => entry.name === "state-root true child remains denied",
  )!,
  missingCwd: corpus.find(
    (entry) => entry.name === "missing cwd protected candidate now denies",
  )!,
  unresolvedCd: corpus.find(
    (entry) => entry.name === "unresolved cd now denies relative write",
  )!,
  dynamicCd: corpus.find(
    (entry) => entry.name === "dynamic cd now denies any relative write",
  )!,
  literalProtectedCd: corpus.find(
    (entry) =>
      entry.name === "literal protected cd now denies later relative write",
  )!,
};

async function expectCaseAgainstBaseline(
  currentFactory: HookFactory,
  baseline: HookFactory,
  testCase: Case,
): Promise<void> {
  const current = await decide(currentFactory, testCase);
  const original = await decide(baseline, testCase);
  if (testCase.intendedDivergence) {
    expect(original.denied, `${testCase.name}: baseline`).toBe(
      testCase.intendedDivergence.baselineDenied,
    );
    expect(current.denied, `${testCase.name}: current`).toBe(
      testCase.intendedDivergence.currentDenied,
    );
  } else {
    expect(current, testCase.name).toEqual(original);
  }
}

describe("provider-neutral safety-policy extraction", () => {
  it("rejects a mutant whose replacement changes no bytes", async () => {
    let caught: unknown;
    try {
      await mutantFactory("no-op");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("no-op mutation changed no bytes");
  });

  it("matches the git-derived pre-extraction policy on decision and deny text", async () => {
    const baseline = await baselineFactory();
    for (const testCase of corpus) {
      await expectCaseAgainstBaseline(createSafetyHooks, baseline, testCase);
    }
  });

  it("rejects the old broad positional write-target classifier", async () => {
    const oldClassifier = await mutantFactory("broad-write-targets", (source) =>
      source
        .replace(
          '  "ln",\n];',
          '  "ln",\n  "sed",\n  "awk",\n  "perl",\n  "python",\n  "python3",\n  "ruby",\n  "node",\n  "bun",\n];',
        )
        .replace('  if (command.name === "sed") {', "  if (false) {")
        .replace('  if (command.name === "perl") {', "  if (false) {"),
    );
    const expectedChanges = [
      "quoted redirect prose now allows",
      "compound sed program is not a write target",
      "compound bun subcommand is not a write target",
      "protected sed read now allows",
      "protected awk read now allows",
      "protected perl read now allows",
    ];
    const changed: string[] = [];
    for (const testCase of corpus) {
      const current = await decide(createSafetyHooks, testCase);
      const old = await decide(oldClassifier, testCase);
      if (current.denied !== old.denied) changed.push(testCase.name);
      else expect(current, testCase.name).toEqual(old);
    }
    expect(changed).toEqual(expectedChanges);
    for (const name of expectedChanges) {
      const testCase = corpus.find((entry) => entry.name === name)!;
      expect((await decide(createSafetyHooks, testCase)).denied, name).toBe(
        false,
      );
      expect((await decide(oldClassifier, testCase)).denied, name).toBe(true);
    }
  });

  it("proves each claimed tripwire fails against its wrong implementation", async () => {
    const baseline = await baselineFactory();
    const mutants: Array<[string, HookFactory, Case]> = [
      [
        "M1 raw command replaced by stripped command",
        await mutantFactory("m1", (source) =>
          source
            .replace("checkProcessKill(command)", "checkProcessKill(stripped)")
            .replace(
              "bashSensitiveReadTarget(command)",
              "bashSensitiveReadTarget(stripped)",
            ),
        ),
        tripwires.M1,
      ],
      [
        "M3 destructive rules moved before safe rules",
        await mutantFactory("m3", (source) =>
          source.replace(
            "for (const pattern of SAFE_PATTERNS) {\n    if (pattern.test(normalized)) return allow();\n  }\n\n  // Check destructive patterns (blocklist)\n  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {\n    if (pattern.test(normalized)) {\n      return denyMessage(reason, command);\n    }\n  }",
            "for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {\n    if (pattern.test(normalized)) return denyMessage(reason, command);\n  }\n  for (const pattern of SAFE_PATTERNS) {\n    if (pattern.test(normalized)) return allow();\n  }",
          ),
        ),
        tripwires.M3,
      ],
      [
        "M4 unknown path shape allowed",
        await mutantFactory("m4", (source) =>
          source.replace(
            "return spec?.targetOptional ? [] : null;",
            "return [];",
          ),
        ),
        tripwires.M4,
      ],
      [
        "M5 read check dropped from read-and-write action",
        await mutantFactory("m5", undefined, (source) =>
          source.replace(
            '{ matcher: "NotebookEdit", hooks: [readAndWriteFiles] }',
            '{ matcher: "NotebookEdit", hooks: [writeFiles] }',
          ),
        ),
        tripwires.M5,
      ],
      [
        "M6 tunnel moved behind safe allowlist",
        await mutantFactory("m6", (source) =>
          source.replace(
            "if (tunnel) {",
            "if (tunnel && !SAFE_PATTERNS.some((pattern) => pattern.test(normalized))) {",
          ),
        ),
        tripwires.M6,
      ],
      [
        "OpenCode native credential arm dropped",
        await mutantFactory("native", undefined, undefined, (source) =>
          source.replace(
            "(?:\\.local\\/share\\/opencode|opencode",
            "(?:never|opencode",
          ),
        ),
        tripwires.native,
      ],
      [
        "OpenCode profile credential arm dropped",
        await mutantFactory("profile", undefined, undefined, (source) =>
          source.replace(
            "opencode\\/profiles\\/[^/]+\\/data\\/opencode",
            "opencode\\/profiles\\/never\\/data\\/opencode",
          ),
        ),
        tripwires.profile,
      ],
      [
        "OpenCode profile segment loosened",
        await mutantFactory("profile-segment", undefined, undefined, (source) =>
          source.replace(
            "opencode\\/profiles\\/[^/]+\\/data",
            "opencode\\/profiles\\/.+\\/data",
          ),
        ),
        tripwires.nestedProfile,
      ],
    ];

    for (const [name, mutant, testCase] of mutants) {
      expect(await decide(mutant, testCase), name).not.toEqual(
        await decide(baseline, testCase),
      );
    }
  });

  it("kills cwd and protected-boundary mutants on their assigned properties", async () => {
    const mutants: Array<[string, HookFactory, Case]> = [
      [
        "adapter forwards no cwd",
        await mutantFactory("cwd-missing", undefined, (source) =>
          source.replace(
            "cwd: (input as PreToolUseHookInput).cwd",
            "cwd: undefined",
          ),
        ),
        tripwires.cwdProtected,
      ],
      [
        "adapter forwards constant /tmp cwd",
        await mutantFactory("cwd-constant", undefined, (source) =>
          source.replace(
            "cwd: (input as PreToolUseHookInput).cwd",
            'cwd: "/tmp"',
          ),
        ),
        tripwires.cwdProtected,
      ],
      [
        "state-root helper reverts to substring matching",
        await mutantFactory("boundary-substring", (source) =>
          source.replace(
            'return filePath === root || filePath.startsWith(root + "/");',
            "return filePath.includes(root);",
          ),
        ),
        tripwires.sibling,
      ],
      [
        "state-root helper drops the child arm",
        await mutantFactory("boundary-exact", (source) =>
          source.replace(
            'return filePath === root || filePath.startsWith(root + "/");',
            "return filePath === root;",
          ),
        ),
        tripwires.child,
      ],
      [
        "missing cwd falls back to process cwd",
        await mutantFactory("cwd-fallback", (source) =>
          source.replace(
            "if (!base) return null;",
            "if (!base) return resolve(filePath);",
          ),
        ),
        tripwires.missingCwd,
      ],
      [
        "unresolved cd keeps the previous cwd",
        await mutantFactory("cwd-stale", (source) =>
          source.replace(
            "if (uncertainControl || dynamicDirectoryTarget(target)) {\n          effectiveCwd = null;\n          directoryChangeMadeCwdUnknown = true;",
            "if (uncertainControl || dynamicDirectoryTarget(target)) {\n          effectiveCwd = policyCwd(initialCwd);\n          directoryChangeMadeCwdUnknown = false;",
          ),
        ),
        tripwires.unresolvedCd,
      ],
      [
        "redirect-only command list is skipped",
        await mutantFactory("redirect-only-skipped", (source) =>
          source.replace("if (candidates.length === 0) {", "if (false) {"),
        ),
        {
          ...shell(
            "redirect-only mutation probe",
            `> ${join(STATE_ROOT, "agents.json")}`,
          ),
        },
      ],
      [
        "literal protected cd operand is not checked",
        await mutantFactory("literal-cd-skipped", (source) =>
          source.replace(
            "effectiveCwd = resolvePath(target!.text, effectiveCwd);",
            "effectiveCwd = policyCwd(initialCwd);",
          ),
        ),
        tripwires.literalProtectedCd,
      ],
      [
        "dynamic cd with a relative write is allowed",
        await mutantFactory("dynamic-cd-allowed", (source) =>
          source.replace(
            "effectiveCwd = null;\n          directoryChangeMadeCwdUnknown = true;\n        } else {",
            "effectiveCwd = null;\n          directoryChangeMadeCwdUnknown = false;\n        } else {",
          ),
        ),
        tripwires.dynamicCd,
      ],
    ];

    for (const [name, factory, testCase] of mutants) {
      expect(await decide(factory, testCase), name).not.toEqual(
        await decide(createSafetyHooks, testCase),
      );
    }
  });

  it("fails when a listed divergence stops diverging", async () => {
    const baseline = await baselineFactory();
    const reverted = await mutantFactory(
      "listed-divergence-reverted",
      (source) =>
        source.replaceAll(
          "if (isAtOrBelowStateRoot(resolved)) {",
          "if (false) {",
        ),
    );
    let caught: unknown;
    try {
      await expectCaseAgainstBaseline(
        reverted,
        baseline,
        tripwires.cwdProtected,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
