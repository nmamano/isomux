import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "../../config.ts";
import { evaluateProposedAction } from "../../safety-policy.ts";
import {
  buildCodexSafetyHook,
  type BuiltCodexSafetyHook,
} from "./safety-hook-build.ts";
import {
  codexEnvelopeToAction,
  evaluateCodexHookEnvelope,
  handleCodexHookInput,
  policyDecisionToCodexOutput,
  SAFETY_WARNING,
  type CodexHookOutput,
} from "./safety-hook.ts";

type Envelope = {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
};

type HookModule = {
  evaluateCodexHookEnvelope: (value: unknown) => CodexHookOutput;
  handleCodexHookInput: (input: string) => CodexHookOutput;
};

const root = mkdtempSync(join(tmpdir(), "isomux-codex-safety-hook-test-"));
const executablePath = join(root, "isomux-codex-safety-hook");
let built: BuiltCodexSafetyHook;

beforeAll(async () => {
  built = await buildCodexSafetyHook(executablePath);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function envelope(
  toolName: string,
  toolInput: Record<string, unknown>,
): Envelope {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

async function runExecutable(input: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([executablePath], {
    env: { ...process.env, ISOMUX_HOME: STATE_ROOT },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function coreOutput(input: Envelope): CodexHookOutput {
  return policyDecisionToCodexOutput(
    evaluateProposedAction(codexEnvelopeToAction(input)),
  );
}

async function mutantHook(
  name: string,
  mutatePolicy: (source: string) => string = (source) => source,
  mutateHook: (source: string) => string = (source) => source,
): Promise<HookModule> {
  const policySource = readFileSync(
    join(import.meta.dir, "../../safety-policy.ts"),
    "utf8",
  );
  const hookSource = readFileSync(
    join(import.meta.dir, "safety-hook.ts"),
    "utf8",
  );
  const configUrl = new URL("../../config.ts", import.meta.url).href;
  const importablePolicy = policySource.replace(
    'from "./config.ts"',
    `from ${JSON.stringify(configUrl)}`,
  );
  const policyPath = join(root, `${name}-policy.ts`);
  const hookPath = join(root, `${name}-hook.ts`);
  const importableHook = hookSource.replace(
    'from "../../safety-policy.ts"',
    `from "./${name}-policy.ts"`,
  );
  const policy = mutatePolicy(importablePolicy);
  const hook = mutateHook(importableHook);
  expect(
    policy !== importablePolicy || hook !== importableHook,
    `${name} mutation changed no bytes`,
  ).toBe(true);
  writeFileSync(policyPath, policy);
  writeFileSync(hookPath, hook);
  return (await import(hookPath)) as HookModule;
}

const largeBash = envelope("Bash", {
  command: `printf %s ${"x".repeat(256 * 1024)}`,
});
const largePatch = envelope("apply_patch", {
  command: `*** Begin Patch\n*** Add File: /tmp/large.txt\n+${"x".repeat(256 * 1024)}\n*** End Patch`,
});

const corpus: Array<{ name: string; input: Envelope }> = [
  { name: "Bash allow", input: envelope("Bash", { command: "git status" }) },
  { name: "Bash deny", input: envelope("Bash", { command: "rm -rf /" }) },
  {
    name: "apply_patch allow",
    input: envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Add File: /tmp/safe.txt\n+x\n*** End Patch",
    }),
  },
  {
    name: "apply_patch protected deny",
    input: envelope("apply_patch", {
      command: `*** Begin Patch\n*** Update File: ${join(STATE_ROOT, "agents.json")}\n@@\n-old\n+new\n*** End Patch`,
    }),
  },
  {
    name: "apply_patch unverifiable deny",
    input: envelope("apply_patch", {
      command: "*** Begin Patch\n*** Move to: /tmp/destination\n*** End Patch",
    }),
  },
  {
    name: "uncovered tool allow",
    input: envelope("mcp__filesystem__write_file", {
      path: join(STATE_ROOT, "agents.json"),
    }),
  },
  { name: "large valid Bash envelope", input: largeBash },
  { name: "large valid apply_patch envelope", input: largePatch },
];

describe("standalone Codex safety hook", () => {
  it("pins Nil's signed safety-warning copy exactly", () => {
    expect(SAFETY_WARNING).toBe(
      "ISOMUX SAFETY WARNING: Safety checks failed for this tool call. Isomux allowed it without guard enforcement. Tell the office owner and check the isomux service logs.",
    );
  });

  it("stamps the complete local source closure into the executable", async () => {
    expect(built.sourceFiles).toEqual([
      "server/backends/codex/safety-hook.ts",
      "server/config.ts",
      "server/safety-policy.ts",
    ]);
    const child = Bun.spawn([executablePath, "--source-hash"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(built.sourceSha256);
  });

  it("maps only explicit tool names onto neutral action kinds", () => {
    expect(
      codexEnvelopeToAction(envelope("Bash", { command: "echo ok" })),
    ).toEqual({
      kind: "shell",
      command: "echo ok",
    });
    expect(
      codexEnvelopeToAction(
        envelope("apply_patch", { command: "*** Begin Patch" }),
      ),
    ).toEqual({
      kind: "patch-files",
      toolName: "apply_patch",
      patch: "*** Begin Patch",
    });
    expect(
      codexEnvelopeToAction(
        envelope("future_tool", { command: "rm -rf /", path: STATE_ROOT }),
      ),
    ).toEqual({
      kind: "uncovered-tool",
      toolName: "future_tool",
      input: { command: "rm -rf /", path: STATE_ROOT },
    });
  });

  it("diffs the in-process core and compiled executable exactly", async () => {
    for (const testCase of corpus) {
      const expected = coreOutput(testCase.input);
      expect(
        evaluateCodexHookEnvelope(testCase.input),
        `${testCase.name}: source adapter`,
      ).toEqual(expected);
      const result = await runExecutable(JSON.stringify(testCase.input));
      expect(result.exitCode, `${testCase.name}: exit`).toBe(0);
      expect(result.stderr, `${testCase.name}: stderr`).toBe("");
      expect(
        JSON.parse(result.stdout),
        `${testCase.name}: compiled output`,
      ).toEqual(expected);
    }
  });

  it("allows and warns on malformed technical input", async () => {
    expect(handleCodexHookInput("not json")).toEqual({
      systemMessage: SAFETY_WARNING,
    });
    const result = await runExecutable("not json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: SAFETY_WARNING,
    });
  });

  it("denies a valid patch whose paths cannot be determined", () => {
    const output = evaluateCodexHookEnvelope(
      envelope("apply_patch", {
        command: "*** Begin Patch\n*** Move to: /tmp/out\n*** End Patch",
      }),
    );
    expect(output).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(output)).toContain("could not tell which file");
    expect(JSON.stringify(output)).not.toContain(SAFETY_WARNING);
  });

  it("handles 256 KiB valid Bash and patch payloads normally", () => {
    expect(evaluateCodexHookEnvelope(largeBash)).toEqual({});
    expect(evaluateCodexHookEnvelope(largePatch)).toEqual({});
  });

  it("does not turn extreme valid agent content into a fault allow", () => {
    const denyCommands = [
      `${"(".repeat(50_000)}rm -rf /${")".repeat(50_000)}`,
      `${"true;".repeat(20_000)}rm -rf /`,
      `${"`".repeat(5_000)}rm -rf /${"`".repeat(5_000)}`,
      `${"x".repeat(256 * 1024)}; rm -rf /`,
    ];
    for (const command of denyCommands) {
      const output = handleCodexHookInput(
        JSON.stringify(envelope("Bash", { command })),
      );
      expect(output).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(JSON.stringify(output)).not.toContain(SAFETY_WARNING);
    }

    const deepInput =
      '{"hook_event_name":"PreToolUse","tool_name":"future_tool","tool_input":' +
      '{"nested":'.repeat(10_000) +
      "null" +
      "}".repeat(10_000) +
      "}";
    expect(handleCodexHookInput(deepInput)).toEqual({});
  });

  it("turns every patch and action-kind tripwire red", async () => {
    const protectedPath = join(STATE_ROOT, "bin/isomux-codex-safety-hook");
    const safePatchWithFakeHeader = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Add File: /tmp/notes.txt\n" +
        `+*** Update File: ${protectedPath}\n*** End Patch`,
    });
    const safeToProtectedMove = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Update File: /tmp/source.txt\n" +
        `*** Move to: ${protectedPath}\n*** End Patch`,
    });
    const protectedToSafeMove = envelope("apply_patch", {
      command:
        `*** Begin Patch\n*** Update File: ${protectedPath}\n` +
        "*** Move to: /tmp/destination.txt\n*** End Patch",
    });
    const moveWithoutUpdate = envelope("apply_patch", {
      command: "*** Begin Patch\n*** Move to: /tmp/safe.txt\n*** End Patch",
    });
    const malformedPatch = envelope("apply_patch", {
      command: "*** Begin Patch\n*** End Patch",
    });
    const safePatchContainingShellText = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Add File: /tmp/notes.txt\n" +
        "+rm -rf / is prose in the file\n*** End Patch",
    });
    const protectedPatch = envelope("apply_patch", {
      command:
        `*** Begin Patch\n*** Update File: ${protectedPath}\n` +
        "@@\n-old\n+new\n*** End Patch",
    });
    const uncovered = envelope("future_tool", { path: protectedPath });

    const mutants: Array<{
      name: string;
      module: HookModule;
      input: Envelope | string;
      malformed?: true;
    }> = [
      {
        name: "unanchored patch header",
        module: await mutantHook("unanchored", (source) =>
          source.replace(
            "line.match(/^\\*\\*\\* (Add|Delete|Update) File: (.+)$/)",
            "line.match(/\\*\\*\\* (Add|Delete|Update) File: (.+)$/)",
          ),
        ),
        input: safePatchWithFakeHeader,
      },
      {
        name: "move destination dropped",
        module: await mutantHook("drop-destination", (source) =>
          source.replace(
            "movedCurrentUpdate = true;\n      paths.push(path);",
            "movedCurrentUpdate = true;",
          ),
        ),
        input: safeToProtectedMove,
      },
      {
        name: "empty path set allowed",
        module: await mutantHook("empty-allowed", (source) =>
          source.replace(
            "return paths.length > 0 ? paths : null;",
            "return paths;",
          ),
        ),
        input: malformedPatch,
      },
      {
        name: "move without update accepted",
        module: await mutantHook("move-without-update", (source) =>
          source.replace('        section !== "update" ||\n', ""),
        ),
        input: moveWithoutUpdate,
      },
      {
        name: "update source dropped",
        module: await mutantHook("drop-source", (source) =>
          source.replace(
            "movedCurrentUpdate = false;\n      paths.push(path);",
            'movedCurrentUpdate = false;\n      if (section !== "update") paths.push(path);',
          ),
        ),
        input: protectedToSafeMove,
      },
      {
        name: "apply_patch routed to shell",
        module: await mutantHook("patch-to-shell", undefined, (source) =>
          source.replace(
            '      kind: "patch-files",',
            '      kind: "shell", command: input.tool_input.command,',
          ),
        ),
        input: safePatchContainingShellText,
      },
      {
        name: "patch-files allowed",
        module: await mutantHook("patch-allowed", (source) =>
          source.replace(
            '    case "patch-files":\n      return checkPatchSafety(action.toolName, action.patch);',
            '    case "patch-files":\n      return allow();',
          ),
        ),
        input: protectedPatch,
      },
      {
        name: "uncovered-tool denied",
        module: await mutantHook("uncovered-denied", (source) =>
          source.replace(
            '    case "uncovered-tool":\n      return allow();',
            '    case "uncovered-tool":\n      return { decision: "deny", reason: "mutant deny" };',
          ),
        ),
        input: uncovered,
      },
      {
        name: "fault emits invalid hook output",
        module: await mutantHook("fault-malformed", undefined, (source) =>
          source.replace(
            "return { systemMessage: SAFETY_WARNING };",
            'return "not-json" as unknown as CodexHookOutput;',
          ),
        ),
        input: "not json",
        malformed: true,
      },
    ];

    for (const mutant of mutants) {
      const actual = mutant.malformed
        ? mutant.module.handleCodexHookInput(mutant.input as string)
        : mutant.module.evaluateCodexHookEnvelope(mutant.input);
      const expected = mutant.malformed
        ? handleCodexHookInput(mutant.input as string)
        : evaluateCodexHookEnvelope(mutant.input);
      expect(actual, mutant.name).not.toEqual(expected);
    }
  });
});
