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
const [cookie, agentId, host, origin, waitMs] = JSON.parse(process.env.RIG_ARGS);
const ws = new WebSocket("ws://127.0.0.1:10000/ws", { headers: { Cookie: cookie, Host: host, Origin: origin } });
let out = "";
const finish = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
setTimeout(() => finish({ timeout: true, out }), waitMs ?? 30000);
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

// An office client in the container: what a member's open_log of an agent
// replays, from the office's memory (a turn that never started writes no
// log file): the names in its slash menu, and its error and system lines.
const OPEN_LOG = `
const [cookie, agentId, host, origin] = JSON.parse(process.env.RIG_ARGS);
const ws = new WebSocket("ws://127.0.0.1:10000/ws", { headers: { Cookie: cookie, Host: host, Origin: origin } });
const names = new Set();
const entries = [];
const finish = () => { console.log(JSON.stringify({ names: [...names], entries })); process.exit(0); };
setTimeout(finish, 10000);
ws.onopen = () => ws.send(JSON.stringify({ type: "open_log", agentId, requestId: "rig-open-log" }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "slash_commands" && msg.agentId === agentId) {
    for (const c of msg.commands ?? []) names.add(c.name);
    for (const s of msg.skills ?? []) names.add(s.name);
  }
  if (msg.type === "log_entry" && msg.entry?.agentId === agentId && (msg.entry.kind === "error" || msg.entry.kind === "system")) {
    const e = msg.entry;
    entries.push({ timestamp: e.timestamp, text: typeof e.content === "string" ? e.content : JSON.stringify(e.message ?? e.content) });
  }
  if (msg.type === "log_replay_complete") finish();
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

  // Slice 2c: Alice reaches no process or file of an agent that runs as the
  // office user. The owner's terminal on the office agent opens as the
  // office user (the enabling condition); Alice's gets no output, and her
  // editor open and save are refused before any file is touched.
  it("keeps a member out of an office agent's terminal and editor", () => {
    const made = api(name, cookie, "POST", "/api/agents", {
      name: "Rig office agent",
      roomId,
      desk: 7,
      agentType: "claude",
    });
    const officeAgent = (made.agent as { id: string } | undefined)?.id;
    if (!officeAgent) throw new Error(`spawn: ${JSON.stringify(made)}`);
    const terminal = (who: string, waitMs: number) =>
      JSON.parse(
        run(
          "docker",
          [
            "exec",
            "-i",
            "-e",
            `RIG_ARGS=${JSON.stringify([who, officeAgent, HOST, ORIGIN, waitMs])}`,
            name,
            "bun",
            "-",
          ],
          TERMINAL,
        ).out.trim(),
      ) as unknown;
    expect(terminal(cookie, 30000)).toEqual({ uid: OFFICE_UID });
    expect(terminal(aliceCookie, 8000)).toEqual({ timeout: true, out: "" });

    const target = "/var/data/rig-reach.txt";
    const opened = api(
      name,
      aliceCookie,
      "GET",
      `/api/agents/${officeAgent}/file?path=${encodeURIComponent("/etc/hostname")}`,
      undefined,
    );
    expect((opened.error as { code?: string } | undefined)?.code).toBe(
      "member_reach",
    );
    const saved = api(
      name,
      aliceCookie,
      "PUT",
      `/api/agents/${officeAgent}/file`,
      { path: target, content: "alice", mtime: 0 },
    );
    expect((saved.error as { code?: string } | undefined)?.code).toBe(
      "member_reach",
    );
    expect(root(name, `test -e ${target}`).status).not.toBe(0);
    api(name, cookie, "DELETE", `/api/agents/${officeAgent}`, {});
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
    // Slice 2d-i: the member's Codex ran the Isomux hook from their runtime
    // in the share (the stub runs the command hooks.json names), as the
    // member, and the hook refused the stub's "rm -rf /". The office wrote
    // the hook and the member cannot change it; their runner wrote the
    // configuration.
    const hookPath = `${MEMBERS}/share/${ALICE}/runtime/current/bin/isomux-codex-safety-hook`;
    const hook = first.codex.hook as {
      command: string;
      exitCode: number;
      stdout: string;
    } | null;
    expect(hook?.command).toBe(hookPath);
    expect(hook?.exitCode).toBe(0);
    expect(JSON.parse(hook?.stdout ?? "null")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(root(name, `stat -L -c '%F %u %a' ${hookPath}`).out.trim()).toBe(
      `regular file ${OFFICE_UID} 755`,
    );
    expect(tryAs(name, ALICE, `open("${hookPath}", "r+")`)).toBe("EACCES");
    for (const file of ["hooks.json", "config.toml"])
      expect([
        file,
        root(name, `stat -c %u ${space}/codex-home/${file}`).out.trim(),
      ]).toEqual([file, aliceUid]);
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
    expect((codexSecond.hook as { command?: string } | null)?.command).toBe(
      hookPath,
    );
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

  // Slice 2a: a file that the member's agent names is read as the member. A
  // file only the office can read, in a folder the member can reach by path,
  // is refused at every surface; the member's own file is read. The agent
  // calls the office with its own token (the stub's RIG_CALL).
  it("reads the files that a member's agent names as the member, and never a file only the office can read", async () => {
    const home = `${MEMBERS}/home/${ALICE}`;
    const office = "/var/data/rig-files";
    const SECRET = "member-rig-office-only";
    root(
      name,
      `mkdir -p ${office} && chmod 0755 ${office} && printf ${SECRET} > ${office}/office.txt && printf ${SECRET} > ${office}/office.mp4 && chown -R ${OFFICE_UID} ${office} && chmod 0600 ${office}/office.txt ${office}/office.mp4`,
    );
    expect(
      sh(
        name,
        ALICE,
        `printf mine-notes > ${home}/rig-notes.txt && printf 0123456789 > ${home}/rig-clip.mp4`,
      ).status,
    ).toBe(0);
    // The condition: the member can stat the office's files but not read them.
    expect(sh(name, ALICE, `cat ${office}/office.txt`).status).not.toBe(0);
    expect(sh(name, ALICE, `stat -c %s ${office}/office.mp4`).out.trim()).toBe(
      String(SECRET.length),
    );
    const made = api(name, aliceCookie, "POST", "/api/agents", {
      name: "Rig Alice files",
      cwd: home,
      roomId,
      desk: 5,
      agentType: "claude",
    });
    const agentId = (made.agent as { id: string } | undefined)?.id;
    if (!agentId) throw new Error(`spawn: ${JSON.stringify(made)}`);
    let turns = 0;
    const call = async (path: string, body: unknown) => {
      api(name, aliceCookie, "POST", `/api/agents/${agentId}/messages`, {
        text: `RIG_CALL ${JSON.stringify({ method: "POST", path, body })}`,
      });
      turns++;
      const report = (await reportsOf(agentId, turns))[turns - 1];
      return report?.call as { status: number; body: string } | undefined;
    };
    const officeHas = (text: string) =>
      root(name, `grep -rl ${text} ${STATE} 2>/dev/null | head -1`).out.trim();

    expect(
      (
        await call(`/api/agents/${agentId}/read-file`, {
          path: `${home}/rig-notes.txt`,
        })
      )?.status,
    ).toBe(200);
    expect(officeHas("mine-notes")).not.toBe("");
    // Each refusal is a system line of the agent's chat that names the file.
    const refusals = () =>
      root(name, `cat ${STATE}/logs/${agentId}/*.jsonl 2>/dev/null`)
        .out.split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; content: unknown })
        .filter(
          (l) =>
            l.kind === "system" &&
            String(l.content).includes(`${office}/office.txt`),
        ).length;
    expect(
      (
        await call(`/api/agents/${agentId}/read-file`, {
          path: `${office}/office.txt`,
        })
      )?.status,
    ).toBe(200);
    expect(refusals()).toBe(1);
    expect(
      (
        await call(`/api/agents/${agentId}/edit-file`, {
          path: `${office}/office.txt`,
        })
      )?.status,
    ).toBe(200);
    expect(refusals()).toBe(2);

    const asked = await call(`/api/agents/${agentId}/asks`, {
      text: "Look?",
      readFiles: [`${home}/rig-clip.mp4`, `${office}/office.mp4`],
    });
    expect(asked?.status).toBe(201);
    const ask = JSON.parse(asked!.body) as {
      id: string;
      readFiles: { filename: string; path: string }[];
    };
    const fetched = (path: string) => {
      const file = ask.readFiles.find((f) => f.path === path)!;
      const r = root(
        name,
        `curl -s -H 'Host: ${HOST}' -H 'Origin: ${ORIGIN}' -H 'Cookie: ${aliceCookie}' -H 'Range: bytes=3-5' -w '\\n%{http_code}' http://127.0.0.1:10000/api/asks/${ask.id}/files/${file.filename}`,
      ).out;
      const nl = r.lastIndexOf("\n");
      return { status: Number(r.slice(nl + 1)), body: r.slice(0, nl) };
    };
    expect(fetched(`${home}/rig-clip.mp4`)).toEqual({
      status: 206,
      body: "345",
    });
    expect(fetched(`${office}/office.mp4`).status).toBe(404);
    // Nothing of the office-only file reached the office's state.
    expect(officeHas(SECRET)).toBe("");
    root(name, `rm -rf ${office}`);
  });

  // Slice 2b-iii: a member's agent screenshots a page as the member. Alice's
  // page server writes the uid of every connection (from /proc/net/tcp), so
  // the pre-flight and the browser must both be Alice's; a root ps loop shows
  // the browser processes, their uid and their argv, which must hold no part
  // of the URL. The capture folder is gone after each capture.
  it("captures a page as the member, with no URL in any argv, and leaves no capture folder", async () => {
    const home = `${MEMBERS}/home/${ALICE}`;
    const aliceUid = String(uidOf(name, ALICE));
    const PORT = 47611;
    const URL = `http://127.0.0.1:${PORT}/rig-page?token=rig-secret-token`;
    const seen = "/tmp/rig-page-uids.log";
    const psLog = "/tmp/rig-ps.log";
    root(
      name,
      `rm -f ${seen} ${psLog} /tmp/rig-ps-stop; touch ${seen} && chmod 0666 ${seen}`,
    );
    expect(
      run(
        "docker",
        [
          "exec",
          "-i",
          "-u",
          ALICE,
          name,
          "bash",
          "-c",
          `cat > ${home}/rig-page.py`,
        ],
        `import http.server, sys
port = int(sys.argv[1]); log = sys.argv[2]
def uid_of(client_port):
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            rows = open(table).read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            f = row.split()
            if int(f[1].split(":")[1], 16) == client_port and int(f[2].split(":")[1], 16) == port:
                return f[7]
    return "?"
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(log, "a") as out:
            out.write(uid_of(self.client_address[1]) + " " + self.path + "\\n")
        body = b"<html><body style='background:#0a0'><h1>rig page</h1></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), Page).serve_forever()
`,
      ).status,
    ).toBe(0);
    run("docker", [
      "exec",
      "-d",
      "-u",
      ALICE,
      name,
      "python3",
      `${home}/rig-page.py`,
      String(PORT),
      seen,
    ]);
    await waitFor(
      "Alice's page server",
      () =>
        root(
          name,
          `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/ready`,
        ).out === "200",
    );
    // The enabling condition of the uid log: root's own request is root's.
    expect(root(name, `cat ${seen}`).out.trim()).toBe("0 /ready");
    root(name, `: > ${seen}`);

    const made = api(name, aliceCookie, "POST", "/api/agents", {
      name: "Rig Alice preview",
      cwd: home,
      roomId,
      desk: 6,
      agentType: "claude",
    });
    const agentId = (made.agent as { id: string } | undefined)?.id;
    if (!agentId) throw new Error(`spawn: ${JSON.stringify(made)}`);
    let turns = 0;
    const call = async (path: string, body: unknown) => {
      api(name, aliceCookie, "POST", `/api/agents/${agentId}/messages`, {
        text: `RIG_CALL ${JSON.stringify({ method: "POST", path, body })}`,
      });
      turns++;
      const report = (await reportsOf(agentId, turns))[turns - 1];
      return report?.call as { status: number; body: string } | undefined;
    };
    const captureDirs = () =>
      root(name, `ls -A ${home}/.isomux-agent/preview 2>/dev/null`).out.trim();

    run("docker", [
      "exec",
      "-d",
      "-u",
      "0",
      name,
      "bash",
      "-c",
      `end=$((SECONDS+90)); while [ $SECONDS -lt $end ] && [ ! -e /tmp/rig-ps-stop ]; do ps -eo uid=,args= | grep -F -- '--user-data-dir=' >> ${psLog}; sleep 0.05; done`,
    ]);
    const shot = await call(`/api/agents/${agentId}/preview-url`, { url: URL });
    root(name, "touch /tmp/rig-ps-stop");
    if (shot?.status !== 200)
      throw new Error(`preview-url: ${JSON.stringify(shot)}`);

    // Both requests to the page, the pre-flight and the browser's, were
    // Alice's.
    const requests = root(name, `cat ${seen}`)
      .out.trim()
      .split("\n")
      .filter(Boolean);
    const pageLoads = requests.filter((l) =>
      l.endsWith(" /rig-page?token=rig-secret-token"),
    );
    expect(pageLoads.length).toBe(2);
    expect(
      requests.map((l) => l.split(" ")[0]).filter((uid) => uid !== aliceUid),
    ).toEqual([]);

    // The browser ran as Alice, in a folder of her agent space, and no
    // process's argv held the URL.
    const browserLines = root(name, `cat ${psLog}`)
      .out.split("\n")
      .filter((l) =>
        l.includes(`--user-data-dir=${home}/.isomux-agent/preview/`),
      );
    expect(browserLines.length).toBeGreaterThan(0);
    expect(
      browserLines
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((uid) => uid !== aliceUid),
    ).toEqual([]);
    const leaks = root(name, `cat ${psLog}`)
      .out.split("\n")
      .filter(
        (l) => l.includes(String(PORT)) || l.includes("rig-secret-token"),
      );
    expect(leaks).toEqual([]);
    expect(captureDirs()).toBe("");

    // A page that is not served: unreachable, as Alice's pre-flight finds.
    const closed = await call(`/api/agents/${agentId}/preview-url`, {
      url: `http://127.0.0.1:${PORT + 1}/`,
    });
    expect(closed?.status).toBe(500);
    expect(
      (JSON.parse(closed!.body) as { error?: { code?: string } }).error?.code,
    ).toBe("unreachable");
    expect(captureDirs()).toBe("");
    root(
      name,
      `pkill -u ${ALICE} -f rig-page.py; rm -f ${home}/rig-page.py ${seen} ${psLog} /tmp/rig-ps-stop`,
    );
  });

  // Slice 2b-i: the office's sync session checks cannot read a member's
  // space, so they trust the stored conversation, and recovery must come
  // from the engine's own error. Each conversation is broken in the member's
  // space, the office restarts, and a message must get an answer in a new
  // conversation, and the next message one more, with no loop. A signed-out
  // Codex ends its turn as an office agent's does (the stub's 401 gives no
  // sign-in card in this rig, for the office either), and answers once
  // signed in again.
  it("recovers a member's agent whose stored conversation is gone or empty, and treats a signed-out member Codex as an office one", async () => {
    const home = `${MEMBERS}/home/${ALICE}`;
    const codexHome = `${home}/.isomux-agent/codex-home`;
    const aliceUid = String(uidOf(name, ALICE));
    const spawn = (label: string, agentType: string, desk: number | null) => {
      const made = api(name, aliceCookie, "POST", "/api/agents", {
        name: `Rig Alice ${label}`,
        cwd: home,
        roomId,
        desk,
        agentType,
        ...(agentType === "codex" ? { modelFamily: "gpt-rig" } : {}),
      });
      const id = (made.agent as { id: string } | undefined)?.id;
      if (!id) throw new Error(`spawn ${label}: ${JSON.stringify(made)}`);
      return id;
    };
    const agents = {
      claudeGone: spawn("claude gone", "claude", 6),
      claudeEmpty: spawn("claude empty", "claude", 7),
      codexGone: spawn("codex gone", "codex", null),
      codexOut: spawn("codex out", "codex", null),
    };
    // The control for the stub's sign-out: an office agent of the owner,
    // whose Codex home is the office's.
    api(name, cookie, "PUT", "/api/users/Owner/env/OPENAI_API_KEY", {
      value: "rig-key",
    });
    const officeMade = api(name, cookie, "POST", "/api/agents", {
      name: "Rig office codex out",
      cwd: "/tmp",
      roomId,
      desk: null,
      agentType: "codex",
      modelFamily: "gpt-rig",
    });
    const officeOut = (officeMade.agent as { id: string } | undefined)?.id;
    if (!officeOut)
      throw new Error(`spawn office: ${JSON.stringify(officeMade)}`);
    const officeCodexHome = "/var/data/home/.isomux/codex-home";
    const send = (id: string, text: string) =>
      api(name, aliceCookie, "POST", `/api/agents/${id}/messages`, { text });
    const logLines = (id: string) =>
      root(
        name,
        `cat ${STATE}/logs/${id}/*.jsonl 2>/dev/null | wc -l`,
      ).out.trim();
    for (const id of Object.values(agents)) send(id, "one");
    api(name, cookie, "POST", `/api/agents/${officeOut}/messages`, {
      text: "one",
    });
    expect((await reportsOf(officeOut, 1)).length).toBe(1);
    const first: Record<string, Record<string, unknown>> = {};
    for (const [key, id] of Object.entries(agents)) {
      [first[key]] = await reportsOf(id, 1);
      expect([key, first[key]?.uid]).toEqual([key, aliceUid]);
    }

    // Break each conversation in the member's space, as the member.
    const goneTranscript = String(first.claudeGone.transcript);
    const emptyTranscript = String(first.claudeEmpty.transcript);
    const goneRollout = root(
      name,
      `find ${codexHome}/sessions -name '*-${String(first.codexGone.threadId)}.jsonl'`,
    ).out.trim();
    // The condition: each stored conversation exists before it is broken.
    expect(
      [goneTranscript, emptyTranscript, goneRollout].map((p) =>
        p.startsWith(home),
      ),
    ).toEqual([true, true, true]);
    expect(
      sh(
        name,
        ALICE,
        `rm ${goneTranscript} ${goneRollout} && printf '{"type":"summary","summary":"rig"}\\n' > ${emptyTranscript}`,
      ).status,
    ).toBe(0);

    const restartedMs = Date.now();
    const restartedAt = new Date(restartedMs).toISOString();
    expect(run("docker", ["restart", name]).status).toBe(0);
    await office(name);
    await waitFor("Alice connected after the restart", () => {
      const r = run("docker", ["logs", "--since", restartedAt, name]);
      return (r.out + r.err).includes(
        `[member-hosts] ${alice} runs as ${ALICE}`,
      );
    });
    for (const id of Object.values(agents)) send(id, "two");
    api(name, cookie, "POST", `/api/agents/${officeOut}/messages`, {
      text: "two",
    });
    // The last error or system lines of an agent, for a red outcome.
    // `since`: only lines written from then on.
    const lastLines = (id: string, since = 0) =>
      root(name, `cat ${STATE}/logs/${id}/*.jsonl 2>/dev/null`)
        .out.split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              content: unknown;
              timestamp: number;
            },
        )
        .filter(
          (l) =>
            (l.kind === "error" || l.kind === "system") && l.timestamp >= since,
        )
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((l) => String(l.content).slice(0, 160));

    // A new conversation answers each broken one, and the next message too.
    // Every outcome is collected first, so one red run names each agent.
    const outcome: Record<string, string> = {};
    const recovered = {
      claudeGone: "transcript",
      claudeEmpty: "transcript",
      codexGone: "threadId",
    } as const;
    for (const [key, field] of Object.entries(recovered)) {
      const id = agents[key as keyof typeof agents];
      const second = (await reportsOf(id, 2))[1];
      if (!second) {
        outcome[key] = `no answer (${lastLines(id).slice(-2).join(" | ")})`;
        continue;
      }
      if (second.uid !== aliceUid || second[field] === first[key][field]) {
        outcome[key] =
          `answered as ${String(second.uid)} in ${String(second[field])}`;
        continue;
      }
      send(id, "three");
      outcome[key] =
        (await reportsOf(id, 3)).length === 3
          ? "recovered"
          : "no answer to the next message";
    }

    // The signed-out Codex: no answer, and the sign-out adds to its lines
    // what it adds to the office agent's; signed in again, the same agent
    // answers. The sign-out is the member's whole Codex home, so it starts
    // after codexGone recovered. A turn before it gives each agent's lines
    // that do not come from the sign-out (the resume note; a member's Codex
    // safety check, part 2d). The lines are compared as a set: the sign-in
    // notice is written async, so its place among the 401 lines differs.
    const signedIn = await Promise.all([
      reportsOf(agents.codexOut, 2),
      reportsOf(officeOut, 2),
    ]);
    expect(signedIn.map((r) => r.length)).toEqual([2, 2]);
    const everyTurn = (id: string) => new Set(lastLines(id, restartedMs));
    const memberEveryTurn = everyTurn(agents.codexOut);
    const officeEveryTurn = everyTurn(officeOut);
    const signedOutAt = Date.now();
    expect(sh(name, ALICE, `touch ${codexHome}/rig-signed-out`).status).toBe(0);
    expect(
      sh(name, String(OFFICE_UID), `touch ${officeCodexHome}/rig-signed-out`)
        .status,
    ).toBe(0);
    send(agents.codexOut, "three");
    api(name, cookie, "POST", `/api/agents/${officeOut}/messages`, {
      text: "three",
    });
    // Each signed-out turn reaches its 401; the lines it ends with are read
    // once the logs are quiet (below), so a later line is not missed.
    const reached401 = (id: string) =>
      waitFor(
        "the signed-out turn",
        () =>
          root(
            name,
            `grep -c 401 ${STATE}/logs/${id}/*.jsonl 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}'`,
          ).out.trim() !== "0",
        30_000,
      ).then(
        () => true,
        () => false,
      );
    const member401 = await reached401(agents.codexOut);
    const office401 = await reached401(officeOut);
    const answeredOut = (await reportsOf(agents.codexOut, 2)).length === 2;
    // No loop: no agent writes more to its log once its turn has ended.
    const settled = Object.fromEntries(
      Object.values(agents).map((id) => [id, logLines(id)]),
    );
    await Bun.sleep(5000);
    const quiet = Object.fromEntries(
      Object.entries(agents).map(([key, id]) => [
        key,
        logLines(id) === settled[id],
      ]),
    );
    const signedOutLines = (id: string, every: Set<string>) =>
      JSON.stringify(
        lastLines(id, signedOutAt)
          .filter((l) => !every.has(l))
          .sort(),
      );
    const memberOut = signedOutLines(agents.codexOut, memberEveryTurn);
    const officeOutLine = signedOutLines(officeOut, officeEveryTurn);
    expect(
      sh(name, String(OFFICE_UID), `rm ${officeCodexHome}/rig-signed-out`)
        .status,
    ).toBe(0);
    expect(sh(name, ALICE, `rm ${codexHome}/rig-signed-out`).status).toBe(0);
    send(agents.codexOut, "four");
    const signedInAgain = (await reportsOf(agents.codexOut, 3)).length === 3;
    outcome.codexOut =
      !member401 || !office401
        ? `no 401 (member ${member401}, office ${office401})`
        : memberOut === "[]"
          ? "no line from the sign-out"
          : memberOut !== officeOutLine
            ? `${memberOut} where the office agent has ${officeOutLine}`
            : !answeredOut
              ? "answered while signed out"
              : signedInAgain
                ? "recovered"
                : "no answer once signed in";

    expect({ outcome, quiet }).toEqual({
      outcome: {
        claudeGone: "recovered",
        claudeEmpty: "recovered",
        codexGone: "recovered",
        codexOut: "recovered",
      },
      quiet: {
        claudeGone: true,
        claudeEmpty: true,
        codexGone: true,
        codexOut: true,
      },
    });
    // A red run waits out each missing answer (90 s each), so it may take
    // minutes; a green run takes about one.
  }, 900_000);

  // Slice 2b-ii: the agent's folder is the member's (section 3.3). `~` is the
  // member's home; a folder the member cannot reach fails the turn with the
  // ACL command (only when the member's own stat confirms it); the room
  // folder is checked for each member's agent in the room; and a project
  // skill is listed and read in the member's runner, never by the office.
  // The checks run as the member: each folder below is one the office user
  // can read and Alice cannot, or the other way round.
  describe("the folder of a member's agent", () => {
    const home = `${MEMBERS}/home/${ALICE}`;
    const spawnAlice = (label: string, cwd: string, agentType = "claude") =>
      api(name, aliceCookie, "POST", "/api/agents", {
        name: `Rig Alice ${label}`,
        cwd,
        roomId,
        desk: null,
        agentType,
      });
    const idOf = (made: Record<string, unknown>, label: string) => {
      const id = (made.agent as { id: string } | undefined)?.id;
      if (!id) throw new Error(`spawn ${label}: ${JSON.stringify(made)}`);
      return id;
    };
    const send = (id: string, text: string) =>
      api(name, aliceCookie, "POST", `/api/agents/${id}/messages`, { text });
    // What Alice's open_log of the agent replays.
    const openLog = (
      id: string,
    ): { names: string[]; entries: { timestamp: number; text: string }[] } => {
      const r = run(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          `RIG_ARGS=${JSON.stringify([aliceCookie, id, HOST, ORIGIN])}`,
          name,
          "bun",
          "-",
        ],
        OPEN_LOG,
      );
      try {
        return JSON.parse(r.out.trim());
      } catch {
        return { names: [], entries: [] };
      }
    };
    // The agent's error and system lines written from `since` on.
    const linesOf = (id: string, since: number) =>
      openLog(id)
        .entries.filter((e) => e.timestamp >= since)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((e) => e.text);
    // The ACL commands in the agent's lines (a protocol value: the command
    // the owner runs), one array per line that has any.
    const aclCommands = (lines: string[]) =>
      lines
        .map((l) => l.match(/setfacl [^\n`"\\]+/g) ?? [])
        .filter((found) => found.length > 0);
    const aliceUid = () => String(uidOf(name, ALICE));

    // R1. C3: `~` and `~/sub` are the member's home, stored as the cwd and
    // where the agent runs.
    it("resolves `~` and `~/sub` to the member's home, stores it and runs there", async () => {
      expect(sh(name, ALICE, `mkdir -p ${home}/r1-sub`).status).toBe(0);
      const cases = [
        ["tilde", "~", home],
        ["tilde sub", "~/r1-sub", `${home}/r1-sub`],
      ] as const;
      const got: Record<string, unknown> = {};
      for (const [label, cwd, want] of cases) {
        const made = spawnAlice(`r1 ${label}`, cwd);
        const id = idOf(made, label);
        send(id, "one");
        const [report] = await reportsOf(id, 1);
        got[label] = {
          stored: (made.agent as { cwd?: string }).cwd === want,
          ran: report?.cwd === want,
          uid: report?.uid === aliceUid(),
        };
      }
      expect(got).toEqual({
        tilde: { stored: true, ran: true, uid: true },
        "tilde sub": { stored: true, ran: true, uid: true },
      });
    }, 300_000);

    // R2. C1, D3: a folder Alice cannot read (locked after the spawn): the
    // turn fails with one line that has the ACL command; the owner runs it
    // and the next message gets an answer. R3: a folder that is gone, or a
    // file in its place: the existing line, with no ACL command.
    it("fails a turn in a folder the member cannot reach with the ACL command, and only then", async () => {
      expect(
        root(
          name,
          "mkdir -p /srv/rig-r2 /srv/rig-r3a /srv/rig-r3b && chmod 755 /srv/rig-r2 /srv/rig-r3a /srv/rig-r3b",
        ).status,
      ).toBe(0);
      const agents = {
        locked: idOf(spawnAlice("r2 locked", "/srv/rig-r2"), "r2"),
        gone: idOf(spawnAlice("r3 gone", "/srv/rig-r3a"), "r3a"),
        file: idOf(spawnAlice("r3 file", "/srv/rig-r3b"), "r3b"),
      };
      for (const id of Object.values(agents)) send(id, "one");
      // The enabling condition: each ran in its folder as Alice.
      const ran: Record<string, unknown> = {};
      for (const [key, id] of Object.entries(agents)) {
        const [r] = await reportsOf(id, 1);
        ran[key] = [r?.cwd, r?.uid];
      }
      expect(ran).toEqual({
        locked: ["/srv/rig-r2", aliceUid()],
        gone: ["/srv/rig-r3a", aliceUid()],
        file: ["/srv/rig-r3b", aliceUid()],
      });

      expect(
        root(
          name,
          "chmod 700 /srv/rig-r2 && rm -rf /srv/rig-r3a && rm -rf /srv/rig-r3b && echo x > /srv/rig-r3b",
        ).status,
      ).toBe(0);
      // Alice's own view of each folder now.
      expect([
        tryAs(name, ALICE, 'os.listdir("/srv/rig-r2")'),
        tryAs(name, ALICE, 'os.listdir("/srv/rig-r3a")'),
        tryAs(name, ALICE, 'os.listdir("/srv/rig-r3b")'),
      ]).toEqual(["EACCES", "ENOENT", "ENOTDIR"]);
      // A running engine keeps the folder it started in: a new conversation
      // starts a new process there.
      for (const id of Object.values(agents))
        api(
          name,
          aliceCookie,
          "POST",
          `/api/agents/${id}/new-conversation`,
          {},
        );
      const since = Date.now();
      for (const id of Object.values(agents)) send(id, "two");
      // A turn that cannot start writes its lines; the section-2 line comes
      // after the engine's, so wait for the logs to be quiet.
      const quiet = async (id: string) => {
        let last = "";
        await waitFor(
          "the failed turn's lines",
          () => {
            const now = JSON.stringify(linesOf(id, since));
            const done = now === last && now !== "[]";
            last = now;
            return done;
          },
          60_000,
        ).catch(() => undefined);
        await Bun.sleep(3000);
        return linesOf(id, since);
      };
      const lines = {
        locked: await quiet(agents.locked),
        gone: await quiet(agents.gone),
        file: await quiet(agents.file),
      };
      const acl = {
        locked: aclCommands(lines.locked).length,
        gone: aclCommands(lines.gone).length,
        file: aclCommands(lines.file).length,
      };
      // No answer in a folder the agent cannot enter.
      const answered = {
        locked: (await reportsOf(agents.locked, 2)).length,
      };
      // The gone and file agents name their folder (the existing text).
      const named = {
        gone: lines.gone.some((l) => l.includes("/srv/rig-r3a")),
        file: lines.file.some((l) => l.includes("/srv/rig-r3b")),
      };
      const want = {
        acl: { locked: 1, gone: 0, file: 0 },
        answered: { locked: 1 },
        named: { gone: true, file: true },
      };
      const got = { acl, answered, named };
      // A red run shows the lines each agent wrote.
      expect(Bun.deepEquals(got, want) ? got : { ...got, lines }).toEqual(want);

      // The owner runs the command as given; the next message gets an answer.
      const [commands] = aclCommands(lines.locked);
      for (const cmd of commands)
        expect([cmd, root(name, cmd).status]).toEqual([cmd, 0]);
      expect(tryAs(name, ALICE, 'os.listdir("/srv/rig-r2")')).toBe("ok");
      // The message that failed is sent again at the next wake (the office's
      // delivery of a message no engine took), then "three": each once, in
      // that order, in the shared folder as Alice. The office may send the
      // two in one turn or in two.
      send(agents.locked, "three");
      // Up to 3 reports (90 s when the two came in one turn), then quiet.
      await reportsOf(agents.locked, 3);
      await Bun.sleep(5000);
      const after = (await reportsOf(agents.locked, 1)).slice(1);
      const said = after.map((r) => String(r.said ?? "")).join("\n");
      const count = (word: string) =>
        (said.match(new RegExp(`\\b${word}\\b`, "g")) ?? []).length;
      const gotAfter = {
        two: count("two"),
        three: count("three"),
        order: said.search(/\btwo\b/) < said.search(/\bthree\b/),
        where: [
          ...new Set(after.map((r) => `${String(r.cwd)} ${String(r.uid)}`)),
        ],
      };
      const wantAfter = {
        two: 1,
        three: 1,
        order: true,
        where: [`/srv/rig-r2 ${aliceUid()}`],
      };
      // A red run shows what each turn was sent.
      expect(
        Bun.deepEquals(gotAfter, wantAfter)
          ? gotAfter
          : { ...gotAfter, said: after.map((r) => r.said) },
      ).toEqual(wantAfter);
    }, 600_000);

    // R6. D7: a /resume to a session that ran in another folder, which Alice
    // can no longer read: the section-2 line (the sync cwd switch at resume
    // does not stat as the office for a member).
    it("gives the ACL line for a /resume into a session whose folder the member cannot reach", async () => {
      expect(
        root(name, "mkdir -p /srv/rig-r6 && chmod 755 /srv/rig-r6").status,
      ).toBe(0);
      const id = idOf(spawnAlice("r6", "/srv/rig-r6"), "r6");
      send(id, "one");
      expect((await reportsOf(id, 1))[0]?.cwd).toBe("/srv/rig-r6");
      const first = (
        api(name, aliceCookie, "GET", `/api/agents/${id}/sessions`, {}) as {
          currentSessionId?: string;
        }
      ).currentSessionId;
      expect(first).toBeTruthy();
      api(name, aliceCookie, "POST", `/api/agents/${id}/new-conversation`, {});
      api(name, aliceCookie, "PATCH", `/api/agents/${id}`, { cwd: home });
      send(id, "two");
      const second = await reportsOf(id, 2);
      // The enabling condition: the agent now runs in Alice's home.
      expect(second[1]?.cwd).toBe(home);
      expect(root(name, "chmod 700 /srv/rig-r6").status).toBe(0);
      const since = Date.now();
      api(name, aliceCookie, "POST", `/api/agents/${id}/resume`, {
        sessionId: first,
      });
      send(id, "three");
      // Two starts fail, each with one line: the /resume, which starts the
      // engine at once, and the wake by "three". Read once the log is quiet,
      // so a loop would show as more.
      await waitFor(
        "the ACL lines",
        () => aclCommands(linesOf(id, since)).length >= 2,
        90_000,
      ).catch(() => undefined);
      await Bun.sleep(10_000);
      const found = aclCommands(linesOf(id, since));
      const got = {
        acl: found.length,
        same: new Set(found.map((c) => JSON.stringify(c))).size,
      };
      const want = { acl: 2, same: 1 };
      expect(
        Bun.deepEquals(got, want) ? got : { ...got, lines: linesOf(id, since) },
      ).toEqual(want);
    }, 300_000);

    // R4. Q3, C2, D6: a room folder that Alice cannot read, with her agent in
    // the room, is refused and the room keeps its folder; the refusal names
    // her agent. The same folder in a room with only office agents is set.
    it("refuses a room folder that a member's agent in the room cannot reach", () => {
      expect(
        root(
          name,
          `mkdir -p /srv/rig-r4 && chown ${OFFICE_UID}:${OFFICE_UID} /srv/rig-r4 && chmod 700 /srv/rig-r4`,
        ).status,
      ).toBe(0);
      // The enabling condition: the office can read it, Alice cannot.
      expect([
        tryAs(name, String(OFFICE_UID), 'os.listdir("/srv/rig-r4")'),
        tryAs(name, ALICE, 'os.listdir("/srv/rig-r4")'),
      ]).toEqual(["ok", "EACCES"]);
      const agentName = "Rig Alice r4";
      idOf(spawnAlice("r4", home), "r4");
      const settings = (room: string) =>
        api(name, cookie, "GET", `/api/rooms/${room}/settings`, {}) as {
          cwd?: string | null;
        };
      const before = settings(roomId).cwd ?? null;
      const refused = api(name, cookie, "PATCH", `/api/rooms/${roomId}`, {
        cwd: "/srv/rig-r4",
      });
      const officeRoom = (
        api(name, cookie, "POST", "/api/rooms", { name: "Rig office r4" })
          .room as { id: string }
      ).id;
      const officeAgent = api(name, cookie, "POST", "/api/agents", {
        name: "Rig office r4",
        cwd: "/tmp",
        roomId: officeRoom,
        desk: null,
        agentType: "claude",
      });
      expect(JSON.stringify(officeAgent)).toContain('"agent"');
      const accepted = api(name, cookie, "PATCH", `/api/rooms/${officeRoom}`, {
        cwd: "/srv/rig-r4",
      });
      expect({
        refusedCode: (refused.error as { code?: string } | undefined)?.code,
        namesAgent: JSON.stringify(refused).includes(agentName),
        kept: (settings(roomId).cwd ?? null) === before,
        acceptedError: accepted.error ?? null,
        officeSet: settings(officeRoom).cwd,
      }).toEqual({
        refusedCode: "invalid_cwd",
        namesAgent: true,
        kept: true,
        acceptedError: null,
        officeSet: "/srv/rig-r4",
      });
    });

    // R5. C5, D5: a project skill in a folder only Alice can read is in her
    // agent's menu, and runs with its current body after an edit.
    it("lists and runs a project skill that only the member can read, with its current body", async () => {
      const proj = `${home}/r5-proj`;
      const skill = `${proj}/.claude/skills/rig-skill`;
      expect(
        sh(
          name,
          ALICE,
          `mkdir -p ${skill} && chmod 700 ${proj} && printf -- '---\\nname: rig-skill\\ndescription: Rig skill\\n---\\nRIG_SKILL_BODY_V1\\n' > ${skill}/SKILL.md`,
        ).status,
      ).toBe(0);
      // The enabling condition: the office user cannot read it.
      expect(
        tryAs(name, String(OFFICE_UID), `open("${skill}/SKILL.md").read()`),
      ).toBe("EACCES");
      const id = idOf(spawnAlice("r5", proj), "r5");
      const menu = () => openLog(id).names;
      let listed: string[] = [];
      await waitFor(
        "the skill in the menu",
        () => {
          listed = menu();
          return listed.includes("rig-skill");
        },
        90_000,
      ).catch(() => undefined);
      send(id, "/rig-skill");
      const [v1] = await reportsOf(id, 1);
      expect(
        sh(
          name,
          ALICE,
          `sed -i 's/RIG_SKILL_BODY_V1/RIG_SKILL_BODY_V2/' ${skill}/SKILL.md`,
        ).status,
      ).toBe(0);
      send(id, "/rig-skill");
      const after = await reportsOf(id, 2);
      expect({
        listed: listed.includes("rig-skill"),
        v1: String(v1?.said ?? "").includes("RIG_SKILL_BODY_V1"),
        v2: String(after[1]?.said ?? "").includes("RIG_SKILL_BODY_V2"),
        uid: after[1]?.uid,
      }).toEqual({ listed: true, v1: true, v2: true, uid: aliceUid() });
    }, 400_000);
  });

  it("moves a member's office conversations into their space at enable, they resume there, and disable moves them back", async () => {
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
    // The stub's rollout of the thread, written again by the test so its
    // bytes are known.
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

    // Slice 1c-ii-b: disable moves them back to the office, with their pins,
    // and the next turns run as the office.
    const sid2 = sessionOf(claudeTwo.transcript);
    const disabled = command(name, "disable", "Erin");
    if (disabled.status !== 0) throw new Error(`disable Erin: ${disabled.err}`);
    const pinsAfter = JSON.parse(
      root(name, `cat ${STATE}/logs/${agents.claude}/sessions.json`).out,
    ) as Record<string, { claudeConfigDir?: string }>;
    for (const id of [sid, sid2]) {
      expect([
        id,
        ownerOf(`/var/data/home/.claude/projects/-tmp/${id}.jsonl`),
      ]).toEqual([id, OFFICE]);
      expect([id, pinsAfter[id]?.claudeConfigDir]).toEqual([
        id,
        "/var/data/home/.claude",
      ]);
      expect([
        id,
        root(name, `test -e ${erinHome}/.claude/projects/-tmp/${id}.jsonl`)
          .status,
      ]).toEqual([id, 1]);
    }
    expect(ownerOf(officeRollout)).toBe(OFFICE);
    expect(root(name, `test -e ${space}/codex-home/${rolloutRel}`).status).toBe(
      1,
    );
    expect(root(name, `cat ${officeHome}/kept.txt`).out).toBe("ERIN");
    expect(root(name, `test -e ${landedHome}/kept.txt`).status).toBe(1);
    for (const agentId of Object.values(agents)) send(agentId, "three");
    const claudeThree = (await reportsOf(agents.claude, 3))[2];
    const codexThree = (await reportsOf(agents.codex, 3))[2];
    expect([claudeThree?.uid, codexThree?.uid]).toEqual([OFFICE, OFFICE]);
    expect(
      String(claudeThree.transcript).startsWith(
        "/var/data/home/.claude/projects/",
      ),
    ).toBe(true);
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
