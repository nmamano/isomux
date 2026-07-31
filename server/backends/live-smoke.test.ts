// T3 live smoke - the ONLY tests in the suite that make real provider calls.
//
// OFF by default: gated behind `describe.skipIf(!LIVE)`, so plain `bun test`
// (CI, pre-commit) skips the whole file and stays zero-LLM. Turn it on with the
// `test:live` script (sets ISOMUX_TEST_LIVE=1). These run as the host user's
// real environment and cost real tokens - keep them few, cheap, serial, and
// invariant-only (never assert exact model text).
//
// Invariants asserted (per backend): a session starts, a prompt predictably
// triggers a harmless tool, at least one tool_call is observed, and the turn
// completes. Resume / topic-quality checks are deliberately deferred.
//
// Auth prerequisites (the suite runs under a temp ISOMUX_HOME via the test
// preload, so provider auth must come from the ambient env, not ~/.isomux):
//   - Claude: a logged-in `claude` (~/.claude/.credentials.json) or
//     ANTHROPIC_API_KEY in the shell env.
//   - Codex: OPENAI_API_KEY in the shell env (env-var auth bypasses the codex
//     auth.json, which would otherwise resolve under the temp home).
// Run, e.g.:
//   OPENAI_API_KEY=sk-... ISOMUX_TEST_LIVE=1 bun test server/backends/live-smoke.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { LIVE } from "../test-support/live-gate.ts";
import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import type { Backend, BackendSession, NormalizedEvent } from "./types.ts";

// Per-provider config. Cheapest model + an auto-run policy so a harmless command
// executes without parking on an approval prompt (we also approve defensively
// below, belt-and-suspenders).
interface ProviderConfig {
  name: string;
  backend: Backend;
  modelFamily: string;
  permissionMode: string;
  sandbox?: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: "claude",
    backend: claudeBackend,
    modelFamily: "haiku",
    permissionMode: "bypassPermissions",
  },
  {
    name: "codex",
    backend: codexBackend,
    modelFamily: "gpt-5.4-mini",
    permissionMode: "never",
    sandbox: "read-only",
  },
];

// A prompt that predictably triggers exactly one harmless shell tool call.
const TOOL_PROMPT =
  "Use your shell tool to run exactly this command: echo isomux-live-smoke. " +
  "Do not run any other commands. After it succeeds, reply with the single word done.";

const PER_EVENT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function nextEvent(
  it: AsyncIterator<NormalizedEvent>,
  provider: string,
): Promise<NormalizedEvent | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `[${provider}] live smoke: no event for 60s (stalled turn)`,
          ),
        ),
      PER_EVENT_TIMEOUT_MS,
    );
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    return r.done ? null : r.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Drive one real turn to completion: wait for system_init, send the prompt,
// then drain (approving any tool the model asks for) until turn_completed.
async function runHarmlessToolTurn(cfg: ProviderConfig): Promise<{
  toolCalls: string[];
  status: string;
}> {
  const cwd = mkdtempSync(join(tmpdir(), `isomux-live-${cfg.name}-`));
  tempDirs.push(cwd);
  const session: BackendSession = cfg.backend.createSession({
    agentId: `live-smoke-${cfg.name}`,
    cwd,
    systemPrompt:
      "You are a terse test agent. Do exactly what is asked and nothing more.",
    modelFamily: cfg.modelFamily,
    effort: "",
    permissionMode: cfg.permissionMode,
    sandbox: cfg.sandbox,
    env: process.env,
  });

  const toolCalls: string[] = [];
  let sent = false;
  try {
    const it = session.stream()[Symbol.asyncIterator]();
    for (;;) {
      const ev = await nextEvent(it, cfg.name);
      if (!ev)
        throw new Error(`[${cfg.name}] stream ended before turn_completed`);
      switch (ev.kind) {
        case "system_init":
          if (!sent) {
            await session.send(TOOL_PROMPT);
            sent = true;
          }
          break;
        case "approval_request":
          await session.approve(ev.approvalId, { kind: "allow_once" });
          break;
        case "tool_call":
          toolCalls.push(ev.name);
          break;
        case "turn_completed":
          return { toolCalls, status: ev.status };
        default:
          break; // assistant_text / thinking / usage_update / etc.
      }
    }
  } finally {
    session.close();
  }
}

for (const cfg of PROVIDERS) {
  describe.skipIf(!LIVE)(`live smoke - ${cfg.name}`, () => {
    it(
      "starts a session, runs a harmless tool, and completes the turn",
      async () => {
        const { toolCalls, status } = await runHarmlessToolTurn(cfg);
        // Invariant: the model actually invoked a tool.
        expect(toolCalls.length).toBeGreaterThan(0);
        // Invariant: the turn reached a clean completion (not failed/interrupted).
        expect(status).toBe("completed");
      },
      TEST_TIMEOUT_MS,
    );
  });
}
