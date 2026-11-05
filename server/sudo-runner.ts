// Runs a sudo request's command as root (task 43a28eed). The only file that
// starts sudo.
//
// The password goes to sudo only through the spawn's stdin, which Bun makes a
// socketpair: an agent of the same account can open a pipe or a FIFO through
// /proc/<pid>/fd and race sudo for it, but not a socket (ENXIO). Never a FIFO,
// a temp file, pipe(2), the environment or argv.

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { createOutputTail, superviseProcess } from "./command-supervisor.ts";

export const SUDO_PATH = "/usr/bin/sudo";
export const SUDO_OUTPUT_TAIL = 4000;
export const SUDO_TIMEOUT_MS = 30 * 60_000;
export const SUDO_KILL_GRACE_MS = 10_000;

// What the server's account may do with sudo: "unavailable" when sudo is
// missing or the account may not use it, "no_password_needed" when sudo runs
// without one (the request adds nothing then).
export type SudoProbe = "available" | "unavailable" | "no_password_needed";

export interface SudoRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  // The last SUDO_OUTPUT_TAIL characters of stdout and stderr, without the
  // runner's markers.
  output: string;
}

export type SudoStart =
  // sudo exited before the command started; `reason` is sudo's own line.
  | { kind: "auth_failed"; reason: string }
  | { kind: "started"; done: Promise<SudoRunResult> };

export interface SudoStartOptions {
  command: string;
  cwd: string;
  password: string;
  home: string;
  // Tests pass a stand-in sudo.
  sudoPath?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

// The fixed environment of every sudo spawn: nothing from the server's or the
// agent's. LC_ALL=C keeps sudo's lines in English for the probe.
function sudoEnv(home: string): Record<string, string> {
  return { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", HOME: home };
}

// Runs a probe command to its end: its exit code and its output, or null
// when it cannot start.
async function probeRun(
  argv: string[],
): Promise<{ code: number; output: string } | null> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: sudoEnv(homedir()),
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // gone already
      }
    }, PROBE_TIMEOUT_MS);
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, output: out + err };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

const PROBE_TIMEOUT_MS = 15_000;

// The lines of `sudo -n -l` that say the account may use sudo once it gives
// its password (deploy/harden-ssh.sh check_sudo).
const PASSWORD_REQUIRED = /a password is required/;

export async function probeSudo(opts?: {
  sudoPath?: string;
}): Promise<SudoProbe> {
  const sudo = opts?.sudoPath ?? SUDO_PATH;
  if (!existsSync(sudo)) return "unavailable";
  // -k: a cached timestamp must not pass for "no password needed".
  const free = await probeRun([sudo, "-n", "-k", "true"]);
  if (free === null) return "unavailable";
  if (free.code === 0) return "no_password_needed";
  const list = await probeRun([sudo, "-n", "-l"]);
  if (list === null) return "unavailable";
  if (list.code === 0 || PASSWORD_REQUIRED.test(list.output))
    return "available";
  return "unavailable";
}

// The command sudo runs: it writes the start marker ($1) to stderr, so the
// runner knows that sudo accepted the password, then runs the command ($2).
// The command is an argument, never part of this script.
const WRAPPER = `printf %s "$1" >&2; exec /bin/sh -c "$2"`;

// Before the start marker, stderr holds only sudo's own lines.
const PRE_START_MAX = 64 * 1024;

const nonce = () => randomBytes(12).toString("hex");

export async function startSudo(opts: SudoStartOptions): Promise<SudoStart> {
  const prompt = nonce();
  const marker = nonce();
  const timeoutMs = opts.timeoutMs ?? SUDO_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? SUDO_KILL_GRACE_MS;
  if (!statSync(opts.cwd).isDirectory())
    throw new Error("the cwd is not a directory");
  const t0 = Date.now();
  // stdin "pipe" is a socketpair in Bun: see the top of this file.
  const proc = Bun.spawn(
    [
      opts.sudoPath ?? SUDO_PATH,
      "-k",
      "-S",
      "-p",
      prompt,
      "--",
      "/bin/sh",
      "-c",
      WRAPPER,
      "sh",
      marker,
      opts.command,
    ],
    {
      cwd: opts.cwd,
      env: sudoEnv(opts.home),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await proc.stdin.write(`${opts.password}\n`);
    await proc.stdin.end();
  } catch {
    // sudo exited before it read: the exit below tells why.
  }

  let started = false;
  let pre = "";
  const strip = (text: string) =>
    text.replaceAll(prompt, "").replaceAll(marker, "");
  const tail = createOutputTail(SUDO_OUTPUT_TAIL, {
    slack: marker.length,
    normalize: strip,
  });
  let onStart: () => void = () => {};
  const startSeen = new Promise<void>((resolve) => (onStart = resolve));

  // stdout is stream 0, stderr stream 1.
  const onText = (text: string, stream: number) => {
    if (stream === 0 || started) {
      tail.append(text);
      return;
    }
    pre += text;
    const at = pre.indexOf(marker);
    if (at >= 0) {
      started = true;
      tail.append(pre.slice(at + marker.length));
      pre = "";
      onStart();
    } else if (pre.length > PRE_START_MAX) {
      pre = pre.slice(-PRE_START_MAX);
    }
  };

  const supervision = superviseProcess(
    {
      streams: [proc.stdout, proc.stderr],
      exited: proc.exited,
      terminate: (signal) => proc.kill(signal),
    },
    { timeoutMs, killGraceMs, onText },
  );
  const ended = supervision.ended;

  const first = await Promise.race([
    startSeen.then(() => "started" as const),
    ended.then(() => (started ? ("started" as const) : ("ended" as const))),
  ]);
  if (first === "ended") {
    const lines = pre
      .replaceAll(prompt, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return { kind: "auth_failed", reason: lines.at(-1) ?? "" };
  }
  const done = ended.then(
    (): SudoRunResult => ({
      exitCode: proc.exitCode,
      signal: proc.signalCode ?? null,
      timedOut: supervision.timedOut(),
      durationMs: Date.now() - t0,
      output: tail.value(),
    }),
  );
  return { kind: "started", done };
}
