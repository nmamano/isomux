// Runs an ask's command for the member who tapped Run (task c3b91695): what
// Copy to terminal and Enter do in the terminal panel, in one tap. The
// command runs with the panel's environment (terminalEnv in terminal.ts) and
// the agent's cwd, as the agent host user, with no input and no terminal.
// The output is masked for secrets before its tail is cut.

import { Readable } from "node:stream";

import {
  getAgentHost,
  type AgentChild,
  type SpawnChildOptions,
} from "./agent-host.ts";
import { createOutputTail, superviseProcess } from "./command-supervisor.ts";
import { createRedactingTextStream } from "./log-redaction.ts";
import type { AskCommandRun, AskEntry } from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";

export const ASK_RUN_OUTPUT_TAIL = 4000;
export const ASK_RUN_TIMEOUT_MS = 10 * 60_000;
export const ASK_RUN_KILL_GRACE_MS = 10_000;

export interface AskRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  // The last ASK_RUN_OUTPUT_TAIL characters of stdout and stderr, in the
  // order they came, escape codes removed and secrets masked.
  output: string;
}

export interface AskRunOptions {
  command: string;
  cwd: string;
  // The whole environment of the run.
  env: Record<string, string | undefined>;
  // The shell that runs the command with -c: the terminal panel's.
  shell: string;
  // Defaults to the office's agent host (spawnChild). Tests pass a stand-in.
  spawn?: (argv: string[], options: SpawnChildOptions) => AgentChild;
  timeoutMs?: number;
  killGraceMs?: number;
}

// An escape sequence a chunk can end inside: the text from its ESC is held
// for the next chunk, so the strip sees it whole.
const OPEN_ESCAPE_MAX = 64;
const WHOLE_ESCAPE =
  // eslint-disable-next-line no-control-regex -- escape codes are the point
  /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/;

function openEscapeStart(text: string): number {
  const at = text.lastIndexOf("\u001b");
  if (at < 0 || text.length - at > OPEN_ESCAPE_MAX) return -1;
  return WHOLE_ESCAPE.test(text.slice(at)) ? -1 : at;
}

// Rejects when the command cannot start; `done` resolves when it ends.
export async function startAskRun(
  opts: AskRunOptions,
): Promise<{ done: Promise<AskRunResult> }> {
  const spawn =
    opts.spawn ??
    ((argv: string[], options: SpawnChildOptions) =>
      getAgentHost().spawnChild(argv, options));
  const t0 = Date.now();
  const child = spawn([opts.shell, "-c", opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stderr: "pipe",
  });
  // The exit, kept from the first moment: a short command can exit before
  // the start is seen.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: Error) => reject(err));
  });
  // No input: a command that reads stdin gets its end at once.
  try {
    child.stdin.end();
  } catch {
    // the command closed it already
  }

  // Escape codes are stripped and secrets masked over the stream, before the
  // tail is cut, so no secret is half kept at the tail's head.
  const redactor = createRedactingTextStream();
  const tail = createOutputTail(ASK_RUN_OUTPUT_TAIL);
  let open = "";
  const onText = (text: string) => {
    let chunk = open + text;
    const at = openEscapeStart(chunk);
    open = at < 0 ? "" : chunk.slice(at);
    if (at >= 0) chunk = chunk.slice(0, at);
    tail.append(redactor.push(Bun.stripANSI(chunk).replace(/\r\n/g, "\n")));
  };
  const streams = [child.stdout, child.stderr]
    .filter((s): s is NonNullable<typeof s> => s !== null)
    // node:stream/web's ReadableStream is the global one at run time.
    .map((s) => Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>);
  const supervision = superviseProcess(
    {
      streams,
      exited,
      terminate: (signal) => child.signalGroup(signal),
    },
    {
      timeoutMs: opts.timeoutMs ?? ASK_RUN_TIMEOUT_MS,
      killGraceMs: opts.killGraceMs ?? ASK_RUN_KILL_GRACE_MS,
      onText,
    },
  );
  const done = supervision.ended.then((): AskRunResult => {
    tail.append(redactor.push(Bun.stripANSI(open)) + redactor.end());
    return {
      exitCode: child.exitCode,
      signal: child.signalCode ?? null,
      timedOut: supervision.timedOut(),
      durationMs: Date.now() - t0,
      output: tail.value(),
    };
  });
  return { done };
}

// What the agent reads about a run, in English as every office notice.
function took(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.round(seconds / 60)} min`;
}

function howItEnded(run: AskCommandRun): string {
  const after = took(run.durationMs ?? 0);
  if (run.timedOut)
    return `It was stopped at the ${ASK_RUN_TIMEOUT_MS / 60_000}-minute limit (${run.signal ?? "SIGTERM"}) after ${after}.`;
  if (run.exitCode !== null && run.exitCode !== undefined)
    return `It ended with exit code ${run.exitCode} after ${after}.`;
  return `It was ended by ${run.signal ?? "a signal"} after ${after}.`;
}

function outputOf(run: AskCommandRun): string {
  return run.output
    ? `The last ${ASK_RUN_OUTPUT_TAIL} characters of its stdout and stderr:\n${run.output}`
    : "It wrote no output.";
}

// A run that did not close the ask: it failed, another command of the ask
// has not succeeded yet, or the ask closed or dropped the command meanwhile.
export function askRunNotice(
  askId: string,
  member: string,
  run: AskCommandRun,
): string {
  return `[Isomux: ${member} ran a command of your ask ${askId}: ${run.command}\n${howItEnded(run)} ${outputOf(run)}]`;
}

// A run the server's restart ended.
export function askRunLostNotice(
  askId: string,
  member: string,
  run: AskCommandRun,
): string {
  return `[Isomux: ${member} ran a command of your ask ${askId}: ${run.command}\nThe server restarted during the run, so its result is unknown. The ask stays open.]`;
}

// The ask's answer when every command succeeded: each command, how it ended
// and its output.
export function askRunReply(entry: AskEntry): string {
  return (entry.commands ?? [])
    .map((command) => entry.runs?.find((r) => r.command === command))
    .filter((run): run is AskCommandRun => run !== undefined)
    .map(
      (run) =>
        `Ran \`${run.command}\` from the ask card. ${howItEnded(run)} ${outputOf(run)}`,
    )
    .join("\n\n");
}

// The line in the agent's chat that records a run's end, beside its notice.
export function askRunLine(run: AskCommandRun): LogMessage {
  const { command } = run;
  if (run.state === "lost")
    return msg("systemEntries.askRun.lost", { command });
  if (run.timedOut) return msg("systemEntries.askRun.timedOut", { command });
  if (run.exitCode !== null && run.exitCode !== undefined)
    return msg("systemEntries.askRun.exited", {
      code: String(run.exitCode),
      command,
    });
  return msg("systemEntries.askRun.killed", {
    signal: run.signal ?? "a signal",
    command,
  });
}
