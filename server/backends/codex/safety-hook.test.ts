import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "../../config.ts";
import {
  buildCodexSafetyHook,
  type BuiltCodexSafetyHook,
} from "./safety-hook-build.ts";
import {
  evaluateCodexHookEnvelope,
  handleCodexHookInput,
  MISSING_CWD_WARNING,
  SAFETY_WARNING,
} from "./safety-hook.ts";

type Envelope = {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: unknown;
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
    cwd: "/tmp/probe",
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

const INTEL_MAC = process.platform === "darwin" && process.arch === "x64";

describe("standalone Codex safety hook", () => {
  // Quarantined on Intel macOS (task b0976a10): the two concurrent builds took 1.3-3.0 s
  // of the 5 s budget there when green, then timed out on 9d968d99 (read 2026-10-19).
  it.skipIf(INTEL_MAC)(
    "isolates concurrent compiler scratch files from the shared checkout",
    async () => {
      const repositoryRoot = join(import.meta.dir, "../../..");
      const scratchInCheckout = () =>
        readdirSync(repositoryRoot).filter((name) =>
          name.endsWith(".bun-build"),
        );
      expect(scratchInCheckout()).toEqual([]);
      const outputs = [join(root, "concurrent-a"), join(root, "concurrent-b")];
      let settled = false;
      let observations = 0;
      const builds = Promise.all(outputs.map(buildCodexSafetyHook));
      const observedBuilds = builds.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      void observedBuilds.finally(() => {
        settled = true;
      });
      let outcome: Awaited<typeof observedBuilds>;
      try {
        // No other compiler path should write Bun scratch files in this checkout.
        while (!settled) {
          observations++;
          expect(scratchInCheckout()).toEqual([]);
          await Bun.sleep(1);
        }
      } finally {
        outcome = await observedBuilds;
      }
      if (!outcome.ok) throw outcome.error;
      expect(observations).toBeGreaterThan(10);
      for (const output of outputs) {
        expect(existsSync(output)).toBe(true);
        expect(statSync(output).size).toBeGreaterThan(1_000_000);
      }
      expect(scratchInCheckout()).toEqual([]);
    },
  );

  // The closure must cover the policy, so a policy edit forces a rebuild.
  it("stamps the local source closure into the executable", async () => {
    expect(built.sourceFiles).toEqual(
      expect.arrayContaining([
        "server/backends/codex/safety-hook.ts",
        "server/safety-policy.ts",
      ]),
    );
    const child = Bun.spawn([executablePath, "--source-hash"], {
      env: process.env,
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

  // The compiled binary decides like the source, and its protected path
  // follows ISOMUX_HOME. One process per corpus case, run in parallel.
  it("diffs the in-process core and compiled executable exactly", async () => {
    const results = await Promise.all(
      corpus.map((testCase) => runExecutable(JSON.stringify(testCase.input))),
    );
    for (const [i, testCase] of corpus.entries()) {
      const result = results[i];
      expect(result.exitCode, `${testCase.name}: exit`).toBe(0);
      expect(result.stderr, `${testCase.name}: stderr`).toBe("");
      expect(
        JSON.parse(result.stdout),
        `${testCase.name}: compiled output`,
      ).toEqual(evaluateCodexHookEnvelope(testCase.input));
    }
  }, 30_000);

  it("uses the envelope cwd for relative apply_patch paths", async () => {
    const relativeProtected = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Update File: agents.json\n@@\n-old\n+new\n*** End Patch",
    });
    relativeProtected.cwd = join(STATE_ROOT, "logs");
    expect(evaluateCodexHookEnvelope(relativeProtected)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const relativeSafe = envelope("apply_patch", {
      command: "*** Begin Patch\n*** Add File: out.txt\n+x\n*** End Patch",
    });
    relativeSafe.cwd = "/tmp/probe";
    expect(evaluateCodexHookEnvelope(relativeSafe)).toEqual({});
  });

  it("denies the exact relative apply_patch repro", () => {
    const input = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Update File: .isomux/agents.json\n@@\n-old\n+new\n*** End Patch",
    });
    input.cwd = homedir();
    expect(evaluateCodexHookEnvelope(input)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("diagnoses a missing or invalid envelope cwd", () => {
    for (const cwd of [undefined, "", "relative/cwd"]) {
      const input = envelope("apply_patch", {
        command: "*** Begin Patch\n*** Add File: out.txt\n+x\n*** End Patch",
      });
      input.cwd = cwd;
      const output = evaluateCodexHookEnvelope(input);
      expect(output).toEqual({ systemMessage: MISSING_CWD_WARNING });
    }
  });

  it("warns about missing cwd on every Codex tool surface", () => {
    const input = envelope("future_tool", { value: "x" });
    input.cwd = undefined;
    expect(evaluateCodexHookEnvelope(input)).toEqual({
      systemMessage: MISSING_CWD_WARNING,
    });

    const denied = envelope("apply_patch", {
      command:
        "*** Begin Patch\n*** Update File: .isomux/agents.json\n@@\n-old\n+new\n*** End Patch",
    });
    denied.cwd = undefined;
    const deniedOutput = evaluateCodexHookEnvelope(denied);
    expect(deniedOutput).not.toHaveProperty("systemMessage");
    expect(JSON.stringify(deniedOutput)).toContain(MISSING_CWD_WARNING);
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
      '{"hook_event_name":"PreToolUse","cwd":"/tmp/probe","tool_name":"future_tool","tool_input":' +
      '{"nested":'.repeat(10_000) +
      "null" +
      "}".repeat(10_000) +
      "}";
    expect(handleCodexHookInput(deepInput)).toEqual({});
  });

  // apply_patch is checked as files, never as shell text: only control
  // headers at the start of a line name a path, a move touches both sides,
  // and an envelope with no complete, supported path set denies as
  // unverifiable (not a checker fault, which would allow). A tool the hook
  // does not name is uncovered, whatever its input looks like.
  it("decides apply_patch by every path it names, and only by those", () => {
    const protectedPath = join(STATE_ROOT, "bin/isomux-codex-safety-hook");
    const patch = (...lines: string[]) =>
      ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
    const rows: Array<[string, unknown, "allow" | "deny"]> = [
      [
        "every header kind, all safe",
        patch(
          "*** Add File: /tmp/added.txt",
          "+x",
          "*** Delete File: /tmp/deleted.txt",
          "*** Update File: /tmp/updated.txt",
          "@@",
          "-old",
          "+new",
          "*** End of File",
          "*** Update File: /tmp/moved-from.txt",
          "*** Move to: /tmp/moved-to.txt",
        ),
        "allow",
      ],
      [
        "content line that looks like a header",
        patch(
          "*** Add File: /tmp/notes.txt",
          `+*** Update File: ${protectedPath}`,
        ),
        "allow",
      ],
      [
        "shell text as file content",
        patch("*** Add File: /tmp/notes.txt", "+rm -rf / is prose in the file"),
        "allow",
      ],
      [
        "protected delete after a safe add",
        patch(
          "*** Add File: /tmp/a.txt",
          "+x",
          `*** Delete File: ${protectedPath}`,
        ),
        "deny",
      ],
      [
        "move from safe to protected",
        patch(
          "*** Update File: /tmp/source.txt",
          `*** Move to: ${protectedPath}`,
        ),
        "deny",
      ],
      [
        "move from protected to safe",
        patch(
          `*** Update File: ${protectedPath}`,
          "*** Move to: /tmp/dest.txt",
        ),
        "deny",
      ],
      ["no paths", patch(), "deny"],
      ["not a string", 7, "deny"],
      ["no envelope", "*** Add File: /tmp/a.txt\n+x", "deny"],
      ["unknown header", patch("*** Copy File: /tmp/a.txt"), "deny"],
      ["wrong-case header", patch("*** update File: /tmp/a.txt"), "deny"],
    ];
    for (const [name, command, decision] of rows) {
      const output = evaluateCodexHookEnvelope(
        envelope("apply_patch", { command }),
      );
      if (decision === "allow") expect(output, name).toEqual({});
      else {
        expect(output, name).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
        expect(JSON.stringify(output), name).not.toContain(SAFETY_WARNING);
      }
    }
    expect(
      evaluateCodexHookEnvelope(
        envelope("future_tool", { command: "rm -rf /", path: STATE_ROOT }),
      ),
    ).toEqual({});
  });
});
