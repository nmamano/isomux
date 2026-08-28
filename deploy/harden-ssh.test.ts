// deploy/harden-ssh.sh - the root-reachability check, exercised for real.
//
// The load-bearing rule is that the verdict comes from the ssh AUTHENTICATION
// TRANSCRIPT and never from ssh's exit status: a forced command in root's
// authorized_keys exits non-zero on a successful login, and a client-side
// config error exits non-zero without ever authenticating. Reading the exit
// status would report both as "kept out" - the exact failure that makes a
// security check worse than none.
//
// So these run the script with stub binaries on PATH (ssh, sshd, sudo, runuser,
// id, getent, passwd, ssh-keygen) and assert the exit status for each
// combination of transcript and exit code. The root guard is stripped from the
// copy under test - a separate test pins that the real script has it.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const SCRIPT = new URL("./harden-ssh.sh", import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, "utf8");

let dir = "";
let stubs = "";
let testable = "";
let configDir = "";
let authorizedKeys = "";

/** Write an executable stub that shadows a real binary during the test. */
function stub(name: string, body: string) {
  const path = join(stubs, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "isomux-harden-ssh-"));
  stubs = join(dir, "bin");
  mkdirSync(stubs);

  // The copy under test, minus the root guard (which is pinned separately) and
  // with the two absolute paths the apply path writes to and reads from moved
  // into the temp tree.
  testable = join(dir, "harden-ssh.sh");
  configDir = join(dir, "sshd_config.d");
  authorizedKeys = join(dir, "authorized_keys");
  writeFileSync(authorizedKeys, "ssh-ed25519 AAAAstub operator@laptop\n");
  const stripped = SRC.replace(
    /^\s*\[\[ \$EUID -eq 0 \]\] \|\| die .*$/m,
    "  :",
  )
    .replace(
      "SSHD_CONFIG_D=/etc/ssh/sshd_config.d",
      `SSHD_CONFIG_D=${configDir}`,
    )
    .replace(
      "AUTHORIZED_KEYS_FILES=(/root/.ssh/authorized_keys /home/*/.ssh/authorized_keys)",
      `AUTHORIZED_KEYS_FILES=(${authorizedKeys})`,
    );
  expect(stripped).not.toContain("$EUID -eq 0");
  expect(stripped).toContain(`SSHD_CONFIG_D=${configDir}`);
  expect(stripped).toContain(`AUTHORIZED_KEYS_FILES=(${authorizedKeys})`);
  writeFileSync(testable, stripped);

  // runuser -u <user> -- env -i VAR=... <cmd>  ->  just <cmd>, so the stubs on
  // PATH stay reachable (env -i would otherwise reset PATH to the real one).
  stub(
    "runuser",
    `[[ -z "\${STUB_RUNUSER_RC:-}" ]] || exit "$STUB_RUNUSER_RC"
shift 2; [[ \${1:-} == -- ]] && shift
if [[ \${1:-} == env ]]; then shift; [[ \${1:-} == -i ]] && shift; while [[ \${1:-} == *=* ]]; do shift; done; fi
exec "$@"`,
  );
  // Per-family transcripts: the last argument is root@<addr>, so a test can
  // make one address deny and the other let the probe in.
  stub(
    "ssh",
    `target=""
for a in "$@"; do case "$a" in root@*) target="$a" ;; esac; done
port=""; prev=""
for a in "$@"; do [[ "$prev" == -p ]] && port="$a"; prev="$a"; done
if [[ -n "\${STUB_SSH_ALT_PORT:-}" && "$port" == "\${STUB_SSH_ALT_PORT}" ]]; then
  printf '%s\\n' "\${STUB_SSH_ALT:-}" >&2
  exit "\${STUB_SSH_RC:-0}"
fi
if [[ "\${1:-}" == -G ]]; then
  # Effective client configuration, the way the real ssh -G reports it.
  [[ -z "\${STUB_SSH_G_RC:-}" ]] || exit "$STUB_SSH_G_RC"
  printf 'identityfile ~/.ssh/id_ed25519\\n'
  [[ -z "\${STUB_IDENTITYFILE:-}" ]] || printf 'identityfile %s\\n' "$STUB_IDENTITYFILE"
  exit 0
fi
[[ " $* " == *" -F /dev/null "* ]] || echo "STUB: ssh ran without -F /dev/null" >&2
if [[ "$target" == *:* && -n "\${STUB_SSH_V6:-}" ]]; then
  printf '%s\\n' "$STUB_SSH_V6" >&2
elif [[ "$target" != *:* && -n "\${STUB_SSH_V4:-}" ]]; then
  printf '%s\\n' "$STUB_SSH_V4" >&2
else
  printf '%s\\n' "\${STUB_SSH_TRANSCRIPT:-}" >&2
fi
exit "\${STUB_SSH_RC:-0}"`,
  );
  // -T is sshd's resolved configuration and -t its syntax check, which is the
  // pair the apply path leans on. The three policy lines default to a box where
  // the hardening wins; "omit" drops a line entirely, for the missing-value
  // case.
  stub(
    "sshd",
    `case "\${1:-}" in
  -T)
    [[ -z "\${STUB_SSHD_T_RC:-}" ]] || exit "$STUB_SSHD_T_RC"
    [[ -z "\${STUB_SSHD_T_EMPTY:-}" ]] || exit 0
    printf 'port 22\\nlistenaddress 0.0.0.0:22\\nlistenaddress [::]:22\\nauthorizedkeysfile %s\\nauthorizedkeyscommand none\\n' "\${STUB_AK:-.ssh/authorized_keys}"
    [[ "\${STUB_PW:-no}" == omit ]] || printf 'passwordauthentication %s\\n' "\${STUB_PW:-no}"
    [[ "\${STUB_KBD:-no}" == omit ]] || printf 'kbdinteractiveauthentication %s\\n' "\${STUB_KBD:-no}"
    [[ "\${STUB_ROOTLOGIN:-prohibit-password}" == omit ]] || printf 'permitrootlogin %s\\n' "\${STUB_ROOTLOGIN:-prohibit-password}"
    ;;
  -t) exit "\${STUB_SSHD_SYNTAX_RC:-0}" ;;
  *) : ;;
esac`,
  );
  // No global addresses, so the wildcard binds expand to 127.0.0.1 and ::1.
  stub("ip", `:`);
  stub("systemctl", `:`);
  // Listening ports for the banner sniff. Empty unless a test asks for one.
  stub("ss", `printf '%s' "\${STUB_SS:-}"`);
  // Root-side "sudo -n -l -U isomux" answers with STUB_SUDO_LIST/STUB_SUDO_LIST_RC;
  // the service-user cross-check "sudo -n true" answers with STUB_SUDO_RC.
  stub(
    "sudo",
    `if [[ "\${1:-}" == -n && "\${2:-}" == -l ]]; then
  printf '%s\\n' "\${STUB_SUDO_LIST:-User isomux is not allowed to run sudo on box.}"
  exit "\${STUB_SUDO_LIST_RC:-1}"
fi
exit "\${STUB_SUDO_RC:-1}"`,
  );
  stub("id", `case "\${1:-}" in -u) echo 1001 ;; -nG) echo isomux ;; esac`);
  stub("getent", `echo "isomux:x:1001:1001::${dir}/home:/bin/bash"`);
  stub("passwd", `echo "isomux L 01/01/2026 0 99999 7 -1"`);
  // Derives a public key by default, so no candidate is left "unproven" and the
  // PASS headline is deterministic; STUB_KEYGEN_FAIL exercises the other side.
  stub(
    "ssh-keygen",
    `[[ -z "\${STUB_KEYGEN_FAIL:-}" ]] || exit 1
printf 'ssh-ed25519 AAAAstubbedblob%s comment\\n' "\${5##*/}"`,
  );
  stub("timeout", `shift; exec "$@"`);
  // Real mv, except that a test can make one specific source fail: the apply
  // path's rollback turns on mv succeeding, and the failure is otherwise
  // unreachable. Matched on the source's basename so a stash can be made to
  // fail without also breaking the restore that puts it back.
  stub(
    "mv",
    `src=\${1##*/}
[[ -z "\${STUB_MV_FAIL_SRC:-}" || "$src" != "\${STUB_MV_FAIL_SRC}" ]] || exit 1
exec /bin/mv "$@"`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run the check and return its exit status plus combined output. */
async function check(env: Record<string, string>) {
  const proc = Bun.spawn(["bash", testable, "--check"], {
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: process.env.HOME ?? "/tmp",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: out + err };
}

/** Run the apply job and return its exit status plus combined output. */
async function apply(env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", testable, "--apply"], {
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: process.env.HOME ?? "/tmp",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: out + err };
}

const dropin = () => join(configDir, "00-isomux-hardening.conf");
const legacy = () => join(configDir, "90-isomux-hardening.conf");

/** A hardening file left by a version that applied it last of all. */
function plantLegacy() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(legacy(), "PasswordAuthentication no\n");
}

/** A working drop-in from an earlier run of THIS version, distinctively marked. */
const PRIOR = "# from the previous run\nPasswordAuthentication no\n";
function plantPrior() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(dropin(), PRIOR);
}

/** Everything left in the drop-in directory, so a stray backup shows up. */
const configFiles = () =>
  existsSync(configDir) ? readdirSync(configDir).sort() : [];

const AUTHENTICATED = `debug1: Authentication succeeded (publickey).
Authenticated to localhost ([::1]:22) using "publickey".`;
const DENIED = "root@localhost: Permission denied (publickey,password).";
const REFUSED = "ssh: connect to host 127.0.0.1 port 22: Connection refused";
const CLOSED =
  "kex_exchange_identification: Connection closed by remote host\nConnection closed by 127.0.0.1 port 22";
// A server banner is arbitrary text that arrives before authentication
// finishes, so it can carry anything - including a fake denial.
const BANNER_INJECTION = `Permission denied (publickey).
kex_exchange_identification: Connection closed by remote host`;

describe("harden-ssh.sh --check", () => {
  it("a successful login is a FAIL, whatever ssh exits with", async () => {
    const checks = ["0", "1", "255"].map(async (rc) => ({
      rc,
      ...(await check({
        STUB_SSH_TRANSCRIPT: AUTHENTICATED,
        STUB_SSH_RC: rc,
      })),
    }));
    for (const { rc, code, output } of await Promise.all(checks)) {
      expect({ rc, code }).toEqual({ rc, code: 1 });
      expect(output).toContain("can reach root");
    }
  });

  it("a refused login is a PASS, whatever ssh exits with", async () => {
    const checks = ["0", "255"].map(async (rc) => ({
      rc,
      ...(await check({
        STUB_SSH_TRANSCRIPT: DENIED,
        STUB_SSH_RC: rc,
      })),
    }));
    for (const { rc, code, output } of await Promise.all(checks)) {
      expect({ rc, code }).toEqual({ rc, code: 0 });
      expect(output).toContain("cannot log in as root over SSH");
      expect(output).toContain("and cannot sudo");
    }
  });

  it("getting in on ONE address family is a FAIL", async () => {
    // ssh stops at the first address it can connect to, so a single
    // root@localhost attempt can be answered by ::1 while 127.0.0.1 runs a
    // different policy (or vice versa). Each address is tried on its own.
    const checks = [
      [DENIED, AUTHENTICATED],
      [AUTHENTICATED, DENIED],
    ].map(async ([v4, v6]) => ({
      v4,
      v6,
      ...(await check({
        STUB_SSH_V4: v4,
        STUB_SSH_V6: v6,
        STUB_SSH_RC: "255",
      })),
    }));
    for (const { code, output } of await Promise.all(checks)) {
      expect(code).toBe(1);
      expect(output).toContain("logged in as root over SSH at");
    }
  });

  it("reports which addresses it actually tried", async () => {
    const { output } = await check({ STUB_SSH_TRANSCRIPT: DENIED });
    expect(output).toContain("127.0.0.1 port 22");
    expect(output).toContain("::1 port 22");
  });

  it("ignores the service account's own ssh config", async () => {
    // A HostName or ProxyCommand line there could send the probe somewhere
    // else and manufacture a refusal.
    const { output } = await check({ STUB_SSH_TRANSCRIPT: DENIED });
    expect(output).not.toContain("STUB: ssh ran without -F /dev/null");
  });

  it("nothing listening is a PASS that says so", async () => {
    // The probe runs as the account under test, from this box: an endpoint it
    // cannot connect to is not a way in for that account either.
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: REFUSED,
      STUB_SSH_RC: "255",
    });
    expect(code).toBe(0);
    expect(output).toContain("nothing was accepting SSH connections");
  });

  it("an unreadable outcome is UNKNOWN, and UNKNOWN is not a pass", async () => {
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: CLOSED,
      STUB_SSH_RC: "255",
    });
    expect(code).toBe(2);
    expect(output).toContain("COULD NOT TELL");
    // The transcript tail has to survive back to the message, or "could not
    // tell" is untriageable.
    expect(output).toContain("Connection closed");
  });

  it("a banner that says 'Permission denied' does not make a pass", async () => {
    const { code } = await check({
      STUB_SSH_TRANSCRIPT: BANNER_INJECTION,
      STUB_SSH_RC: "255",
    });
    expect(code).toBe(2);
  });

  it("a broken way to run as the service account is UNKNOWN, not a pass", async () => {
    // Otherwise every probe comes back "kept out" for the wrong reason and the
    // box passes without having been tested at all.
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_RUNUSER_RC: "1",
    });
    expect(code).toBe(2);
    expect(output).toContain("nothing was actually tested");
  });

  it("passwordless sudo fails the check on its own", async () => {
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_SUDO_RC: "0",
    });
    expect(code).toBe(1);
    expect(output).toContain("without being asked for a password");
  });

  it("a NOPASSWD rule fails the check even when `sudo true` is refused", async () => {
    // "isomux ALL=(root) NOPASSWD: /bin/bash" denies `sudo true` and still
    // hands over a root shell, so trying one command proves nothing.
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_SUDO_RC: "1",
      STUB_SUDO_LIST_RC: "0",
      STUB_SUDO_LIST:
        "User isomux may run the following commands on box:\n    (root) NOPASSWD: /bin/bash",
    });
    expect(code).toBe(1);
    expect(output).toContain("with sudo and no password");
    expect(output).toContain("/bin/bash");
  });

  it("entries that all need a password are a PASS", async () => {
    const { code } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_SUDO_LIST_RC: "0",
      STUB_SUDO_LIST:
        "User isomux may run the following commands on box:\n    (ALL) ALL",
    });
    expect(code).toBe(0);
  });

  it("a sudo query that fails for an unrecognised reason is UNKNOWN", async () => {
    // Timeouts, a broken sudoers file, an ldap policy plugin that is down: none
    // of those mean "cannot sudo".
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_SUDO_LIST_RC: "1",
      STUB_SUDO_LIST: "sudo: unable to resolve host box: Temporary failure",
    });
    expect(code).toBe(2);
    expect(output).toContain(
      "could not establish what isomux may do with sudo",
    );
  });

  it("a readable key that root accepts is a FAIL, even when the login is refused", async () => {
    // The login attempt can miss it: a from= restriction, a server that stopped
    // taking attempts, a key the client never offered. The key is still a way
    // in.
    const home = join(dir, "home", ".ssh");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "deploy-key"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n",
    );
    const ak = join(dir, "root-authorized-keys");
    writeFileSync(ak, "ssh-ed25519 AAAAstubbedblobdeploy-key laptop\n");
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_AK: ak,
    });
    expect(code).toBe(1);
    expect(output).toContain("ACCEPTED BY ROOT");
    rmSync(join(dir, "home"), { recursive: true, force: true });
  });

  it("a commented-out line in root's key list is not a key root accepts", async () => {
    const home = join(dir, "home", ".ssh");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "deploy-key"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n",
    );
    const ak = join(dir, "root-authorized-keys-commented");
    writeFileSync(ak, "# ssh-ed25519 AAAAstubbedblobdeploy-key old laptop\n");
    const { code } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_AK: ak,
    });
    expect(code).toBe(0);
    rmSync(join(dir, "home"), { recursive: true, force: true });
  });

  it("follows the account's ssh config to keys outside any .ssh directory", async () => {
    // -F /dev/null keeps the login probe from being redirected, so a key the
    // config names somewhere else would go untested if nothing looked it up.
    const outside = join(dir, "opt");
    mkdirSync(outside, { recursive: true });
    const key = join(outside, "root-key");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n");
    const ak = join(dir, "root-authorized-keys-outside");
    writeFileSync(ak, "ssh-ed25519 AAAAstubbedblobroot-key laptop\n");
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_AK: ak,
      STUB_IDENTITYFILE: key,
    });
    expect(code).toBe(1);
    expect(output).toContain(key);
    rmSync(outside, { recursive: true, force: true });
  });

  it("a second SSH daemon on another port is probed too", async () => {
    // OpenSSH masked, dropbear listening: the OpenSSH endpoints go unreachable
    // and the box would pass without this.
    const banner = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          s.write("SSH-2.0-dropbear_2022.83\r\n");
        },
        data: () => {},
        error: () => {},
      },
    });
    try {
      const { code, output } = await check({
        STUB_SSH_TRANSCRIPT: REFUSED,
        STUB_SSH_RC: "255",
        STUB_SS: `LISTEN 0 4096 127.0.0.1:${banner.port} 0.0.0.0:*\n`,
        STUB_SSH_ALT_PORT: String(banner.port),
        STUB_SSH_ALT: AUTHENTICATED,
      });
      expect(code).toBe(1);
      expect(output).toContain(`port ${banner.port}`);
    } finally {
      banner.stop(true);
    }
  });

  it("an ssh config that cannot be read is UNKNOWN, not 'no keys configured'", async () => {
    // A malformed config, an unreadable Include, a Match exec that hangs: any
    // of those returns no identity files, which must not read as "this account
    // has none".
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_SSH_G_RC: "255",
    });
    expect(code).toBe(2);
    expect(output).toContain("ssh configuration could not be read");
  });

  it("finds an SSH server that greets with other lines first", async () => {
    // The protocol lets a server send lines before its SSH-2.0-... string, so
    // judging the first four bytes would miss this one entirely.
    const banner = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          s.write(
            "Notice: authorised users only\r\nSSH-2.0-dropbear_2022.83\r\n",
          );
        },
        data: () => {},
        error: () => {},
      },
    });
    try {
      const { code, output } = await check({
        STUB_SSH_TRANSCRIPT: REFUSED,
        STUB_SSH_RC: "255",
        STUB_SS: `LISTEN 0 4096 127.0.0.1:${banner.port} 0.0.0.0:* users:(("dropbear",pid=1,fd=3))\n`,
        STUB_SSH_ALT_PORT: String(banner.port),
        STUB_SSH_ALT: AUTHENTICATED,
      });
      expect(code).toBe(1);
      expect(output).toContain(`port ${banner.port}`);
    } finally {
      banner.stop(true);
    }
  });

  it("says out loud which listening ports it could not identify", async () => {
    // A port that never speaks first is indistinguishable from a slow SSH
    // server. Not enough to block an install; not something to hide either.
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: () => {}, data: () => {}, error: () => {} },
    });
    try {
      const { code, output } = await check({
        STUB_SSH_TRANSCRIPT: DENIED,
        STUB_SSH_RC: "255",
        STUB_SS: `LISTEN 0 4096 127.0.0.1:${silent.port} 0.0.0.0:* users:(("mystery",pid=2,fd=3))\n`,
      });
      expect(code).toBe(0);
      expect(output).toContain("not identified");
      expect(output).toContain(`port ${silent.port}`);
      // ...and the headline says so too: an absolute "cannot log in" next to
      // "this port was not tested" cannot both be true.
      expect(output).toContain("no way in was found");
      expect(output).not.toContain(
        "PASSED - the isomux service account cannot log in",
      );
    } finally {
      silent.stop(true);
    }
    // Longer than the default: a silent port costs the sniff its full deadline,
    // which is the behaviour under test.
  }, 20000);

  it("softens the headline when a key on the box could not be opened", async () => {
    // "Cannot log in" next to "we could not check this key" would contradict
    // itself. The guarantee is narrowed to what was actually testable.
    const home = join(dir, "home", ".ssh");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "locked-key"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n",
    );
    const { code, output } = await check({
      STUB_SSH_TRANSCRIPT: DENIED,
      STUB_SSH_RC: "255",
      STUB_KEYGEN_FAIL: "1",
    });
    expect(code).toBe(0);
    expect(output).toContain("no way in was found");
    expect(output).toContain("locked-key");
    rmSync(join(dir, "home"), { recursive: true, force: true });
  });

  it("prints the evidence that makes a failure fixable", async () => {
    // A verdict with no evidence is a dead end for whoever has to fix the box.
    const { output } = await check({
      STUB_SSH_TRANSCRIPT: AUTHENTICATED,
      STUB_SSH_RC: "0",
    });
    expect(output).toContain("What is on this box:");
    expect(output).toContain("/root/.ssh/authorized_keys");
    expect(output).toContain("How to fix it:");
  });
});

describe("harden-ssh.sh source", () => {
  it("refuses to run as anyone but root", () => {
    expect(SRC).toMatch(/\[\[ \$EUID -eq 0 \]\] \|\| die /);
  });

  it("has no escape hatch", () => {
    // Deliberate: a box that fails the check is not safe to run agents on, and
    // an env var that skips it would be set by exactly the installs that most
    // need it. Fixing the box is the only way past.
    expect(SRC).not.toMatch(
      /\$\{?[A-Z_]*(SKIP|FORCE|ALLOW|IGNORE|OVERRIDE|UNSAFE)[A-Z_]*/,
    );
  });

  it("probes with no ssh-agent in the environment", () => {
    // A forwarded agent would lend the probe keys the service account does not
    // have, turning a clean box into a false alarm.
    expect(SRC).toContain("env -i");
    expect(SRC).toContain("-o BatchMode=yes");
  });

  it("classifies on the transcript, not the exit status", () => {
    expect(SRC).toContain(
      "^(Authenticated to |debug1: Authentication succeeded)",
    );
    // Anchored: an unanchored search could be fed by a server banner.
    expect(SRC).toContain("^root@[^ ]+: Permission denied[ ,(]");
    // The probe's own status is deliberately discarded.
    expect(SRC).toMatch(/"root@\$addr" true 2>&1\) \|\| true/);
  });

  it("a readable key that root accepts fails on its own", () => {
    // Independent of the login attempt: a restriction in authorized_keys can
    // hide the same key from a probe, and the key is still a way in.
    const guard = SRC.indexOf("if [[ -n $KEY_HIT && $SSH_STATE != FAIL ]]");
    expect(guard).toBeGreaterThan(-1);
    const block = SRC.slice(guard, SRC.indexOf("\n  fi\n", guard));
    expect(block).toContain("SSH_STATE=FAIL");
  });

  it("treats a passphrase-locked key as unproven, not safe", () => {
    expect(SRC).toContain(
      "locked with a passphrase, so whether root accepts it could not be tested",
    );
    // Said on a PASS too, not only when something already went wrong.
    const pass = SRC.slice(SRC.indexOf("report_pass() {"));
    expect(pass).toContain("KEY_UNPROVEN");
  });
});

// The apply path, against a stubbed sshd. What makes hardening real is not the
// file being written but sshd resolving the policies it names - Contabo's image
// ships a 50-cloud-init.conf that turns password logins back on, and the old
// 90- file lost to it while reporting success.
describe("harden-ssh.sh --apply", () => {
  beforeEach(() => rmSync(configDir, { recursive: true, force: true }));

  it("writes a drop-in that sorts ahead of the provider's own", async () => {
    const { code, output } = await apply();
    expect(code).toBe(0);
    expect(existsSync(dropin())).toBe(true);
    expect(output).toContain("key-only SSH auth is in place");
    // The name is the mechanism: first value read wins, files are read in
    // name order, and 50-cloud-init.conf is the one to beat.
    expect(basename(dropin()) < "50-cloud-init.conf").toBe(true);
  });

  it("fails when an earlier file already turned password logins on", async () => {
    const { code, output } = await apply({ STUB_PW: "yes" });
    expect(code).toBe(3);
    expect(existsSync(dropin())).toBe(false);
    expect(output).toContain("passwordauthentication is yes, not no");
    expect(output).not.toContain("key-only SSH auth is in place");
  });

  it("fails when keyboard-interactive survives", async () => {
    const { code, output } = await apply({ STUB_KBD: "yes" });
    expect(code).toBe(3);
    expect(output).toContain("kbdinteractiveauthentication is yes, not no");
    expect(output).not.toContain("key-only SSH auth is in place");
  });

  it("fails when root can still log in with a password", async () => {
    const { code, output } = await apply({ STUB_ROOTLOGIN: "yes" });
    expect(code).toBe(3);
    expect(output).toContain("permitrootlogin is yes, not prohibit-password");
  });

  it("fails when sshd will not report its resolved configuration", async () => {
    for (const env of [{ STUB_SSHD_T_RC: "1" }, { STUB_SSHD_T_EMPTY: "1" }]) {
      const { code, output } = await apply(env);
      expect(code).toBe(3);
      expect(existsSync(dropin())).toBe(false);
      expect(output).toContain("would not report its resolved configuration");
      expect(output).not.toContain("key-only SSH auth is in place");
    }
  });

  it("fails when a policy is missing from the resolved configuration", async () => {
    const { code, output } = await apply({ STUB_ROOTLOGIN: "omit" });
    expect(code).toBe(3);
    expect(existsSync(dropin())).toBe(false);
    expect(output).toContain("does not report permitrootlogin at all");
  });

  it("takes without-password as the same answer as prohibit-password", async () => {
    // Some sshd versions render the policy under its older name.
    const { code, output } = await apply({
      STUB_ROOTLOGIN: "without-password",
    });
    expect(code).toBe(0);
    expect(output).toContain("key-only SSH auth is in place");
  });

  it("retires the 90- file a previous version left behind", async () => {
    plantLegacy();
    const { code } = await apply();
    expect(code).toBe(0);
    expect(existsSync(dropin())).toBe(true);
    expect(existsSync(legacy())).toBe(false);
  });

  it("puts the 90- file back when the new one does not take", async () => {
    plantLegacy();
    const { code } = await apply({ STUB_PW: "yes" });
    expect(code).toBe(3);
    expect(existsSync(dropin())).toBe(false);
    expect(readFileSync(legacy(), "utf8")).toBe("PasswordAuthentication no\n");
  });

  it("backs out of a configuration sshd rejects", async () => {
    plantLegacy();
    const { code, output } = await apply({ STUB_SSHD_SYNTAX_RC: "1" });
    expect(code).toBe(3);
    expect(existsSync(dropin())).toBe(false);
    expect(existsSync(legacy())).toBe(true);
    expect(output).toContain("sshd rejected the configuration");
  });

  it("puts a working drop-in from an earlier run back when the new one does not take", async () => {
    // The rerun case: there is no 90- file to fall back on any more, so
    // removing the candidate without restoring this would leave the box less
    // hardened than the run found it.
    plantPrior();
    const { code } = await apply({ STUB_PW: "yes" });
    expect(code).toBe(3);
    expect(readFileSync(dropin(), "utf8")).toBe(PRIOR);
    expect(configFiles()).toEqual(["00-isomux-hardening.conf"]);
  });

  it("puts a working drop-in back when sshd rejects the configuration", async () => {
    plantPrior();
    plantLegacy();
    const { code } = await apply({ STUB_SSHD_SYNTAX_RC: "1" });
    expect(code).toBe(3);
    expect(readFileSync(dropin(), "utf8")).toBe(PRIOR);
    expect(readFileSync(legacy(), "utf8")).toBe("PasswordAuthentication no\n");
    expect(configFiles()).toEqual([
      "00-isomux-hardening.conf",
      "90-isomux-hardening.conf",
    ]);
  });

  it("touches nothing when the drop-in cannot be moved aside", async () => {
    // The stash is the first thing that can fail, and it fails before the
    // candidate exists: nothing may be deleted on the way out.
    plantPrior();
    plantLegacy();
    const { code, output } = await apply({
      STUB_MV_FAIL_SRC: "00-isomux-hardening.conf",
    });
    expect(code).toBe(3);
    expect(output).toContain("could not move the existing");
    expect(readFileSync(dropin(), "utf8")).toBe(PRIOR);
    expect(configFiles()).toEqual([
      "00-isomux-hardening.conf",
      "90-isomux-hardening.conf",
    ]);
  });

  it("puts the drop-in back when the second stash fails", async () => {
    // Half-stashed is the dangerous state: the drop-in is already hidden and
    // the box has no hardening of its own.
    plantPrior();
    plantLegacy();
    const { code, output } = await apply({
      STUB_MV_FAIL_SRC: "90-isomux-hardening.conf",
    });
    expect(code).toBe(3);
    expect(output).toContain("could not move");
    expect(readFileSync(dropin(), "utf8")).toBe(PRIOR);
    expect(readFileSync(legacy(), "utf8")).toBe("PasswordAuthentication no\n");
    expect(configFiles()).toEqual([
      "00-isomux-hardening.conf",
      "90-isomux-hardening.conf",
    ]);
  });

  it("leaves no stash behind when it succeeds", async () => {
    plantPrior();
    plantLegacy();
    const { code } = await apply();
    expect(code).toBe(0);
    expect(configFiles()).toEqual(["00-isomux-hardening.conf"]);
    expect(readFileSync(dropin(), "utf8")).toContain("Named to sort");
  });

  it("writes nothing on a box with no key to get back in with", async () => {
    writeFileSync(authorizedKeys, "");
    try {
      const { code, output } = await apply();
      expect(code).toBe(10);
      expect(existsSync(dropin())).toBe(false);
      expect(output).toContain("SSH HARDENING SKIPPED");
    } finally {
      writeFileSync(authorizedKeys, "ssh-ed25519 AAAAstub operator@laptop\n");
    }
  });
});
