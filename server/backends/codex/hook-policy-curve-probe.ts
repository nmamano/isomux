// Slice-3 measurement only. Compares the live provider-neutral policy with a
// scratch mutant whose ambiguous rm flag fragments are mechanically replaced.
// The mutant never touches the working tree or production policy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateProposedAction,
  type PolicyDecision,
} from "../../safety-policy.ts";

type Evaluator = typeof evaluateProposedAction;

const AMBIGUOUS_RF = "[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*";
const AMBIGUOUS_FR = "[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*";
const LINEAR_FLAGS = "(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*f)[a-zA-Z]+";
const EXPECTED_REPLACEMENTS = 14;

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function scratchLinearEvaluator(root: string): Promise<Evaluator> {
  const sourcePath = join(import.meta.dir, "../../safety-policy.ts");
  const source = readFileSync(sourcePath, "utf8");
  const replacementCount =
    count(source, AMBIGUOUS_RF) + count(source, AMBIGUOUS_FR);
  if (replacementCount !== EXPECTED_REPLACEMENTS) {
    throw new Error(
      `expected ${EXPECTED_REPLACEMENTS} ambiguous fragments, found ${replacementCount}`,
    );
  }
  const configUrl = new URL("../../config.ts", import.meta.url).href;
  const mutant = source
    .replace('from "./config.ts"', `from ${JSON.stringify(configUrl)}`)
    .replaceAll(AMBIGUOUS_RF, LINEAR_FLAGS)
    .replaceAll(AMBIGUOUS_FR, LINEAR_FLAGS);
  const path = join(root, "safety-policy-linear-mutant.ts");
  writeFileSync(path, mutant);
  const imported = (await import(path)) as {
    evaluateProposedAction: Evaluator;
  };
  return imported.evaluateProposedAction;
}

function evaluate(evaluator: Evaluator, command: string) {
  const started = performance.now();
  const decision = evaluator({ kind: "shell", command });
  return {
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    decision: decision.decision,
  };
}

const capCorpus = [
  { name: "ordinary allow", command: "git status --short" },
  { name: "slow rm flags 604 bytes", command: "rm -" + "rf".repeat(300) },
  { name: "slow rm flags 1204 bytes", command: "rm -" + "rf".repeat(600) },
  {
    name: "long destructive rm",
    command: `echo ${"x".repeat(600)}; rm -rf /home/probe`,
  },
  {
    name: "long destructive git",
    command: `echo ${"x".repeat(600)}; git reset --hard HEAD`,
  },
  {
    name: "long sensitive read",
    command: `echo ${"x".repeat(600)}; cat .env`,
  },
  {
    name: "long protected write",
    command: `echo ${"x".repeat(600)}; tee ~/.isomux/agents.json`,
  },
  { name: "long allow control", command: `printf ${"x".repeat(1200)}` },
] as const;

function cappedDecision(command: string, capBytes: number): PolicyDecision {
  if (Buffer.byteLength(command) > capBytes) {
    return { decision: "allow" };
  }
  return evaluateProposedAction({ kind: "shell", command });
}

export async function runPolicyCurveProbe() {
  const root = mkdtempSync(join(tmpdir(), "isomux-policy-curve-"));
  try {
    const linear = await scratchLinearEvaluator(root);
    const curve = [100, 200, 400, 800, 1600].map((flagBytes) => {
      const command = "rm -" + "rf".repeat(flagBytes / 2);
      return {
        commandBytes: Buffer.byteLength(command),
        current: evaluate(evaluateProposedAction, command),
        ambiguityRemoved: evaluate(linear, command),
      };
    });
    const capCost = [512, 1024].map((capBytes) => {
      const readings = capCorpus.map(({ name, command }) => {
        const uncapped = evaluateProposedAction({ kind: "shell", command });
        const capped = cappedDecision(command, capBytes);
        return {
          name,
          commandBytes: Buffer.byteLength(command),
          uncapped: uncapped.decision,
          capped: capped.decision,
          flipsDenyToAllow:
            uncapped.decision === "deny" && capped.decision === "allow",
        };
      });
      return {
        capBytes,
        denyToAllowCount: readings.filter((reading) => reading.flipsDenyToAllow)
          .length,
        readings,
      };
    });
    return {
      measuredAt: new Date().toISOString(),
      controls: {
        allow: evaluate(evaluateProposedAction, "git status --short"),
        deny: evaluate(evaluateProposedAction, "rm -rf /"),
      },
      alternativeMutation: {
        replacements: EXPECTED_REPLACEMENTS,
        from: [AMBIGUOUS_RF, AMBIGUOUS_FR],
        to: LINEAR_FLAGS,
        productionTreeChanged: false,
      },
      curve,
      capCost,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runPolicyCurveProbe(), null, 2));
}
