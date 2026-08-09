// SSH transport, and the authentication classifier the guarantee rests on.
//
// We shell out to the system ssh rather than use a JS library: no new
// dependency, no reimplemented crypto, native host-key pinning, and - because
// every call is an argv array handed to Bun.spawn - no shell on our side at
// all. Values that must reach the box travel as positional arguments to
// `bash -s`, never as interpolated text.
//
// THE FLAGS ARE LOAD-BEARING. The revocation proof reconnects with the key it
// just removed and requires that attempt to FAIL. If ssh could quietly satisfy
// that connection from the operator's own ~/.ssh, from a forwarded agent, or
// from a host alias in ~/.ssh/config, the one assertion the whole zero-standing-
// access guarantee rests on would pass for the wrong reason. So: no user
// config, no agent, only the identity we name.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The process seam, so driver logic is testable without a box. */
export interface Exec {
  run(argv: string[], opts?: { stdin?: string }): Promise<ExecResult>;
}

export class SpawnExec implements Exec {
  async run(argv: string[], opts?: { stdin?: string }): Promise<ExecResult> {
    const proc = Bun.spawn(argv, {
      stdin:
        opts?.stdin === undefined
          ? "ignore"
          : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }
}

export interface SshTarget {
  host: string;
  user: string;
  /** Private key path. The ONLY identity ssh is allowed to offer. */
  identityFile: string;
  /** Per-run known_hosts. Pinned on first contact, enforced after. */
  knownHostsFile: string;
  connectTimeoutS?: number;
}

/** ssh's own failures use this exit status; anything else came from the remote
 * command, which means authentication had already succeeded. */
const SSH_INTERNAL_EXIT = 255;

/**
 * What may appear as a token in a remote command line: no whitespace and no
 * shell metacharacters. Deliberately a strict allowlist - paths, flags, base64
 * blobs and our own formatted instants all pass; anything else belongs on
 * stdin.
 */
const SHELL_INERT = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function sshBaseArgs(
  target: SshTarget,
  hostKeyPolicy: "accept-new" | "yes",
): string[] {
  return [
    "ssh",
    // No ~/.ssh/config: a Host stanza could substitute a different user, port,
    // identity or ProxyCommand behind our backs.
    "-F",
    "/dev/null",
    // Offer ONLY -i, and never consult an agent.
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    `StrictHostKeyChecking=${hostKeyPolicy}`,
    "-o",
    `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o",
    `ConnectTimeout=${target.connectTimeoutS ?? 15}`,
    "-i",
    target.identityFile,
    `${target.user}@${target.host}`,
  ];
}

export type AuthOutcome =
  /** The key was accepted. */
  | { kind: "authenticated" }
  /** sshd refused the key. This - and only this - proves absence or expiry. */
  | { kind: "rejected" }
  /**
   * We learned nothing. A box that is merely unreachable, a name that does not
   * resolve, a changed host key: none of these prove our key is gone, and
   * treating them as proof would let a network blip certify a guarantee.
   */
  | { kind: "inconclusive"; reason: string };

/**
 * Classify one authentication attempt.
 *
 * Shared deliberately by the revocation proof and the expiry-time tests, so
 * there is exactly one definition of "sshd refused this key" in the codebase
 * and exactly one place to get it wrong.
 */
export function classifyAuth(result: ExecResult): AuthOutcome {
  if (result.code === 0) return { kind: "authenticated" };
  if (result.code !== SSH_INTERNAL_EXIT) {
    // The remote command ran and failed on its own terms, which still means
    // sshd let us in.
    return { kind: "authenticated" };
  }
  const err = result.stderr;
  if (/Permission denied \(publickey/i.test(err)) return { kind: "rejected" };
  if (
    /no matching host key type|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      err,
    )
  ) {
    return { kind: "inconclusive", reason: "host key mismatch" };
  }
  if (
    /Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(
      err,
    )
  ) {
    return { kind: "inconclusive", reason: "name resolution failed" };
  }
  if (/Connection timed out|Operation timed out|timed out/i.test(err)) {
    return { kind: "inconclusive", reason: "connection timed out" };
  }
  if (
    /Connection refused|No route to host|Network is unreachable|Connection closed by|Connection reset/i.test(
      err,
    )
  ) {
    return { kind: "inconclusive", reason: "transport failure" };
  }
  return {
    kind: "inconclusive",
    reason: `unrecognised ssh failure (exit ${result.code})`,
  };
}

export class SshClient {
  constructor(
    readonly target: SshTarget,
    private readonly exec: Exec,
    private readonly hostKeyPolicy: "accept-new" | "yes" = "yes",
  ) {}

  /**
   * Run a script on the box. The script arrives on stdin and its inputs arrive
   * as positional arguments, so nothing is ever spliced into a command string.
   */
  async script(body: string, args: string[] = []): Promise<ExecResult> {
    const argv = [
      ...sshBaseArgs(this.target, this.hostKeyPolicy),
      "bash",
      "-s",
      "--",
      ...args,
    ];
    return this.exec.run(argv, { stdin: body });
  }

  /**
   * Feed stdin to a fixed remote command.
   *
   * `remoteArgv` is joined by ssh into a remote shell command and re-split by
   * the remote shell, so a token carrying a space does NOT arrive as one
   * argument - it arrives as several. That is not a theoretical hazard: passing
   * an authorized_keys line ("ssh-ed25519 AAAA... comment") through here
   * silently became three arguments and wrote a corrupt key, which then
   * produced a test that passed while proving nothing.
   *
   * So the constraint is enforced rather than documented. Tokens must be
   * shell-inert: payloads go on stdin, where no quoting applies, and anything
   * with whitespace or a metacharacter is a programming error caught here.
   */
  async pipe(remoteArgv: string[], stdin: string): Promise<ExecResult> {
    for (const token of remoteArgv) {
      if (!SHELL_INERT.test(token)) {
        throw new Error(
          `unsafe remote argument ${JSON.stringify(token)}: it would be re-split ` +
            `or interpreted by the remote shell. Send it on stdin instead.`,
        );
      }
    }
    const argv = [
      ...sshBaseArgs(this.target, this.hostKeyPolicy),
      ...remoteArgv,
    ];
    return this.exec.run(argv, { stdin });
  }

  /** One authentication attempt that runs nothing of consequence. */
  async probeAuth(): Promise<AuthOutcome> {
    const argv = [...sshBaseArgs(this.target, this.hostKeyPolicy), "true"];
    return classifyAuth(await this.exec.run(argv));
  }
}
