// T3 live smoke - the ONLY tests in the suite that make real provider calls.
//
// OFF by default: gated behind `describe.skipIf(!LIVE)`, so plain `bun test`
// (CI, pre-commit) skips the whole file and stays zero-LLM. Turn it on with the
// `test:live` script (sets ISOMUX_TEST_LIVE=1). These run as the host user's
// real environment and cost real tokens - keep them few, cheap, serial, and
// invariant-only (never assert exact model text).
//
// Invariants asserted (per backend), through the isomux Backend interface:
//   - a session starts, a prompt triggers a harmless tool, and the turn
//     completes;
//   - session history lists the user turns in order, resume recalls a fact
//     planted before it, a whole-history fork recalls it too, and a fork
//     before a message drops that message (the edit-message path);
//   - a resume reads the system prompt it is launched with, not the one the
//     session started with (edited instructions reach a restarted agent).
// Topic-quality checks are deliberately deferred.
//
// Auth prerequisites (the suite runs under a temp ISOMUX_HOME via the test
// preload, so provider auth must come from the ambient env, not ~/.isomux):
//   - Claude: a logged-in `claude` (~/.claude/.credentials.json) or
//     ANTHROPIC_API_KEY in the shell env.
//   - Codex: OPENAI_API_KEY in the shell env (the app-server client signs in
//     with it; a codex auth.json would resolve under the temp home).
// Run, e.g.:
//   OPENAI_API_KEY=sk-... ISOMUX_TEST_LIVE=1 bun test server/backends/live-smoke.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeProjectDir, findCodexRolloutPath } from "../cwd-utils.ts";
import { renderLogText, type LogText } from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { LIVE, liveEngineEnv } from "../test-support/live-gate.ts";

import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import { prepareCodexSafetyHookArtifact } from "./codex/safety-hook-install.ts";
import type {
  Backend,
  BackendSession,
  NormalizedEvent,
  NormalizedMessage,
  SessionAccessOptions,
} from "./types.ts";

// A response_item payload in a Codex rollout, as far as the checks read it.
type Item = { role?: string; content?: { text?: string }[] };

// The system prompt of each request the Claude CLI sent, in transcript order.
// The CLI writes an api-request entry per request, which names the
// api-request-shape entry (system blocks and tools) it was sent with.
type TranscriptEntry = {
  type?: string;
  shapeHash?: string;
  shape?: { system?: unknown };
};
function claudeRequestSystems(path: string): string[] {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranscriptEntry);
  const shapes = new Map<string | undefined, string>();
  for (const entry of entries) {
    if (entry.type === "api-request-shape") {
      shapes.set(entry.shapeHash, JSON.stringify(entry.shape?.system ?? null));
    }
  }
  return entries
    .filter((entry) => entry.type === "api-request")
    .map((entry) => {
      const system = shapes.get(entry.shapeHash);
      if (system === undefined) {
        throw new Error(`no shape ${entry.shapeHash} in ${path}`);
      }
      return system;
    });
}

// Isomux's own words arrive as messages (task c37a7365); the checks read the
// English a reader would see.
const english = (text: LogText): string =>
  renderLogText(translatorFor("en"), text);

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
    // Cheapest model Codex 0.160 lists: $0.10 in / $0.50 out per 1M tokens
    // (developers.openai.com/api/docs/pricing, 2026-10-02).
    modelFamily: "gpt-6-luna",
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

// Each test cwd, and the Claude project dir the SDK writes for it. The exact
// path only: never scan ~/.claude/projects, it holds every session on the box.
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

function newCwd(cfg: ProviderConfig): string {
  const cwd = mkdtempSync(join(tmpdir(), `isomux-live-${cfg.name}-`));
  tempDirs.push(cwd);
  if (cfg.name === "claude") tempDirs.push(claudeProjectDir(cwd, ENGINE_ENV));
  return cwd;
}

// The box's sign-in, which the test preload keeps aside.
const ENGINE_ENV = liveEngineEnv();

const TERSE_PROMPT =
  "You are a terse test agent. Do exactly what is asked and nothing more.";

function openSession(
  cfg: ProviderConfig,
  cwd: string,
  resumeId?: string,
  systemPrompt = TERSE_PROMPT,
): BackendSession {
  const opts = {
    agentId: `live-smoke-${cfg.name}`,
    cwd,
    systemPrompt,
    modelFamily: cfg.modelFamily,
    effort: "",
    permissionMode: cfg.permissionMode,
    sandbox: cfg.sandbox,
    env: ENGINE_ENV,
  };
  return resumeId
    ? cfg.backend.resumeSession(resumeId, opts)
    : cfg.backend.createSession(opts);
}

function accessFor(cfg: ProviderConfig, cwd: string): SessionAccessOptions {
  return {
    cwd,
    env: ENGINE_ENV,
    modelFamily: cfg.modelFamily,
    permissionMode: cfg.permissionMode,
  };
}

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

interface TurnResult {
  text: string;
  toolCalls: string[];
  status: string;
  // What the backend reported besides the reply (errors, notices), so a
  // failed assertion names the cause, for example missing auth.
  said: string[];
}

function newTurn(): TurnResult {
  return { text: "", toolCalls: [], status: "", said: [] };
}

function told(cfg: ProviderConfig, turns: TurnResult[]): string {
  const said = turns.flatMap((t) => t.said);
  return `[${cfg.name}] backend said: ${said.join(" | ") || "nothing"}`;
}

// Drive real turns on one session, then close it: send the first prompt at
// once (Claude reports system_init only after the first send; Codex's send
// waits for its own bootstrap), each next prompt after the previous
// turn_completed, and approve any tool the model asks for. Returns the
// session id system_init reported.
async function runTurns(
  cfg: ProviderConfig,
  session: BackendSession,
  prompts: string[],
): Promise<{ sessionId: string; turns: TurnResult[] }> {
  let sessionId = "";
  const turns: TurnResult[] = [];
  let current = newTurn();
  let sent = 0;
  const it = session.stream()[Symbol.asyncIterator]();
  try {
    await session.send(prompts[0]);
    sent = 1;
    for (;;) {
      const ev = await nextEvent(it, cfg.name);
      if (!ev)
        throw new Error(
          `stream ended before turn_completed. ${told(cfg, [current])}`,
        );
      switch (ev.kind) {
        case "system_init":
          if (ev.sessionId) sessionId = ev.sessionId;
          break;
        case "approval_request":
          await session.approve(ev.approvalId, { kind: "allow_once" });
          break;
        case "assistant_text":
          current.text += ev.text;
          break;
        case "tool_call":
          current.toolCalls.push(ev.name);
          break;
        case "error":
          current.said.push(english(ev.message));
          break;
        case "system_text":
          current.said.push(english(ev.text));
          break;
        case "turn_completed":
          current.status = ev.status;
          if (ev.error) current.said.push(english(ev.error));
          turns.push(current);
          current = newTurn();
          if (sent === prompts.length) return { sessionId, turns };
          await session.send(prompts[sent]);
          sent += 1;
          break;
        default:
          break; // thinking / usage_update / etc.
      }
    }
  } finally {
    session.close();
    // Drain to the stream's end: Claude's process writes session metadata as
    // it exits, and afterAll would otherwise delete the project dir first.
    // A stalled drain must not replace the error from the try block.
    try {
      while (await nextEvent(it, cfg.name)) {
        // discard
      }
    } catch {
      // ignore
    }
  }
}

function texts(messages: NormalizedMessage[], role?: string): string[] {
  return messages
    .filter((m) => role === undefined || m.role === role)
    .map((m) => m.text.toLowerCase());
}

// A fresh state root has no golden copy of the Codex safety hook, and a
// process that did not prepare one refuses to start Codex.
async function prepare(cfg: ProviderConfig): Promise<void> {
  if (cfg.backend === codexBackend) await prepareCodexSafetyHookArtifact();
}

for (const cfg of PROVIDERS) {
  describe.skipIf(!LIVE)(`live smoke - ${cfg.name}`, () => {
    it(
      "starts a session, runs a harmless tool, and completes the turn",
      async () => {
        await prepare(cfg);
        const { turns } = await runTurns(cfg, openSession(cfg, newCwd(cfg)), [
          TOOL_PROMPT,
        ]);
        // Invariant: the model actually invoked a tool.
        expect(turns[0].toolCalls.length, told(cfg, turns)).toBeGreaterThan(0);
        // Invariant: the turn reached a clean completion (not failed/interrupted).
        expect(turns[0].status, told(cfg, turns)).toBe("completed");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "plants a fact, reads history, resumes, and forks",
      async () => {
        await prepare(cfg);
        const cwd = newCwd(cfg);
        const access = accessFor(cfg, cwd);
        // Random hex suffixes: a reply holding one can only come from the
        // session's own history. The recall prompt names the prefix, so the
        // model cannot answer with the second turn's marker instead.
        const codeWord = `kestrel${randomBytes(4).toString("hex")}`;
        const secondMarker = `heron${randomBytes(4).toString("hex")}`;
        const recall =
          "What was the code word that starts with kestrel? Reply with only the word.";

        // 1-2. Plant the fact, then a second user turn to fork in front of.
        const parent = await runTurns(cfg, openSession(cfg, cwd), [
          `Remember the code word ${codeWord}. Reply with only OK.`,
          `Note the tag ${secondMarker}. Reply with only OK.`,
        ]);
        expect(parent.sessionId, told(cfg, parent.turns)).not.toBe("");
        expect(
          parent.turns.map((t) => t.status),
          told(cfg, parent.turns),
        ).toEqual(["completed", "completed"]);

        // 3. History: both user turns in order, a reply, distinct uuids.
        const history = await cfg.backend.getSessionMessages(
          parent.sessionId,
          cwd,
          access,
        );
        const userTexts = texts(history, "user");
        expect(userTexts).toHaveLength(2);
        expect(userTexts[0]).toContain(codeWord);
        expect(userTexts[1]).toContain(secondMarker);
        expect(texts(history, "assistant").length).toBeGreaterThan(0);
        const uuids = history.map((m) => m.uuid);
        expect(uuids.every((u) => u.length > 0)).toBe(true);
        expect(new Set(uuids).size).toBe(uuids.length);
        const [firstUser, secondUser] = history.filter(
          (m) => m.role === "user",
        );

        // 4. Resume recalls the planted fact.
        const resumed = await runTurns(
          cfg,
          openSession(cfg, cwd, parent.sessionId),
          [recall],
        );
        expect(resumed.turns[0].status, told(cfg, resumed.turns)).toBe(
          "completed",
        );
        expect(resumed.turns[0].text.toLowerCase()).toContain(codeWord);

        // 5. A whole-history fork is a new linked session that recalls it too.
        const whole = await cfg.backend.forkSessionBeforeMessage(
          parent.sessionId,
          null,
          access,
        );
        if (whole.kind !== "fork") throw new Error(`got ${whole.kind}`);
        expect(whole.sessionId).not.toBe(parent.sessionId);
        expect(whole.forkedFromSessionId).toBe(parent.sessionId);
        const fromFork = await runTurns(
          cfg,
          openSession(cfg, cwd, whole.sessionId),
          [recall],
        );
        expect(fromFork.turns[0].status, told(cfg, fromFork.turns)).toBe(
          "completed",
        );
        expect(fromFork.turns[0].text.toLowerCase()).toContain(codeWord);

        // 6. Fork before the 2nd user message (edit-message path): the fork
        // keeps the 1st and drops the 2nd and everything after it.
        const before = await cfg.backend.forkSessionBeforeMessage(
          parent.sessionId,
          secondUser.uuid,
          access,
        );
        if (before.kind !== "fork") throw new Error(`got ${before.kind}`);
        expect(before.sessionId).not.toBe(parent.sessionId);
        const kept = texts(
          await cfg.backend.getSessionMessages(before.sessionId, cwd, access),
        );
        expect(kept.some((t) => t.includes(codeWord))).toBe(true);
        expect(kept.some((t) => t.includes(secondMarker))).toBe(false);

        // 7. Fork before the 1st user message: Claude starts fresh; Codex
        // makes a linked fork with no user turn in it.
        const first = await cfg.backend.forkSessionBeforeMessage(
          parent.sessionId,
          firstUser.uuid,
          access,
        );
        if (cfg.name === "claude") {
          expect(first.kind).toBe("fresh");
        } else {
          if (first.kind !== "fork") throw new Error(`got ${first.kind}`);
          expect(first.sessionId).not.toBe(parent.sessionId);
          const empty = await cfg.backend.getSessionMessages(
            first.sessionId,
            cwd,
            access,
          );
          expect(texts(empty, "user")).toEqual([]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    // Task 70ecad52: the Claude SDK records a session's system prompt at its
    // first request and, by default, sends that record on every resume, so an
    // edited instruction never reached a resumed agent. Task d6550a09: Codex
    // writes developer instructions into the thread only at thread/start, so
    // the adapter injects a changed prompt after thread/resume. The new code
    // word can only come from the prompt the resume was launched with.
    // Claude is checked on the requests the CLI sent, not on the reply: with
    // the new prompt sent, Haiku still repeats its earlier answer from the
    // history in about 1 resume in 8 (task d2dc09c2).
    it(
      "a resume reads the system prompt it is launched with",
      async () => {
        await prepare(cfg);
        const cwd = newCwd(cfg);
        const oldWord = `plover${randomBytes(4).toString("hex")}`;
        const newWord = `curlew${randomBytes(4).toString("hex")}`;
        const promptWith = (word: string) =>
          `${TERSE_PROMPT} The current code word is ${word}. It is set only ` +
          "here, in your system prompt, and can change between turns. When " +
          "asked for the code word, reply with only the word this prompt " +
          "gives now.";
        const ask = "What is the code word? Reply with only the word.";

        // The first launch saw its prompt: under the SDK default this is the
        // prompt the session records.
        const first = await runTurns(
          cfg,
          openSession(cfg, cwd, undefined, promptWith(oldWord)),
          [ask],
        );
        expect(first.sessionId, told(cfg, first.turns)).not.toBe("");
        expect(first.turns[0].status, told(cfg, first.turns)).toBe("completed");
        expect(first.turns[0].text.toLowerCase()).toContain(oldWord);

        const transcript = join(
          claudeProjectDir(cwd, ENGINE_ENV),
          `${first.sessionId}.jsonl`,
        );
        const firstLaunch =
          cfg.name === "claude" ? claudeRequestSystems(transcript) : [];

        const resumed = await runTurns(
          cfg,
          openSession(cfg, cwd, first.sessionId, promptWith(newWord)),
          [ask],
        );
        expect(resumed.turns[0].status, told(cfg, resumed.turns)).toBe(
          "completed",
        );

        if (cfg.name === "claude") {
          // The transcript must show the first launch sending the old word,
          // or a CLI that stops writing request shapes would pass.
          expect(
            firstLaunch.some((system) => system.includes(oldWord)),
            "no first-launch request carries the old prompt",
          ).toBe(true);
          const resumeRequests = claudeRequestSystems(transcript).slice(
            firstLaunch.length,
          );
          expect(resumeRequests.length).toBeGreaterThan(0);
          expect(
            resumeRequests.filter((system) => system.includes(oldWord)),
          ).toHaveLength(0);
          expect(
            resumeRequests.some((system) => system.includes(newWord)),
            "no resume request carries the new prompt",
          ).toBe(true);
        } else {
          const reply = resumed.turns[0].text.toLowerCase();
          expect(reply).not.toContain(oldWord);
          expect(reply).toContain(newWord);
        }

        // Codex carries a changed prompt as one update in the thread's
        // rollout (task d6550a09). A second resume with the same prompt adds
        // none: an update the adapter cannot read back (a Codex rollout
        // format change) would add a prompt copy at every resume.
        if (cfg.name === "codex") {
          const again = await runTurns(
            cfg,
            openSession(cfg, cwd, first.sessionId, promptWith(newWord)),
            [ask],
          );
          expect(again.turns[0].status, told(cfg, again.turns)).toBe(
            "completed",
          );
          expect(again.turns[0].text.toLowerCase()).toContain(newWord);
          const path = findCodexRolloutPath(first.sessionId, ENGINE_ENV);
          expect(path).toBeTruthy();
          const updates = readFileSync(path!, "utf8")
            .split("\n")
            .filter((line) => line.includes('"response_item"'))
            .map((line) => JSON.parse(line) as { payload?: Item })
            .filter((entry) => entry.payload?.role === "developer")
            .flatMap((entry) => entry.payload?.content ?? [])
            .filter((part) => part.text?.includes(newWord));
          expect(updates).toHaveLength(1);
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
}
