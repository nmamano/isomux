// The member OS users in the real container image (scripts/split-rig.sh
// member mode; internal-docs/member-os-user-design.md, slice 1b of task
// b94dfd25). The office runs as node; two members, Alice and Bob, get their
// own OS users through the root command, as an admin does it. Needs Docker
// and an image built from the committed HEAD:
//
//   systemd-run --user --scope -p MemoryMax=6G scripts/split-rig.sh build-member isomux-member-rig
//   ISOMUX_TEST_MEMBER_RIG=1 MEMBER_RIG_TAG=isomux-member-rig bun test server/test-support/member-rig.integration.test.ts
//
// MEMBER_RIG_PREFIX names the containers and volumes (default: the pid).
// The cases share one container and run in order.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ENABLED = process.env.ISOMUX_TEST_MEMBER_RIG === "1";
setDefaultTimeout(180_000);
const ROOT = join(import.meta.dir, "..", "..");
const RIG = join(ROOT, "scripts", "split-rig.sh");
const TAG = process.env.MEMBER_RIG_TAG ?? "isomux-member-rig";
const PREFIX = `member-rig-${process.env.MEMBER_RIG_PREFIX ?? process.pid}`;
const HOST = "office.example.com";
const ORIGIN = `https://${HOST}`;
const KEY = "member-rig-setup-key-0123456789abcdef";
const CANARY = "member-rig-canary";
const STATE = "/var/data/home/.isomux";
const MEMBERS = "/var/data/members";
const OFFICE_UID = 1000;
const ALICE = "isomux-alice";
const BOB = "isomux-bob";
const started: string[] = [];

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, cwd: ROOT });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function sh(name: string, user: string, command: string) {
  return run("docker", ["exec", "-u", user, name, "bash", "-c", command]);
}

const root = (name: string, command: string) => sh(name, "0", command);

function start(suffix: string): string {
  const name = `${PREFIX}-${suffix}`;
  started.push(name);
  run("bash", [RIG, "stop", name]);
  const r = run("bash", [RIG, "start-member", name, TAG]);
  if (r.status !== 0) throw new Error(`rig start failed: ${r.err}`);
  return name;
}

// Wait until the office answers on its port and, once claimed, admin.sock
// is there; the time it took, in ms.
async function office(
  name: string,
  status?: string,
  claimed = true,
): Promise<number> {
  const begin = Date.now();
  while (Date.now() - begin < 120_000) {
    const r = root(
      name,
      `${claimed ? `test -S ${STATE}/admin.sock && ` : ""}curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${HOST}' http://127.0.0.1:10000/`,
    );
    if (r.status === 0 && r.out !== "000" && (!status || r.out === status))
      return Date.now() - begin;
    await Bun.sleep(250);
  }
  throw new Error(`${name}: the office did not come up`);
}

async function claim(name: string): Promise<string> {
  await office(name, "200", false);
  const r = root(
    name,
    `curl -s -i -X POST http://127.0.0.1:10000/setup -H 'Host: ${HOST}' -H 'Origin: ${ORIGIN}' --data 'name=Owner&key=${KEY}'`,
  );
  const cookie = /set-cookie: (__Host-isomux_session_[0-9a-f]{12}=[^;]+)/i.exec(
    r.out,
  )?.[1];
  if (!cookie) throw new Error(`claim failed: ${r.out}`);
  await office(name, "401");
  return cookie;
}

function api(
  name: string,
  cookie: string,
  method: string,
  path: string,
  body: unknown,
): Record<string, unknown> {
  const r = run(
    "docker",
    [
      "exec",
      "-i",
      name,
      "curl",
      "-s",
      "-X",
      method,
      `http://127.0.0.1:10000${path}`,
      "-H",
      `Host: ${HOST}`,
      "-H",
      `Origin: ${ORIGIN}`,
      "-H",
      `Cookie: ${cookie}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
    ],
    JSON.stringify(body),
  );
  // A 204 has no body.
  return (r.out ? JSON.parse(r.out) : {}) as Record<string, unknown>;
}

function member(
  name: string,
  cookie: string,
  who: string,
  allowedRooms: string[] = [],
): string {
  const made = api(name, cookie, "POST", "/api/users", {
    name: who,
    role: "member",
    allowedRooms,
  });
  return (made.user as { id: string }).id;
}

const command = (name: string, ...args: string[]) =>
  run("docker", ["exec", "-u", "0", name, "isomux-member-user", ...args]);

// An admin.sock verb as root, the way the command sends it.
function admin(name: string, verb: string, body: unknown) {
  const r = root(
    name,
    `curl -s --unix-socket ${STATE}/admin.sock -X POST -H 'Content-Type: application/json' --data '${JSON.stringify(body)}' http://localhost/admin/member-user/${verb}`,
  );
  return JSON.parse(r.out) as Record<string, unknown>;
}

const uidOf = (name: string, user: string) =>
  Number(root(name, `id -u ${user}`).out.trim());

// The pid of the member's runner (bun runner.js), or "".
const runnerPid = (name: string, user: string) =>
  root(name, `pgrep -u ${user} -f 'runner.js runner' | head -1`).out.trim();

async function waitFor(
  what: string,
  check: () => boolean,
  ms = 60_000,
): Promise<number> {
  const begin = Date.now();
  while (Date.now() - begin < ms) {
    if (check()) return Date.now() - begin;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A runner request as one user, in Python so that the client is not the
// code under test. The frames it got back: control messages as objects.
function runnerRequest(
  name: string,
  user: string,
  socket: string,
  request: unknown,
) {
  const r = run(
    "docker",
    ["exec", "-i", "-u", user, name, "python3", "-"],
    `import json, socket, struct
s = socket.socket(socket.AF_UNIX)
s.settimeout(10)
try:
    s.connect("${socket}")
except OSError as error:
    print(json.dumps({"connect": error.errno}))
    raise SystemExit
payload = ${JSON.stringify(JSON.stringify(request))}.encode()
s.sendall(struct.pack(">IB", len(payload) + 1, 1) + payload)
data = b""
while True:
    try:
        chunk = s.recv(65536)
    except OSError:
        break
    if not chunk:
        break
    data += chunk
got = []
while len(data) >= 5:
    length, kind = struct.unpack(">IB", data[:5])
    frame = data[5:4 + length]
    data = data[4 + length:]
    got.append(json.loads(frame) if kind == 1 else {"stdout": frame.decode()})
print(json.dumps(got))`,
  );
  if (r.status !== 0) throw new Error(`runner request failed: ${r.err}`);
  return JSON.parse(r.out.trim()) as unknown;
}

// Remove the containers and volumes this file started (MEMBER_RIG_KEEP=1
// keeps them for a look).
function stopAll(): void {
  if (process.env.MEMBER_RIG_KEEP === "1") return;
  for (const n of started.splice(0)) run("bash", [RIG, "stop", n]);
}

const socketOf = (user: string) => `/run/isomux-runner-${user}/runner.sock`;

// The error code one user gets for one file operation, or "ok".
function tryAs(name: string, user: string, op: string): string {
  return run(
    "docker",
    ["exec", "-i", "-u", user, name, "python3", "-"],
    `import os, socket
try:
    ${op}
    print("ok")
except OSError as error:
    import errno
    print(errno.errorcode[error.errno])`,
  ).out.trim();
}

// An office client in the container: a WebSocket with a member's cookie
// that opens the terminal panel of an agent and reports the shell's uid.
const TERMINAL = `
const [cookie, agentId, host, origin] = JSON.parse(process.env.RIG_ARGS);
const ws = new WebSocket("ws://127.0.0.1:10000/ws", { headers: { Cookie: cookie, Host: host, Origin: origin } });
let out = "";
const finish = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
setTimeout(() => finish({ timeout: true, out }), 30000);
ws.onopen = () => ws.send(JSON.stringify({ type: "terminal_open", agentId }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "terminal_output" && msg.agentId === agentId) {
    out += msg.data;
    if (!out.includes("RIG_UID=") && /[$#] $/.test(out))
      ws.send(JSON.stringify({ type: "terminal_input", agentId, data: "echo RIG_UID=$(id -u)\\n" }));
    const m = /RIG_UID=(\\d+)\\r?\\n/.exec(out.split("echo RIG_UID=").pop() ?? "");
    if (m) finish({ uid: Number(m[1]) });
  }
};
`;

describe.skipIf(!ENABLED)("member OS users in the container", () => {
  let name: string;
  let cookie: string;
  let alice: string;
  let bob: string;
  let roomId: string;
  let aliceCookie = "";

  beforeAll(async () => {
    name = start("main");
    cookie = await claim(name);
    roomId = (
      api(name, cookie, "POST", "/api/rooms", { name: "Rig" }).room as {
        id: string;
      }
    ).id;
    alice = member(name, cookie, "Alice", [roomId]);
    bob = member(name, cookie, "Bob");
    for (const who of ["Alice", "Bob"]) {
      const r = command(name, "enable", who);
      if (r.status !== 0) throw new Error(`enable ${who}: ${r.err}`);
    }
  });

  afterAll(stopAll);

  it("ships no file that a group or others can write under /opt/isomux", () => {
    expect(
      root(name, "find /opt/isomux -xdev ! -type l -perm /022 | head -5").out,
    ).toBe("");
  });

  it("gives each member a uid above the office's, recorded on the volume", () => {
    const users = JSON.parse(root(name, `cat ${MEMBERS}/users.json`).out);
    const a = uidOf(name, ALICE);
    const b = uidOf(name, BOB);
    expect(users).toEqual({
      [ALICE]: { uid: a, gid: a },
      [BOB]: { uid: b, gid: b },
    });
    expect(a).toBeGreaterThan(OFFICE_UID);
    expect(b).toBeGreaterThan(a);
  });

  it("runs each runner as its member with no group, capability or new privilege, outside root's session", () => {
    for (const user of [ALICE, BOB]) {
      const uid = uidOf(name, user);
      const pid = runnerPid(name, user);
      expect([user, pid]).not.toEqual([user, ""]);
      const status = root(name, `cat /proc/${pid}/status`).out;
      const field = (key: string) =>
        new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(status)?.[1].trim();
      expect([user, field("Uid")!.split(/\s+/).map(Number)]).toEqual([
        user,
        [uid, uid, uid, uid],
      ]);
      expect([user, field("Groups")]).toEqual([user, ""]);
      expect([
        user,
        field("CapEff"),
        field("CapPrm"),
        field("NoNewPrivs"),
      ]).toEqual([user, "0000000000000000", "0000000000000000", "1"]);
      // The loop is the runner's parent: tini's child, a session of its own,
      // its stdin on /dev/null and no other fd of root's.
      const loop = root(name, `ps -o ppid= -p ${pid}`).out.trim();
      const stat = root(name, `cat /proc/${loop}/stat`).out;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      expect([user, fields[1], fields[3]]).toEqual([user, "1", loop]);
      const fds = sh(
        name,
        user,
        `for f in /proc/${loop}/fd/*; do echo "\${f##*/} $(readlink $f)"; done`,
      )
        .out.split("\n")
        .filter(Boolean);
      for (const line of fds) {
        const [fd, target] = line.split(" ");
        if (fd === "255") continue; // bash's own fd on the loop script
        expect([user, fd, target]).toEqual([user, fd, "/dev/null"]);
      }
      // It starts in its home, as the member, not in a folder root chose.
      expect(sh(name, user, `readlink /proc/${pid}/cwd`).out.trim()).toBe(
        `${MEMBERS}/home/${user}`,
      );
    }
  });

  it("answers only the office, with the member's uid, a fixed environment and the hash of runtime/current", () => {
    for (const user of [ALICE, BOB]) {
      const hash = root(
        name,
        `readlink ${MEMBERS}/share/${user}/runtime/current`,
      ).out.trim();
      const [info] = runnerRequest(name, "node", socketOf(user), {
        op: "info",
      }) as {
        uid: number;
        bundleHash: string;
        env: Record<string, string>;
      }[];
      expect(info.uid).toBe(uidOf(name, user));
      expect(info.bundleHash).toBe(hash);
      // L1: what the loop got from root, plus what bash and the loop add.
      expect(Object.keys(info.env).sort()).toEqual(
        [
          "HOME",
          "LANG",
          "LOGNAME",
          "PATH",
          "PWD",
          "SHELL",
          "SHLVL",
          "TMPDIR",
          "USER",
          "_",
        ].sort(),
      );
      expect(JSON.stringify(info.env)).not.toContain(CANARY);
      expect(info.env.TMPDIR).toBe(`${MEMBERS}/home/${user}/.tmp`);
      // The member itself, root and the other member get no answer.
      for (const other of [user, "0", user === ALICE ? BOB : ALICE])
        expect([
          other,
          runnerRequest(name, other, socketOf(user), { op: "info" }),
        ]).toEqual([other, []]);
    }
  });

  it("keeps a member's shell out of the office, admin.sock and the other member", () => {
    const denied = {
      "the office home": `os.listdir("/var/data/home")`,
      "the state": `open("${STATE}/users.json").read()`,
      "the workspaces": `os.listdir("/var/data/workspaces")`,
      "the other member's home": `os.listdir("${MEMBERS}/home/${BOB}")`,
      "the other member's share": `os.listdir("${MEMBERS}/share/${BOB}")`,
      "users.json for writing": `open("${MEMBERS}/users.json", "a")`,
      "the marks": `os.listdir("${MEMBERS}/etc") and open("${MEMBERS}/etc/${ALICE}.made").read()`,
      "admin.sock": `socket.socket(socket.AF_UNIX).connect("${STATE}/admin.sock")`,
    };
    for (const [what, op] of Object.entries(denied))
      expect([what, tryAs(name, ALICE, op)]).toEqual([what, "EACCES"]);
    // Its own share it reads but does not change.
    expect(tryAs(name, ALICE, `os.listdir("${MEMBERS}/share/${ALICE}")`)).toBe(
      "ok",
    );
    expect(tryAs(name, ALICE, `open("${MEMBERS}/share/${ALICE}/x", "w")`)).toBe(
      "EACCES",
    );
  });

  it("refuses a runner that another uid serves on the member's socket", () => {
    const aliceUid = uidOf(name, ALICE);
    expect(
      root(
        name,
        `python3 -I /opt/isomux/deploy/container/member-users.py stop ${ALICE}`,
      ).status,
    ).toBe(0);
    // Bob's runtime on Alice's socket path: the uid behind it is Bob's.
    const bobShare = `${MEMBERS}/share/${BOB}/runtime/current`;
    expect(
      root(
        name,
        `chown ${BOB} /run/isomux-runner-${ALICE} && rm -f ${socketOf(ALICE)} && (setpriv --reuid ${BOB} --regid ${BOB} --clear-groups --no-new-privs -- ${bobShare}/bun ${bobShare}/runner.js runner --socket ${socketOf(ALICE)} --server-uid ${OFFICE_UID} --socket-mode 0666 </dev/null >/dev/null 2>&1 &) && for i in $(seq 40); do test -S ${socketOf(ALICE)} && break; sleep 0.25; done; test -S ${socketOf(ALICE)}`,
      ).status,
    ).toBe(0);
    const refused = admin(name, "go-on", {
      member: alice,
      osUser: ALICE,
      uid: aliceUid,
    });
    expect(refused.ready).toBe(false);
    expect(String(refused.reason)).toContain(String(aliceUid));
    // The record stays: Alice's agents do not move to the office's user.
    expect(admin(name, "info", { member: alice }).state).toBe("isolated");
    expect(
      root(
        name,
        `pkill -KILL -u ${BOB} -f 'runner --socket ${socketOf(ALICE)}'`,
      ).status,
    ).toBe(0);
    expect(
      root(
        name,
        `python3 -I /opt/isomux/deploy/container/member-users.py start ${ALICE}`,
      ).status,
    ).toBe(0);
    expect(
      admin(name, "go-on", { member: alice, osUser: ALICE, uid: aliceUid }),
    ).toMatchObject({ ready: true });
  });

  // The office repairs a runtime folder at its install, so the entry goes on
  // the share itself, which the check reads before any install.
  it("refuses a share with a named-user ACL entry that lets the member write", () => {
    const aliceUid = uidOf(name, ALICE);
    const share = `${MEMBERS}/share/${ALICE}`;
    expect(root(name, `setfacl -m u:${ALICE}:rwx ${share}`).status).toBe(0);
    try {
      const refused = admin(name, "go-on", {
        member: alice,
        osUser: ALICE,
        uid: aliceUid,
      });
      expect(refused.ready).toBe(false);
      expect(String(refused.reason)).toContain(share);
      // The entry is real: the member's write goes through.
      expect(tryAs(name, ALICE, `open("${share}/planted", "w").close()`)).toBe(
        "ok",
      );
    } finally {
      root(name, `setfacl -b ${share}; rm -f ${share}/planted`);
    }
    expect(root(name, `stat -c %a ${share}`).out.trim()).toBe("2750");
    expect(
      admin(name, "go-on", { member: alice, osUser: ALICE, uid: aliceUid }),
    ).toMatchObject({ ready: true });
  });

  it("restarts the runner after the exit op, as the unit's Restart=always does", async () => {
    const before = runnerPid(name, ALICE);
    runnerRequest(name, "node", socketOf(ALICE), { op: "exit" });
    await waitFor(
      "a new runner",
      () => {
        const now = runnerPid(name, ALICE);
        return now !== "" && now !== before;
      },
      30_000,
    );
    await waitFor(
      "the runner socket",
      () =>
        Array.isArray(
          runnerRequest(name, "node", socketOf(ALICE), { op: "info" }),
        ) &&
        (
          runnerRequest(name, "node", socketOf(ALICE), {
            op: "info",
          }) as unknown[]
        ).length === 1,
    );
  });

  it("opens a terminal panel of the member's agent as the member", () => {
    const invite = api(name, cookie, "POST", "/api/invites", { userId: alice });
    const token = /\/i\/([^/?#"\s]+)/.exec(JSON.stringify(invite))?.[1];
    expect(token).toBeTruthy();
    const accepted = root(
      name,
      `curl -s -i -X POST http://127.0.0.1:10000/auth/accept -H 'Host: ${HOST}' -H 'Origin: ${ORIGIN}' --data-urlencode 'token=${token}' --data-urlencode 'name=Alice'`,
    );
    aliceCookie =
      /set-cookie: (__Host-isomux_session_[0-9a-f]{12}=[^;]+)/i.exec(
        accepted.out,
      )?.[1] ?? "";
    expect(aliceCookie).toBeTruthy();
    const made = api(name, aliceCookie, "POST", "/api/agents", {
      name: "Rig Alice",
      cwd: `${MEMBERS}/home/${ALICE}`,
      roomId,
      desk: 1,
      agentType: "claude",
    });
    const agentId = (made.agent as { id: string } | undefined)?.id;
    expect(JSON.stringify(made)).toContain('"agent"');
    const r = run(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        `RIG_ARGS=${JSON.stringify([aliceCookie, agentId, HOST, ORIGIN])}`,
        name,
        "bun",
        "-",
      ],
      TERMINAL,
    );
    expect(JSON.parse(r.out.trim())).toEqual({ uid: uidOf(name, ALICE) });
  });

  // Slice 1c-i: the member's engines keep their files in the member's own
  // space (<home>/.isomux-agent, and ~/.claude in the member's home), Codex
  // resumes its thread there after a restart, and the office's agent space
  // gains nothing.
  it("runs the member's Claude and Codex sessions in their own space, and resumes Codex after a restart", async () => {
    const home = `${MEMBERS}/home/${ALICE}`;
    const space = `${home}/.isomux-agent`;
    const aliceUid = String(uidOf(name, ALICE));
    // A key in the member's own variables: the stubs need no sign-in, the
    // office's checks see one.
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      api(name, cookie, "PUT", `/api/users/Alice/env/${key}`, {
        value: "rig-key",
      });
    // The office's own OpenCode profiles change at boot (model discovery):
    // the member's profile is checked by its name below.
    const officeSpace = [
      `${STATE}/provider-homes`,
      `${STATE}/codex-home`,
      `${STATE}/codex`,
      "/var/data/home/.claude",
    ].join(" ");
    const officeFiles = () =>
      root(name, `find ${officeSpace} -type f 2>/dev/null | sort`).out;
    const before = officeFiles();
    const spawn = (agentType: string, desk: number, modelFamily?: string) => {
      const made = api(name, aliceCookie, "POST", "/api/agents", {
        name: `Rig Alice ${agentType}`,
        cwd: home,
        roomId,
        desk,
        agentType,
        ...(modelFamily ? { modelFamily } : {}),
      });
      const id = (made.agent as { id: string } | undefined)?.id;
      if (!id) throw new Error(`spawn ${agentType}: ${JSON.stringify(made)}`);
      return id;
    };
    const send = (agentId: string, text: string) =>
      api(name, aliceCookie, "POST", `/api/agents/${agentId}/messages`, {
        text,
      });
    const reports = async (agentId: string, count: number) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const found = root(
          name,
          `cat ${STATE}/logs/${agentId}/*.jsonl 2>/dev/null`,
        )
          .out.split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind: string; content: string })
          .filter(
            (l) =>
              l.kind === "text" &&
              typeof l.content === "string" &&
              l.content.startsWith("RIG_REPORT "),
          )
          .map(
            (l) =>
              JSON.parse(l.content.slice("RIG_REPORT ".length)) as Record<
                string,
                unknown
              >,
          );
        if (found.length >= count || Date.now() > deadline) return found;
        await Bun.sleep(250);
      }
    };

    const agents = {
      claude: spawn("claude", 2),
      codex: spawn("codex", 3, "gpt-rig"),
    };
    // The OpenCode stub does not start in this rig, for the office either
    // (its server fails at startup), so only its profile folder is checked:
    // the member's, in their space.
    const openCode = spawn("opencode", 4, "rig/stub");
    send(openCode, "one");
    await waitFor(
      "the member's OpenCode profile",
      () =>
        root(
          name,
          `stat -c %u ${space}/opencode/profiles/*/opencode.json 2>/dev/null`,
        ).out.trim() === aliceUid,
    );
    for (const id of Object.values(agents)) send(id, "one");
    const first: Record<string, Record<string, unknown>> = {};
    for (const [engine, id] of Object.entries(agents)) {
      [first[engine]] = await reports(id, 1);
      expect([engine, first[engine]?.uid]).toEqual([engine, aliceUid]);
    }
    expect(
      String(first.claude.transcript).startsWith(`${home}/.claude/projects/`),
    ).toBe(true);
    expect(first.codex.codexHome).toBe(`${space}/codex-home`);
    // Each engine's folders in the member's space are the member's.
    for (const dir of [
      `${space}/codex-home`,
      `${space}/opencode/profiles`,
      `${home}/.claude/projects`,
    ])
      expect([dir, root(name, `stat -c %u ${dir}`).out.trim()]).toEqual([
        dir,
        aliceUid,
      ]);
    expect(root(name, `stat -c '%u %a' ${space}`).out.trim()).toBe(
      `${aliceUid} 700`,
    );

    // A restart: each session resumes from the member's space.
    const restartedAt = new Date().toISOString();
    expect(run("docker", ["restart", name]).status).toBe(0);
    await office(name);
    await waitFor("Alice connected after the restart", () => {
      const r = run("docker", ["logs", "--since", restartedAt, name]);
      return (r.out + r.err).includes(
        `[member-hosts] ${alice} runs as ${ALICE}`,
      );
    });
    for (const id of Object.values(agents)) send(id, "two");
    for (const [engine, id] of Object.entries(agents)) {
      const all = await reports(id, 2);
      expect([engine, all.length]).toEqual([engine, 2]);
      expect([engine, all[1].uid]).toEqual([engine, aliceUid]);
    }
    // Claude's resume is not proven here: the stub starts a new session
    // after a restart for an office agent too. Its second turn still runs
    // in the member's space.
    const claudeTurns = await reports(agents.claude, 2);
    for (const turn of claudeTurns)
      expect(
        String(turn.transcript).startsWith(`${home}/.claude/projects/`),
      ).toBe(true);
    const codexSecond = (await reports(agents.codex, 2))[1];
    expect(codexSecond.threadId).toBe(first.codex.threadId);
    expect(officeFiles()).toBe(before);
    const profile = root(name, `ls ${space}/opencode/profiles`).out.trim();
    expect(profile).toMatch(/^[0-9a-f]{16}$/);
    expect(
      root(name, `test -e ${STATE}/opencode/profiles/${profile}`).status,
    ).toBe(1);
  });

  // Slice 1c-ii-a: the move on enable. A member's agents run as the office
  // first; enable moves their conversations into their space.
  const cookieOf = (memberId: string, who: string): string => {
    const invite = api(name, cookie, "POST", "/api/invites", {
      userId: memberId,
    });
    const token = /\/i\/([^/?#"\s]+)/.exec(JSON.stringify(invite))?.[1];
    if (!token) throw new Error(`no invite for ${who}`);
    const accepted = root(
      name,
      `curl -s -i -X POST http://127.0.0.1:10000/auth/accept -H 'Host: ${HOST}' -H 'Origin: ${ORIGIN}' --data-urlencode 'token=${token}' --data-urlencode 'name=${who}'`,
    );
    const found =
      /set-cookie: (__Host-isomux_session_[0-9a-f]{12}=[^;]+)/i.exec(
        accepted.out,
      )?.[1];
    if (!found) throw new Error(`no cookie for ${who}`);
    return found;
  };
  const reportsOf = async (agentId: string, count: number) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const found = root(
        name,
        `cat ${STATE}/logs/${agentId}/*.jsonl 2>/dev/null`,
      )
        .out.split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              content: string;
              timestamp: number;
            },
        )
        .filter(
          (l) =>
            l.kind === "text" &&
            typeof l.content === "string" &&
            l.content.startsWith("RIG_REPORT "),
        )
        // An agent's log is one file per session: order by time, not file.
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(
          (l) =>
            JSON.parse(l.content.slice("RIG_REPORT ".length)) as Record<
              string,
              unknown
            >,
        );
      if (found.length >= count || Date.now() > deadline) return found;
      await Bun.sleep(250);
    }
  };
  // A member with a key in their own variables and an agent per engine, run
  // once as the office (cwd /tmp: both users reach it).
  const officeMember = async (who: string, engines: string[]) => {
    const id = member(name, cookie, who, [roomId]);
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      api(name, cookie, "PUT", `/api/users/${who}/env/${key}`, {
        value: "rig-key",
      });
    const theirCookie = cookieOf(id, who);
    const agents: Record<string, string> = {};
    engines.forEach((agentType) => {
      const made = api(name, theirCookie, "POST", "/api/agents", {
        name: `Rig ${who} ${agentType}`,
        cwd: "/tmp",
        roomId,
        desk: null,
        agentType,
        ...(agentType === "codex" ? { modelFamily: "gpt-rig" } : {}),
      });
      const agentId = (made.agent as { id: string } | undefined)?.id;
      if (!agentId)
        throw new Error(`spawn ${who} ${agentType}: ${JSON.stringify(made)}`);
      agents[agentType] = agentId;
    });
    const send = (agentId: string, text: string) =>
      api(name, theirCookie, "POST", `/api/agents/${agentId}/messages`, {
        text,
      });
    const first: Record<string, Record<string, unknown>> = {};
    for (const agentId of Object.values(agents)) send(agentId, "one");
    for (const [engine, agentId] of Object.entries(agents)) {
      [first[engine]] = await reportsOf(agentId, 1);
      expect([who, engine, first[engine]?.uid]).toEqual([
        who,
        engine,
        String(OFFICE_UID),
      ]);
    }
    return { id, agents, send, first };
  };
  const OFFICE = String(OFFICE_UID);
  const sessionOf = (transcript: unknown) =>
    /([0-9a-f-]{36})\.jsonl$/.exec(String(transcript))?.[1] ?? "";

  it("moves a member's office conversations into their space at enable, and they resume there", async () => {
    const erinUser = "isomux-erin";
    const erinHome = `${MEMBERS}/home/${erinUser}`;
    const space = `${erinHome}/.isomux-agent`;
    const {
      id: erin,
      agents,
      send,
      first,
    } = await officeMember("Erin", ["claude", "codex"]);
    const sid = sessionOf(first.claude.transcript);
    expect(String(first.claude.transcript)).toBe(
      `/var/data/home/.claude/projects/-tmp/${sid}.jsonl`,
    );
    // The stub's report has no thread id: the sessions map is keyed by it.
    const codexThreads = () =>
      Object.keys(
        JSON.parse(
          root(name, `cat ${STATE}/logs/${agents.codex}/sessions.json`).out,
        ) as object,
      );
    const [threadId] = codexThreads();
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    // The Codex stub writes no rollout: one where Codex keeps it.
    const rolloutRel = `sessions/2026/11/15/rollout-2026-11-15T10-00-00-${threadId}.jsonl`;
    const officeRollout = `${first.codex.codexHome}/${rolloutRel}`;
    sh(
      name,
      OFFICE,
      `mkdir -p $(dirname ${officeRollout}) && printf '{"rig":"rollout"}\\n' > ${officeRollout}`,
    );
    // Erin's personal home in the office: her file, and a link and a hard
    // link to a file only the office may read.
    const officeHome = `${STATE}/provider-homes/${erin}/claude`;
    const secret = `${STATE}/rig-office-only.txt`;
    sh(
      name,
      OFFICE,
      `printf 'RIG-OFFICE-ONLY' > ${secret} && chmod 600 ${secret} && mkdir -p ${officeHome} && printf 'ERIN' > ${officeHome}/kept.txt && ln -s ${secret} ${officeHome}/leak && ln ${secret} ${officeHome}/hard`,
    );

    const enabled = command(name, "enable", "Erin");
    if (enabled.status !== 0) throw new Error(`enable Erin: ${enabled.err}`);
    const erinUid = String(uidOf(name, erinUser));
    const ownerOf = (path: string) =>
      root(name, `stat -c %u ${path}`).out.trim();

    // The Claude transcript is in her root, hers, and pinned there; the
    // office copy is gone.
    const moved = `${erinHome}/.claude/projects/-tmp/${sid}.jsonl`;
    expect(ownerOf(moved)).toBe(erinUid);
    expect(root(name, `test -e ${first.claude.transcript}`).status).toBe(1);
    const sessions = JSON.parse(
      root(name, `cat ${STATE}/logs/${agents.claude}/sessions.json`).out,
    ) as Record<string, { claudeConfigDir?: string }>;
    expect(sessions[sid]?.claudeConfigDir).toBe(`${erinHome}/.claude`);
    // The rollout is in her Codex home; the office copy is gone.
    expect(ownerOf(`${space}/codex-home/${rolloutRel}`)).toBe(erinUid);
    expect(root(name, `test -e ${officeRollout}`).status).toBe(1);
    // Her file moved; neither link carried the office's file, and the
    // office's file is still there.
    const landedHome = `${space}/provider-homes/${erin}/claude`;
    expect(root(name, `cat ${landedHome}/kept.txt`).out).toBe("ERIN");
    expect(ownerOf(`${landedHome}/kept.txt`)).toBe(erinUid);
    expect(root(name, `grep -rl RIG-OFFICE-ONLY ${erinHome}`).out).toBe("");
    expect(
      root(name, `ls -A ${landedHome}`).out.trim().split("\n").sort(),
    ).toEqual(["kept.txt"]);
    expect(root(name, `cat ${secret}`).out).toBe("RIG-OFFICE-ONLY");
    expect(root(name, `test -e ${officeHome}/kept.txt`).status).toBe(1);
    expect(root(name, `ls -A ${space}/.move-in 2>/dev/null`).out).toBe("");

    // The same conversations go on as Erin.
    for (const agentId of Object.values(agents)) send(agentId, "two");
    const claudeTwo = (await reportsOf(agents.claude, 2))[1];
    const codexTwo = (await reportsOf(agents.codex, 2))[1];
    expect([claudeTwo?.uid, codexTwo?.uid]).toEqual([erinUid, erinUid]);
    // The Claude stub starts a new session after its process ends, for an
    // office agent too, so the resume of the moved transcript is proven by
    // its pin above; the new turn runs in her root.
    expect(
      String(claudeTwo.transcript).startsWith(`${erinHome}/.claude/projects/`),
    ).toBe(true);
    // The same thread resumed: no new one in the sessions map.
    expect(codexThreads()).toEqual([threadId]);
    expect(codexTwo.codexHome).toBe(`${space}/codex-home`);
  });

  it("keeps the office copy and undoes the member's side when the place meets a file of theirs", async () => {
    const frankUser = "isomux-frank";
    const frankHome = `${MEMBERS}/home/${frankUser}`;
    const space = `${frankHome}/.isomux-agent`;
    const frank = member(name, cookie, "Frank", [roomId]);
    // An enable with nothing to move makes the user; the admin verb then
    // drops the record and leaves the user and runner.
    expect(command(name, "enable", "Frank").status).toBe(0);
    const frankUid = uidOf(name, frankUser);
    expect(admin(name, "disable", { member: frank }).ok).toBe(true);
    // Frank's next conversation runs as the office.
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      api(name, cookie, "PUT", `/api/users/Frank/env/${key}`, {
        value: "rig-key",
      });
    const frankCookie = cookieOf(frank, "Frank");
    const made = api(name, frankCookie, "POST", "/api/agents", {
      name: "Rig Frank claude",
      cwd: "/tmp",
      roomId,
      desk: null,
      agentType: "claude",
    });
    const agentId = (made.agent as { id: string }).id;
    api(name, frankCookie, "POST", `/api/agents/${agentId}/messages`, {
      text: "one",
    });
    const [first] = await reportsOf(agentId, 1);
    expect(first?.uid).toBe(OFFICE);
    const sid = sessionOf(first.transcript);
    const officeHome = `${STATE}/provider-homes/${frank}/claude`;
    sh(
      name,
      OFFICE,
      `mkdir -p ${officeHome} && printf 'X' > ${officeHome}/x.txt`,
    );
    // A file of Frank's own where the transcript would go.
    const dest = `${frankHome}/.claude/projects/-tmp/${sid}.jsonl`;
    sh(
      name,
      frankUser,
      `mkdir -p $(dirname ${dest}) && printf 'DAVE-OWN' > ${dest}`,
    );

    const answer = admin(name, "go-on", {
      member: frank,
      osUser: frankUser,
      uid: frankUid,
    });
    expect(answer.ok).toBe(false);
    expect(admin(name, "info", { member: frank }).state).toBe("none");
    expect(root(name, `cat ${dest}`).out).toBe("DAVE-OWN");
    // The tree file placed before the conflict is undone; the office keeps
    // its copies.
    expect(
      root(name, `test -e ${space}/provider-homes/${frank}/claude/x.txt`)
        .status,
    ).toBe(1);
    expect(root(name, `cat ${officeHome}/x.txt`).out).toBe("X");
    expect(root(name, `test -f ${first.transcript}`).status).toBe(0);
    // Frank's agent runs again, as the office.
    api(name, frankCookie, "POST", `/api/agents/${agentId}/messages`, {
      text: "two",
    });
    const after = await reportsOf(agentId, 2);
    expect(after[1]?.uid).toBe(OFFICE);
  });

  it("disable --delete-user deletes nothing of a user this command did not make for the member", () => {
    const mark = `${MEMBERS}/etc/${BOB}.made`;
    const original = root(name, `cat ${mark}`).out;
    root(name, `printf 'u-someone-else\\n' > ${mark}`);
    try {
      const r = command(name, "disable", "Bob", "--delete-user");
      expect(r.status).toBe(1);
      expect(root(name, `id -u ${BOB}`).status).toBe(0);
      expect(
        root(
          name,
          `test -d ${MEMBERS}/home/${BOB} && test -d ${MEMBERS}/share/${BOB}`,
        ).status,
      ).toBe(0);
      expect(
        JSON.parse(root(name, `cat ${MEMBERS}/users.json`).out)[BOB],
      ).toBeTruthy();
      expect(admin(name, "info", { member: bob }).state).toBe("isolated");
      expect(runnerPid(name, BOB)).not.toBe("");
    } finally {
      root(name, `printf '%s' '${original}' > ${mark}`);
    }
  });

  it("disable stops every process of the member and keeps the uid reserved", () => {
    // A process the member started outside the runner.
    sh(name, BOB, "setsid sleep 1000 </dev/null >/dev/null 2>&1 &");
    expect(root(name, `pgrep -u ${BOB} -x sleep`).status).toBe(0);
    const uid = uidOf(name, BOB);
    expect(command(name, "disable", "Bob").status).toBe(0);
    expect(root(name, `pgrep -u ${BOB}`).out).toBe("");
    expect(
      JSON.parse(root(name, `cat ${MEMBERS}/users.json`).out)[BOB],
    ).toEqual({
      uid,
      gid: uid,
      locked: true,
    });
    expect(root(name, `test -e ${MEMBERS}/share/${BOB}`).status).toBe(1);
    expect(admin(name, "info", { member: bob }).state).toBe("none");
  });

  it("brings the members back at a restart: Alice running and connected, Bob locked with no process", async () => {
    const aliceUid = uidOf(name, ALICE);
    const bobUid = uidOf(name, BOB);
    expect(run("docker", ["restart", name]).status).toBe(0);
    const ms = await office(name);
    await waitFor("Alice's runner", () => runnerPid(name, ALICE) !== "");
    // connectMemberHosts at boot: Alice's host is connected without a go-on.
    const connected = await waitFor(
      "Alice connected at boot",
      () =>
        run("docker", ["logs", name]).out.includes(
          `[member-hosts] ${alice} runs as ${ALICE}`,
        ) ||
        run("docker", ["logs", name]).err.includes(
          `[member-hosts] ${alice} runs as ${ALICE}`,
        ),
    );
    console.log(
      `office up ${ms} ms after the restart; Alice connected ${connected} ms later`,
    );
    expect(uidOf(name, ALICE)).toBe(aliceUid);
    expect(uidOf(name, BOB)).toBe(bobUid);
    expect(root(name, `passwd -S ${BOB}`).out.split(" ")[1]).toBe("L");
    expect(root(name, `pgrep -u ${BOB}`).out).toBe("");
    expect(run("docker", ["logs", name]).err).not.toContain("[member-users]");
  });

  it("gives a new member a uid above the locked one", () => {
    const bobUid = uidOf(name, BOB);
    member(name, cookie, "Carol");
    expect(command(name, "enable", "Carol").status).toBe(0);
    expect(uidOf(name, "isomux-carol")).toBeGreaterThan(bobUid);
  });

  it("brings the members back in a new container on the same volume", async () => {
    const aliceUid = uidOf(name, ALICE);
    expect(run("docker", ["rm", "-f", name]).status).toBe(0);
    expect(
      run("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "isomux.split-rig=1",
        "-e",
        "ISOMUX_MEMBER_USERS_RIG=1",
        "-e",
        `ISOMUX_RIG_CANARY=${CANARY}`,
        "-e",
        `ISOMUX_PUBLIC_URL=${ORIGIN}`,
        "-e",
        `ISOMUX_SETUP_KEY=${KEY}`,
        "-v",
        `${name}-data:/var/data`,
        TAG,
      ]).status,
    ).toBe(0);
    await office(name);
    await waitFor("Alice's runner", () => runnerPid(name, ALICE) !== "");
    expect(uidOf(name, ALICE)).toBe(aliceUid);
    expect(root(name, `passwd -S ${BOB}`).out.split(" ")[1]).toBe("L");
  });

  it("starts no member but still the office when users.json can be changed by others", async () => {
    root(name, `chmod 664 ${MEMBERS}/users.json`);
    expect(run("docker", ["restart", name]).status).toBe(0);
    await office(name);
    expect(root(name, `id -u ${ALICE}`).status).toBe(0); // passwd survives a restart
    expect(runnerPid(name, ALICE)).toBe("");
    const logs = run("docker", ["logs", name]);
    expect(logs.out + logs.err).toContain(
      "[member-users] no member user starts",
    );
    root(name, `chmod 644 ${MEMBERS}/users.json`);
  });
});

describe.skipIf(!ENABLED)("the command inside the container", () => {
  afterAll(stopAll);

  it("uses the container conf even when the host's update.conf is mounted", async () => {
    const name = `${PREFIX}-conf`;
    started.push(name);
    run("bash", [RIG, "stop", name]);
    const conf = run("mktemp", []).out.trim();
    await Bun.write(
      conf,
      "SERVICE_USER=isomux\nSTATE_ROOT=/var/lib/isomux\nSERVICE_KIND=system\nDEPLOYMENT_KIND=container\n",
    );
    try {
      expect(
        run("docker", [
          "run",
          "-d",
          "--name",
          name,
          "--label",
          "isomux.split-rig=1",
          "-e",
          "ISOMUX_MEMBER_USERS_RIG=1",
          "-e",
          `ISOMUX_PUBLIC_URL=${ORIGIN}`,
          "-e",
          `ISOMUX_SETUP_KEY=${KEY}`,
          "-v",
          `${name}-data:/var/data`,
          "-v",
          `${conf}:/etc/isomux/update.conf:ro`,
          TAG,
        ]).status,
      ).toBe(0);
      const cookie = await claim(name);
      member(name, cookie, "Dana");
      const r = command(name, "enable", "Dana");
      expect([r.status, r.err]).toEqual([0, ""]);
    } finally {
      run("rm", ["-f", conf]);
    }
  });
});
