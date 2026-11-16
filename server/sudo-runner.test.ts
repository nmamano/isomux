// The sudo runner (task 43a28eed) against a stand-in sudo
// (test-support/fake-sudo.ts): what it gives sudo (argv, environment, cwd, a
// socket for the password), how it tells a refused run from a started one,
// and what the agent gets back (the exit, the tail of the output, no
// markers). A real sudo run is a manual check, not CI.

import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFakeSudo,
  FAKE_SUDO_WRONG_PASSWORD,
} from "./test-support/fake-sudo.ts";
import {
  probeSudo,
  startSudo,
  SUDO_OUTPUT_TAIL,
  type SudoRunResult,
  type SudoStart,
  type SudoStartOptions,
} from "./sudo-runner.ts";

const PASSWORD = "c0rrect-H0rse-batt3ry";
const sudo = createFakeSudo();
sudo.setPassword(PASSWORD);
const work = mkdtempSync(join(tmpdir(), "isomux-sudo-runner-"));
const HOME = mkdtempSync(join(tmpdir(), "isomux-sudo-home-"));

afterAll(() => {
  for (const dir of [sudo.dir, work, HOME])
    rmSync(dir, { recursive: true, force: true });
});

function start(
  command: string,
  opts: Partial<SudoStartOptions> = {},
): Promise<SudoStart> {
  return startSudo({
    command,
    cwd: work,
    password: PASSWORD,
    home: HOME,
    sudoPath: sudo.path,
    ...opts,
  });
}

async function run(
  command: string,
  opts: Partial<SudoStartOptions> = {},
): Promise<SudoRunResult> {
  const started = await start(command, opts);
  if (started.kind !== "started")
    throw new Error(`sudo did not start the command: ${started.reason}`);
  return started.done;
}

// Whether a process with this pid still runs.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("what sudo gets", () => {
  it("reads the password from a socket, never a pipe or a file", async () => {
    await run("true");
    // A same-account agent can open a pipe of the server's through
    // /proc/<pid>/fd and race sudo for the password; a socket it cannot.
    expect(sudo.stdin()).toMatch(/^socket:/);
  });

  it("runs the command through the fixed wrapper, after --, with fresh markers each run", async () => {
    await run("echo one");
    const first = sudo.argv();
    await run("echo two");
    const second = sudo.argv();
    // -k: sudo neither reads nor writes the cached credential, so the
    // agent's own sudo still asks; -S: the password comes on stdin; -p: the
    // prompt is a marker the runner strips.
    expect(first.slice(0, 3)).toEqual(["-k", "-S", "-p"]);
    expect(first.slice(4, 7)).toEqual(["--", "/bin/sh", "-c"]);
    expect(first[8]).toBe("sh");
    expect(first[10]).toBe("echo one");
    // The cwd is the last argument (task b94dfd25 4b): root enters it.
    expect(first[11]).toBe(work);
    expect(first).toHaveLength(12);
    expect(second[10]).toBe("echo two");
    // The prompt and the start marker: different from each other, and new
    // for each run, so no command can know them in advance.
    const [prompt, marker] = [first[3], first[9]];
    expect(prompt.length).toBeGreaterThanOrEqual(16);
    expect(marker.length).toBeGreaterThanOrEqual(16);
    expect(prompt).not.toBe(marker);
    expect(second[3]).not.toBe(prompt);
    expect(second[9]).not.toBe(marker);
    // The wrapper is the same each run: the command is an argument, never
    // part of the script.
    expect(second[7]).toBe(first[7]);
    expect(first[7]).not.toContain("echo one");
    expect(first[7]).not.toContain(work);
  });

  // Task b94dfd25 4b: sudo starts in "/" and root enters the cwd, so a cwd
  // the office's account cannot enter (a member's own home) works.
  it("gets a fixed environment and starts in /, and the command runs in the request's cwd", async () => {
    process.env.ISOMUX_SUDO_RUNNER_TEST_LEAK = "leak";
    let result: SudoRunResult;
    try {
      result = await run("pwd -P");
    } finally {
      delete process.env.ISOMUX_SUDO_RUNNER_TEST_LEAK;
    }
    expect(sudo.env()).toEqual({
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LC_ALL: "C",
      HOME,
    });
    expect(sudo.cwd()).toBe("/");
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(realpathSync(work));
  });

  it("starts nothing when sudo is missing", async () => {
    await expect(
      start("true", { sudoPath: join(sudo.dir, "no-such-sudo") }),
    ).rejects.toThrow();
  });

  // A cwd that is gone at the run: sudo took the password, so the run
  // started and ends with the shell's line. It is never a refused password,
  // which would count toward the lockout, and the command never runs in /.
  it("a cwd that is gone or no folder at the run: started, a nonzero exit, the shell's line, and the command does not run", async () => {
    const file = join(work, "a-file");
    await Bun.write(file, "x");
    for (const cwd of [join(work, "gone"), file]) {
      const started = await start("echo command-ran", { cwd });
      expect({ cwd, kind: started.kind }).toEqual({ cwd, kind: "started" });
      if (started.kind !== "started") continue;
      const result = await started.done;
      expect(result.exitCode).not.toBe(0);
      expect(result.exitCode).not.toBeNull();
      expect(result.output).not.toContain("command-ran");
      // The shell's own line names the folder.
      expect(result.output).toContain(cwd);
    }
  });

  it("the cwd is an argument: a folder name with quotes and $( ) is entered as it is", async () => {
    const odd = join(work, `it's $(touch PWNED) "q" ;x`);
    mkdirSync(odd);
    const result = await run("pwd -P", { cwd: odd });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(realpathSync(odd));
    expect(existsSync(join("/", "PWNED"))).toBe(false);
    expect(existsSync(join(work, "PWNED"))).toBe(false);
    expect(existsSync(join(odd, "PWNED"))).toBe(false);
  });
});

describe("refused or started", () => {
  it("a wrong password: not started, with sudo's own last line and no marker", async () => {
    const started = await start("echo ran", { password: "wrong" });
    expect(started).toEqual({
      kind: "auth_failed",
      reason: FAKE_SUDO_WRONG_PASSWORD,
    });
  });

  it("a command the account may not run: not started, with sudo's reason", async () => {
    const line =
      "Sorry, user nil is not allowed to execute '/bin/sh' as root on box.";
    sudo.setRefusal(line);
    try {
      const started = await start("echo ran", { password: "wrong" });
      expect(started).toEqual({ kind: "auth_failed", reason: line });
    } finally {
      sudo.setRefusal(FAKE_SUDO_WRONG_PASSWORD);
    }
  });

  it("a command that fails still started: its exit code comes back", async () => {
    const result = await run("echo before; exit 3");
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
    });
    expect(result.output).toContain("before");
  });

  it("finds the start marker when it arrives in two reads", async () => {
    sudo.setSplitMarker(true);
    try {
      const result = await run("echo split-ok");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("split-ok");
      const [prompt, marker] = [sudo.argv()[3], sudo.argv()[9]];
      expect(result.output).not.toContain(prompt);
      expect(result.output).not.toContain(marker);
      expect(result.output).not.toContain(marker.slice(0, 8));
    } finally {
      sudo.setSplitMarker(false);
    }
  });
});

describe("the result", () => {
  it("has stdout and stderr, the duration, and neither marker", async () => {
    const result = await run("echo to-out; echo to-err >&2");
    const [prompt, marker] = [sudo.argv()[3], sudo.argv()[9]];
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.output).toContain("to-out");
    expect(result.output).toContain("to-err");
    expect(result.output).not.toContain(prompt);
    expect(result.output).not.toContain(marker);
  });

  it("keeps only the last SUDO_OUTPUT_TAIL characters of a large output", async () => {
    const result = await run(
      "head -c 1100000 /dev/zero | tr '\\0' a; printf END",
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("a".repeat(SUDO_OUTPUT_TAIL - 3) + "END");
  });

  it("gives the command a closed stdin, so a command that reads it ends", async () => {
    // cat waits for input until stdin closes: if the runner kept it open,
    // this run would never end.
    const result = await run("cat; echo read-done");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("read-done");
  });

  it("ends when sudo exits, even while a background child keeps the output open", async () => {
    const t0 = Date.now();
    const result = await run("sleep 4 & echo bg-started");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("bg-started");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

// Task b94dfd25 4b: the password is for sudo, never for the command. Where
// sudo needs no password (NOPASSWD), it reads no stdin, so a password
// written at once would reach the command; an agent of a member with their
// own OS user asks even then. Where sudo shows a PAM module's prompt in
// place of -p's (sudoers passprompt), it still reads the password.
describe("the password goes to sudo only", () => {
  it("NOPASSWD: the command's stdin never holds the password, with or without a line of sudo's first", async () => {
    // The probe says what the run finds.
    sudo.setProbe({ output: "    (ALL) NOPASSWD: ALL\n", code: 0 }, 0);
    try {
      for (const warning of [
        "",
        "sudo: unable to resolve host box: Name or service not known\n",
      ]) {
        sudo.setNoPassword(warning);
        const result = await run("cat; echo read-done");
        // The enabling condition: sudo asked for nothing.
        expect(sudo.stdin()).toMatch(/^socket:/);
        expect({ warning, exit: result.exitCode }).toEqual({
          warning,
          exit: 0,
        });
        expect(result.output).toContain("read-done");
        expect({ warning, leaked: result.output.includes(PASSWORD) }).toEqual({
          warning,
          leaked: false,
        });
      }
    } finally {
      sudo.setNoPassword(null);
      sudo.setProbe({ output: "sudo: a password is required\n", code: 1 }, 1);
    }
  });

  it("a PAM prompt in place of -p's: sudo still gets the password and the command starts", async () => {
    sudo.setPamPrompt("LDAP Password: ");
    try {
      // A short timeout, so a runner that waits for -p's prompt ends here
      // as a refused start instead of holding the case.
      const started = await start("echo pam-ok", { timeoutMs: 2000 });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const result = await started.done;
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("pam-ok");
      expect(result.output).not.toContain(PASSWORD);
    } finally {
      sudo.setPamPrompt(null);
    }
  });
});

describe("the timeout", () => {
  it("stops a run that takes too long with SIGTERM", async () => {
    const result = await run("exec sleep 30", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(alive(sudo.pid())).toBe(false);
  });

  it("kills a run that ignores SIGTERM after the grace", async () => {
    const result = await run("trap '' TERM; while :; do sleep 0.1; done", {
      timeoutMs: 300,
      killGraceMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(alive(sudo.pid())).toBe(false);
  });
});

describe("the probe", () => {
  const probe = () => probeSudo({ sudoPath: sudo.path });

  it("no sudo on the box: unavailable", async () => {
    expect(await probeSudo({ sudoPath: join(sudo.dir, "no-such-sudo") })).toBe(
      "unavailable",
    );
  });

  it("sudo asks for a password: available", async () => {
    // The listing itself needs the password. The stand-in answers in
    // Spanish without LC_ALL=C, which reads as unavailable.
    sudo.setProbe({ output: "sudo: a password is required\n", code: 1 }, 1);
    expect(await probe()).toBe("available");
    sudo.setProbe(
      { output: "User nil may run:\n    (ALL : ALL) ALL\n", code: 0 },
      1,
    );
    expect(await probe()).toBe("available");
  });

  it("a NOPASSWD entry for one command only: still available", async () => {
    sudo.setProbe(
      {
        output: "    (root) NOPASSWD: /usr/bin/apt\n    (ALL : ALL) ALL\n",
        code: 0,
      },
      1,
    );
    expect(await probe()).toBe("available");
  });

  it("sudo runs without a password: no_password_needed", async () => {
    // Only with -k: without it, the stand-in answers as if a cached
    // timestamp let `sudo -n true` pass.
    sudo.setProbe({ output: "    (ALL) NOPASSWD: ALL\n", code: 0 }, 0);
    expect(await probe()).toBe("no_password_needed");
  });

  it("the account may not use sudo: unavailable", async () => {
    for (const output of [
      "Sorry, user isomux may not run sudo on box.\n",
      "isomux is not in the sudoers file.\n",
      "sudo: something else went wrong\n",
    ]) {
      sudo.setProbe({ output, code: 1 }, 1);
      expect({ output, probe: await probe() }).toEqual({
        output,
        probe: "unavailable",
      });
    }
  });
});
