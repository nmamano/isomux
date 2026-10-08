// Whether Codex's own sandbox (bubblewrap) can run in this office's container.
//
// Container platforms can block what bwrap needs: Docker's default AppArmor
// profile denies mount, and a seccomp profile without mount or pivot_root
// stops bwrap before the command starts. Codex then fails every command of a
// read-only or workspace-write agent, and only the model sees the error. In a
// container the container is the isolation boundary, so where a probe proves
// that the platform denies bwrap, Codex agents run with full access instead.
// Host installs are not probed: the installer makes bwrap work there.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentHost } from "../../agent-host.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import { resolveCodexLauncherPath, withIsomuxCodexHome } from "./native-bin.ts";

export type CodexSandboxProbeResult = "available" | "denied" | "unknown";

const FULL_ACCESS = "danger-full-access";
const PROBE_TIMEOUT_MS = 15_000;

// bwrap's messages when the kernel or a security module refuses a namespace or
// mount step (both the system and the Codex-bundled bwrap). Other bwrap
// errors, such as a failed execvp of Codex's helper, are not denials.
const BWRAP_DENIAL = [
  /^bwrap: (?:Failed to make \/ slave|Failed to mount tmpfs|pivot_root(?:\(\/newroot\))?|umount old root|Can't mount proc on [^:\n]+|Creating new namespace failed|setting up [ug]id map|loopback: Failed RTM_NEW(?:ADDR|LINK)): (?:Operation not permitted|Permission denied)$/m,
  /^bwrap: No permissions to create (?:a )?new namespace/m,
];

// Exit 0 proves the sandbox works. Only a bwrap denial proves it does not; any
// other failure (timeout, missing binary, bad config) leaves the agents'
// settings as they are.
export function classifyCodexSandboxProbe(
  exitCode: number | null,
  stderr: string,
): CodexSandboxProbeResult {
  if (exitCode === 0) return "available";
  if (exitCode !== null && BWRAP_DENIAL.some((re) => re.test(stderr)))
    return "denied";
  return "unknown";
}

// Runs `codex sandbox` the way an agent's Codex runs a command: the same
// launcher, agent host and identity. CODEX_HOME is a new directory for each
// probe, holding only an empty config.toml, so no earlier config can change
// the sandbox under test. It must not be under /tmp: Codex then skips the
// helper links the system bwrap execs.
export async function runCodexSandboxProbe(
  // Test seams: the command and the time limit.
  opts: { argv?: string[]; timeoutMs?: number } = {},
): Promise<{
  result: CodexSandboxProbeResult;
  detail: string;
}> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const host = getAgentHost();
  const codexHome = join(AGENT_ROOT, "codex-sandbox-probe", randomUUID());
  await host.fs.mkdir(codexHome, 0o700);
  try {
    await host.fs.writeText(join(codexHome, "config.toml"), "", {
      mode: 0o600,
      exclusive: true,
    });
    return await probeIn(codexHome, opts.argv, timeoutMs);
  } finally {
    // Only the directory made above; Codex writes its helper links into it.
    await host
      .run(["rm", "-rf", "--", codexHome], { output: "ignore" })
      .catch(() => {});
  }
}

async function probeIn(
  codexHome: string,
  argv: string[] | undefined,
  timeoutMs: number,
): Promise<{ result: CodexSandboxProbeResult; detail: string }> {
  const host = getAgentHost();
  const env = { ...withIsomuxCodexHome(undefined), CODEX_HOME: codexHome };
  const child = host.spawnChild(
    argv ?? [
      process.execPath,
      resolveCodexLauncherPath(),
      "sandbox",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      "/bin/true",
    ],
    { cwd: codexHome, env, stderr: "pipe" },
  );
  child.stdin.end();
  child.stdout.resume();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.signalGroup("SIGKILL");
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code: number | null) => resolve(code));
  }).finally(() => clearTimeout(timer));
  const result = timedOut
    ? "unknown"
    : classifyCodexSandboxProbe(exitCode, stderr);
  const detail = timedOut
    ? `timed out after ${timeoutMs} ms`
    : `exit ${exitCode}: ${stderr.trim()}`;
  return { result, detail };
}

let probe: Promise<CodexSandboxProbeResult> | null = null;

// Starts the probe once per process; only containers probe. Never rejects.
export function codexSandboxProbe(
  run: () => ReturnType<typeof runCodexSandboxProbe> = runCodexSandboxProbe,
): Promise<CodexSandboxProbeResult> {
  if (process.env.ISOMUX_APP_SUPERVISOR !== "container")
    return Promise.resolve("available");
  probe ??= run().then(
    ({ result, detail }) => {
      if (result !== "available")
        console.warn(`[codex] sandbox probe ${result} (${detail})`);
      return result;
    },
    (err: unknown) => {
      console.warn(`[codex] sandbox probe could not run: ${String(err)}`);
      return "unknown" as const;
    },
  );
  return probe;
}

export function resetCodexSandboxProbeForTests(): void {
  probe = null;
}

// The sandbox mode a Codex thread starts with. `fellBack` is true when the
// agent asked for a sandbox that this container cannot run.
export async function effectiveCodexSandbox(
  requested: string,
): Promise<{ sandbox: string; fellBack: boolean }> {
  if (requested === FULL_ACCESS) return { sandbox: requested, fellBack: false };
  if ((await codexSandboxProbe()) !== "denied")
    return { sandbox: requested, fellBack: false };
  return { sandbox: FULL_ACCESS, fellBack: true };
}
