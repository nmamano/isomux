// Runs one folder file tool call (server/folder-files.ts) in a child process
// in agent space: the agent runner's folder-files entry in split mode, a
// child of the server otherwise. The child is killed after `timeoutMs`, and
// the call then answers with an error.

import { join } from "path";
import { getAgentHost } from "./agent-host.ts";
import {
  FOLDER_FILES_TIMEOUT_MS,
  type FolderFilesRequest,
  type FolderFilesResult,
} from "./folder-files.ts";

const ENTRY = join(
  import.meta.dir,
  "agent-runner",
  "entries",
  "folder-files.ts",
);

function isResult(value: unknown): value is FolderFilesResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.ok === true && typeof v.text === "string") ||
    (v.ok === false && typeof v.error === "string")
  );
}

function failed(why: string): FolderFilesResult {
  return {
    ok: false,
    error: `Isomux could not run this file tool (${why}). Try again.`,
  };
}

function tooLong(timeoutMs: number): FolderFilesResult {
  return {
    ok: false,
    error: `This call took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Search a smaller folder, or use a simpler pattern.`,
  };
}

// The entry as a child of this process, killed at the deadline.
async function runLocal(
  req: FolderFilesRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const child = Bun.spawn([process.execPath, ENTRY], {
    stdin: new Blob([JSON.stringify(req)]),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => child.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`);
    return JSON.parse(stdout);
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

export async function runFolderFiles(
  req: FolderFilesRequest,
  timeoutMs: number = FOLDER_FILES_TIMEOUT_MS,
): Promise<FolderFilesResult> {
  const host = getAgentHost();
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve("late");
    }, timeoutMs);
  });
  const run =
    host.kind === "runner"
      ? host.runEntry("folder-files", req, timeoutMs)
      : runLocal(req, deadline.signal);
  try {
    const answer = await Promise.race([run, late]);
    if (answer === "late") {
      run.catch(() => {});
      return tooLong(timeoutMs);
    }
    return isResult(answer) ? answer : failed("an answer it cannot read");
  } catch (error) {
    // Past the deadline the kill is the cause.
    return deadline.signal.aborted
      ? tooLong(timeoutMs)
      : failed((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
