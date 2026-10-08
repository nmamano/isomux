// Tier-1 proof of split mode in the two-user rig (scripts/split-rig.sh,
// internal-docs/os-user-split-design.md section 7). Needs Docker and an image
// built from the committed HEAD:
//
//   systemd-run --user --scope -p MemoryMax=6G scripts/split-rig.sh build
//   ISOMUX_TEST_SPLIT_RIG=1 bun test server/test-support/split-rig.integration.test.ts
//
// To test a mutant, build its commit (scripts/split-rig.sh build <commit>)
// and set SPLIT_RIG_COMMIT=<commit>.
//
// Every agent-side check runs with `docker exec -u node`, never through the
// runner, and asserts the exact error code.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { spawnSync } from "child_process";
import { basename, dirname, join } from "path";

const ENABLED = process.env.ISOMUX_TEST_SPLIT_RIG === "1";
// Each case runs several docker commands; the stop in afterAll removes
// up to eight containers.
setDefaultTimeout(120_000);
const ROOT = join(import.meta.dir, "..", "..");
const RIG = join(ROOT, "scripts", "split-rig.sh");
const STATE = "/var/data/server/.isomux";
const SHARE = "/var/data/server/share";
const SOCKET = "/run/isomux-agent-runner/runner.sock";
const CODE = "/opt/isomux";
// The agents' workspace: the server user can still check that it exists
// (task 01f5038c moves that check to the agent user in a later slice).
const WORK = "/tmp/rig-work";
const AGENT_UID = "1000";
const SERVER_UID = "10001";
const OWNER = "Rig Owner Marker";
const PREFIX = `split-rig-${process.pid}`;
const started: string[] = [];

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, cwd: ROOT });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// Run a script with bun inside the container as one user; the script prints
// its answer.
function bunAs(name: string, user: string, script: string) {
  return run("docker", ["exec", "-i", "-u", user, name, "bun", "-"], script);
}

function sh(name: string, user: string, command: string) {
  return run("docker", ["exec", "-u", user, name, "sh", "-c", command]);
}

// The error code the agent user gets for one file operation, or "ok".
function agentTry(name: string, op: string): string {
  return bunAs(
    name,
    "node",
    `const fs = require("fs");
try { ${op}; console.log("ok"); } catch (e) { console.log(e.code); }`,
  ).out.trim();
}

function start(suffix: string, brk = "", runner = "real"): string {
  const name = `${PREFIX}-${suffix}`;
  started.push(name);
  const r = run("bash", [RIG, "start", name, brk, runner]);
  if (r.status !== 0) throw new Error(`rig start failed: ${r.err}`);
  return name;
}

// Wait until the office answers /readyz or has exited; returns its exit code
// or null while it runs.
async function settle(name: string): Promise<number | null> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const exit = sh(name, "root", "cat /run/office-exit 2>/dev/null");
    if (exit.out.trim()) return Number(exit.out.trim());
    const ready = sh(
      name,
      "root",
      "curl -sf -o /dev/null http://127.0.0.1:10000/readyz",
    );
    if (ready.status === 0) return null;
    await Bun.sleep(250);
  }
  throw new Error(`${name} neither started nor stopped`);
}

const logs = (name: string) => {
  const r = run("docker", ["logs", name]);
  return r.out + r.err;
};

function claim(name: string): string {
  const r = sh(
    name,
    "root",
    `curl -s -i -X POST http://127.0.0.1:10000/auth/claim -H 'Origin: http://localhost:10000' --data-urlencode 'name=${OWNER}' --data-urlencode key@${STATE}/setup-key`,
  );
  const cookie = /set-cookie: (isomux_session=[^;]+)/i.exec(r.out)?.[1];
  if (!cookie) throw new Error(`claim failed: ${r.out}`);
  return cookie;
}

function firstAgent(name: string, cookie: string): string {
  const r = sh(
    name,
    "root",
    `curl -s http://127.0.0.1:10000/agents -H 'Cookie: ${cookie}'`,
  );
  return (JSON.parse(r.out) as { id: string }[])[0].id;
}

// An office API call with a JSON body, from inside the container.
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
      `Cookie: ${cookie}`,
      "-H",
      "Origin: http://localhost:10000",
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
    ],
    JSON.stringify(body),
  );
  return JSON.parse(r.out) as Record<string, unknown>;
}

interface LogLine {
  id: string;
  kind: string;
  content: string;
}

// An agent's log as the office wrote it, read as root.
function logLines(name: string, agentId: string): LogLine[] {
  return sh(name, "root", `cat ${STATE}/logs/${agentId}/*.jsonl 2>/dev/null`)
    .out.split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine);
}

// What the stub providers report about themselves (scripts/split-rig.sh);
// each backend fills its own fields.
interface Report {
  backend: string;
  uid: string;
  home: string;
  serverEnv: string[];
  transcript: string;
  codexHome: string;
  hook: { command: string; exitCode: number; stdout: string };
  servePid: number;
  authority: { status: string; pid: number };
}

async function reports(
  name: string,
  agentId: string,
  count: number,
): Promise<Report[]> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const found = logLines(name, agentId)
      .filter((l) => l.kind === "text" && l.content.startsWith("RIG_REPORT "))
      .map((l) => JSON.parse(l.content.slice("RIG_REPORT ".length)) as Report);
    if (found.length >= count || Date.now() > deadline) return found;
    await Bun.sleep(250);
  }
}

function spawnAgent(
  name: string,
  cookie: string,
  agentType: string,
  desk: number,
  modelFamily?: string,
): string {
  const agents = JSON.parse(
    sh(
      name,
      "root",
      `curl -s http://127.0.0.1:10000/agents -H 'Cookie: ${cookie}'`,
    ).out,
  ) as { roomId: string }[];
  const roomId = agents.find((a) => a.roomId !== "lobby")!.roomId;
  const result = api(name, cookie, "POST", "/api/agents", {
    name: `Rig ${agentType}`,
    cwd: WORK,
    roomId,
    desk,
    agentType,
    ...(modelFamily ? { modelFamily } : {}),
  });
  return (result.agent as { id: string }).id;
}

function send(name: string, cookie: string, agentId: string, text: string) {
  api(name, cookie, "POST", `/api/agents/${agentId}/messages`, { text });
}

// A request to the OpenCode authority socket as one user, through curl.
function authorityStatus(name: string, user: string): string {
  return sh(
    name,
    user,
    `curl -s -o /dev/null -w '%{http_code}' --unix-socket ${SHARE}/authority/authority.sock -H 'X-Isomux-Turn: rig' http://isomux/api/memory`,
  ).out;
}

// An office client in the container: a WebSocket with the owner's cookie.
const CLIENT = `
const [cookie, agentId, action, arg] = JSON.parse(process.env.RIG_ARGS);
const base = "127.0.0.1:10000";
const headers = { Cookie: cookie, Origin: "http://localhost:10000" };
const ws = new WebSocket("ws://" + base + "/ws", { headers });
let out = "";
const started = Date.now();
const finish = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
setTimeout(() => finish({ timeout: true, out }), 20000);
ws.onopen = async () => {
  if (action === "terminal") ws.send(JSON.stringify({ type: "terminal_open", agentId }));
  else {
    await Bun.sleep(300);
    await fetch("http://" + base + "/api/agents/" + agentId + "/messages", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/isomux-diff " + arg }) });
  }
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (action === "terminal" && msg.type === "terminal_output" && msg.agentId === agentId) {
    out += msg.data;
    if (!out.includes("RIG_UID=") && /[$#] $/.test(out))
      ws.send(JSON.stringify({ type: "terminal_input", agentId, data: "echo RIG_UID=$(id -u)\\n" }));
    const m = /RIG_UID=(\\d+)\\r?\\n/.exec(out.split("echo RIG_UID=").pop() ?? "");
    if (m) finish({ uid: m[1] });
  }
  // The socket replays earlier entries on connect: take only this request's.
  if (action === "diff" && msg.type === "log_entry" && msg.entry.agentId === agentId
      && msg.entry.timestamp >= started
      && ((msg.entry.kind === "diff" && msg.entry.diff.cwd === arg) || msg.entry.kind === "system"))
    finish(msg.entry);
};
`;

function client(
  name: string,
  args: [string, string, string, string?],
): Record<string, unknown> {
  const r = run(
    "docker",
    ["exec", "-i", "-e", `RIG_ARGS=${JSON.stringify(args)}`, name, "bun", "-"],
    CLIENT,
  );
  return JSON.parse(r.out.trim()) as Record<string, unknown>;
}

// A raw runner request from inside the container as one user, in Python so
// that the client is not the code under test. Returns the frames it got back:
// control messages as objects, stdout as { stdout }.
function runnerRequest(name: string, user: string, request: unknown) {
  const r = run(
    "docker",
    ["exec", "-i", "-u", user, name, "python3", "-"],
    `import json, socket, struct
s = socket.socket(socket.AF_UNIX)
s.settimeout(10)
s.connect("${SOCKET}")
payload = ${JSON.stringify(JSON.stringify(request))}.encode()
s.sendall(struct.pack(">IB", len(payload) + 1, 1) + payload)
data = b""
while True:
    chunk = s.recv(65536)
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
  return JSON.parse(r.out.trim()) as Record<string, unknown>[];
}

describe.skipIf(!ENABLED)("split rig, tier 1", () => {
  beforeAll(() => {
    // SPLIT_RIG_COMMIT names a mutant commit built for a mutation run.
    const head =
      process.env.SPLIT_RIG_COMMIT ??
      run("git", ["rev-parse", "HEAD"]).out.trim();
    const image = run("docker", [
      "image",
      "inspect",
      "isomux-split-rig:latest",
      "--format",
      '{{index .Config.Labels "isomux.split-rig.commit"}}',
    ]).out.trim();
    // The rig image must hold exactly the committed code under test.
    expect(image).toBe(head);
  });

  afterAll(() => {
    for (const name of started) run("bash", [RIG, "stop", name]);
  });

  describe("a correct split", () => {
    let name = "";
    let cookie = "";
    let agentId = "";

    beforeAll(async () => {
      name = start("clean");
      expect(await settle(name)).toBeNull();
      cookie = claim(name);
      agentId = firstAgent(name, cookie);
    });

    it("runs the office as the server user and the runner as the agent user", () => {
      const users = sh(name, "root", "ps -eo uid=,comm=").out;
      expect(users).toMatch(new RegExp(`^\\s*${SERVER_UID}\\s+isomux$`, "m"));
      expect(users).toMatch(new RegExp(`^\\s*${AGENT_UID}\\s+bun$`, "m"));
      expect(sh(name, "node", "id -u").out.trim()).toBe(AGENT_UID);
    });

    it("passes the full trusted check and logs a proven diagnostic", () => {
      const check = sh(
        name,
        "isomux-server",
        `cd ${CODE} && ISOMUX_HOME=${STATE} bun server/split/check.ts`,
      );
      // The failed checks are on stderr; compare both so a failure names them.
      expect({ status: check.status, failed: check.err }).toEqual({
        status: 0,
        failed: "",
      });
      const log = logs(name);
      for (const tryName of [
        "readState",
        "writeCode",
        "renameCode",
        "createInShare",
      ])
        expect(log).toContain(`runner diagnostic ${tryName}: proven (EACCES)`);
    });

    it("denies the agent user the state, the code and the share", () => {
      // The server user reads its own state; the agent user cannot.
      expect(
        sh(name, "isomux-server", `cat ${STATE}/users.json`).out,
      ).toContain(OWNER);
      expect(agentTry(name, `fs.readFileSync("${STATE}/users.json")`)).toBe(
        "EACCES",
      );
      expect(agentTry(name, `fs.readdirSync("${STATE}")`)).toBe("EACCES");
      expect(
        agentTry(
          name,
          `fs.closeSync(fs.openSync("${CODE}/package.json", fs.constants.O_WRONLY))`,
        ),
      ).toBe("EACCES");
      expect(
        agentTry(
          name,
          `fs.renameSync("${CODE}/package.json", "${CODE}/package.moved")`,
        ),
      ).toBe("EACCES");
      expect(
        agentTry(
          name,
          `fs.closeSync(fs.openSync("${SHARE}/x", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL))`,
        ),
      ).toBe("EACCES");
    });

    it("refuses every runner connection but the server user's", () => {
      expect(runnerRequest(name, "isomux-server", { op: "info" })).toEqual([
        expect.objectContaining({ type: "info", uid: Number(AGENT_UID) }),
      ]);
      // The agent user connects to the socket file but gets no answer.
      expect(runnerRequest(name, "node", { op: "info" })).toEqual([]);
      expect(runnerRequest(name, "root", { op: "info" })).toEqual([]);
    });

    it("opens a terminal panel as the agent user", () => {
      expect(client(name, [cookie, agentId, "terminal"])).toEqual({
        uid: AGENT_UID,
      });
    });

    // The wrong path must be able to run: the server user can enter both
    // repos and run git in them (safe.directory), and can write the marker.
    const prepareRepo = (repo: string, extra: string) => {
      const setup = sh(
        name,
        "node",
        `set -e; mkdir -m 755 ${repo}; cd ${repo}; git init -q
echo one > a.txt; git add a.txt; git -c user.email=r@r -c user.name=r commit -qm init
echo two >> a.txt; ${extra}`,
      );
      expect(setup.status).toBe(0);
      expect(
        sh(
          name,
          "isomux-server",
          `git -c core.fsmonitor=false -C ${repo} rev-parse --is-inside-work-tree`,
        ).out.trim(),
      ).toBe("true");
    };

    beforeAll(() => {
      expect(
        sh(name, "root", "git config --system --add safe.directory '*'").status,
      ).toBe(0);
    });

    it("runs git for the diff as the agent user", () => {
      const repo = "/tmp/rig-git";
      const hook = "/tmp/rig-hook.sh";
      const marker = "/tmp/rig-marks/git-uid";
      expect(sh(name, "root", "install -d -m 1777 /tmp/rig-marks").status).toBe(
        0,
      );
      expect(
        sh(
          name,
          "node",
          `printf '#!/bin/sh\nid -u >> ${marker}\n' > ${hook} && chmod 755 ${hook}`,
        ).status,
      ).toBe(0);
      // fsmonitor goes on last, so no setup command runs the hook.
      prepareRepo(repo, `git config core.fsmonitor ${hook}`);
      expect(sh(name, "isomux-server", `test -x ${hook}`).status).toBe(0);
      expect(sh(name, "root", `test -e ${marker}`).status).toBe(1);

      const entry = client(name, [cookie, agentId, "diff", repo]);
      expect(entry.kind).toBe("diff");
      // git ran the repo's fsmonitor hook, and only as the agent user.
      const uids = sh(name, "root", `cat ${marker}`).out.trim().split("\n");
      expect(uids.length).toBeGreaterThan(0);
      expect(new Set(uids)).toEqual(new Set([AGENT_UID]));
    });

    it("reads untracked files for the diff as the agent user", () => {
      const repo = "/tmp/rig-untracked";
      prepareRepo(
        repo,
        `echo fresh-marker > fresh.txt; ln -s ${STATE}/users.json leak`,
      );
      // The link's target exists and the server user reads it through the
      // link; the agent user is refused.
      expect(sh(name, "isomux-server", `cat ${repo}/leak`).out).toContain(
        OWNER,
      );
      expect(agentTry(name, `fs.readFileSync("${repo}/leak")`)).toBe("EACCES");

      const entry = client(name, [cookie, agentId, "diff", repo]);
      expect(entry.kind).toBe("diff");
      const diff = entry.diff as {
        files: { path: string; status: string }[];
        patchText: string | null;
      };
      // The untracked read ran: the readable file is in the diff.
      expect(diff.files).toContainEqual(
        expect.objectContaining({ path: "fresh.txt", status: "added" }),
      );
      expect(diff.patchText).toContain("+fresh-marker");
      // It ran as the agent user: the state file behind the link is not.
      expect(diff.files.map((f) => f.path)).not.toContain("leak");
      expect(JSON.stringify(entry)).not.toContain(OWNER);
    });

    describe("agent backends (stub providers)", () => {
      beforeAll(() => {
        expect(sh(name, "node", `install -d -m 755 ${WORK}`).status).toBe(0);
      });

      it("keeps server-only variables in the server process", () => {
        // The stubs report these as absent; the proof needs them present here.
        // Only the same uid may read it (root lacks CAP_SYS_PTRACE here).
        const environ = sh(
          name,
          "isomux-server",
          `tr '\\0' '\\n' < /proc/$(pgrep -u ${SERVER_UID} -f isomux-office.ts | head -1)/environ`,
        ).out;
        expect(environ).toContain("SPLIT_RIG_SERVER_SENTINEL=server-only");
        expect(environ).toContain("ISOMUX_AGENT_RUNNER=");
      });

      it("runs Claude as the agent user and forks its transcript as the agent user", async () => {
        const agentId = spawnAgent(name, cookie, "claude", 5);
        send(name, cookie, agentId, "one");
        const [first] = await reports(name, agentId, 1);
        expect(first).toMatchObject({
          backend: "claude",
          uid: AGENT_UID,
          home: "/var/data/home",
          serverEnv: [],
        });
        send(name, cookie, agentId, "two");
        expect((await reports(name, agentId, 2)).length).toBe(2);
        const project = dirname(first.transcript);
        const before = sh(name, "root", `ls ${project}`).out.trim();
        expect(before.split("\n")).toEqual([basename(first.transcript)]);
        // The production edit path: it reads the transcript and writes the
        // fork through the session store.
        const second = logLines(name, agentId).filter(
          (l) => l.kind === "user_message",
        )[1];
        api(
          name,
          cookie,
          "PATCH",
          `/api/agents/${agentId}/messages/${second.id}`,
          {
            newText: "two, edited",
          },
        );
        let fork = "";
        const deadline = Date.now() + 30_000;
        while (!fork && Date.now() < deadline) {
          fork =
            sh(name, "root", `ls ${project}`)
              .out.trim()
              .split("\n")
              .find((f) => f && !before.includes(f)) ?? "";
          if (!fork) await Bun.sleep(250);
        }
        expect(fork).toMatch(/^[0-9a-f-]{36}\.jsonl$/);
        expect(
          sh(name, "root", `stat -c '%u %a' ${project}/${fork}`).out.trim(),
        ).toBe(`${AGENT_UID} 600`);
        // The fork copies the original conversation up to the edited message.
        const original = basename(first.transcript, ".jsonl");
        expect(sh(name, "root", `cat ${project}/${fork}`).out).toContain(
          `"forkedFrom":{"sessionId":"${original}"`,
        );
      });

      it("runs Codex as the agent user with the safety hook from the share", async () => {
        const agentId = spawnAgent(name, cookie, "codex", 6, "gpt-rig");
        send(name, cookie, agentId, "hello");
        const [report] = await reports(name, agentId, 1);
        expect(report).toMatchObject({
          backend: "codex",
          uid: AGENT_UID,
          serverEnv: [],
          codexHome: "/var/data/home/.isomux/codex-home",
        });
        // The agent user ran the real hook from the share, and it decided.
        expect(report.hook.command).toBe(
          `${SHARE}/bin/isomux-codex-safety-hook`,
        );
        expect(report.hook.exitCode).toBe(0);
        expect(JSON.parse(report.hook.stdout)).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
        // The hook configuration was merged in agent space by the agent user.
        expect(
          sh(
            name,
            "root",
            `stat -c '%u' ${report.codexHome}/hooks.json ${report.codexHome}/config.toml`,
          )
            .out.trim()
            .split("\n"),
        ).toEqual([AGENT_UID, AGENT_UID]);
        expect(
          agentTry(
            name,
            `fs.closeSync(fs.openSync("${report.hook.command}", "r+"))`,
          ),
        ).toBe("EACCES");
      });

      it("runs OpenCode as the agent user, and its child reaches the office through the authority socket", async () => {
        const agentId = spawnAgent(name, cookie, "opencode", 7, "rig/stub");
        send(name, cookie, agentId, "hello");
        const [report] = await reports(name, agentId, 1);
        expect(report).toMatchObject({
          backend: "opencode",
          uid: AGENT_UID,
          serverEnv: [],
        });
        expect(
          sh(name, "root", `ps -o uid= -p ${report.servePid}`).out.trim(),
        ).toBe(AGENT_UID);
        // The broker accepted a child of the serve process, walking its
        // ancestry across the two users up to the serve pid.
        expect(report.authority.status).toBe("200");
        const line = logs(name)
          .split("\n")
          .find((l) =>
            l.includes(
              `[opencode-office-proxy] agent=${agentId} peer=${report.authority.pid} `,
            ),
          );
        expect(line).toContain(`,${report.servePid}:`);
        expect(line).not.toContain("ancestry=refused");
      });

      it("refuses the authority socket to every other process, by peer check or by the kernel", () => {
        // The server user is in the agent group: the kernel lets it connect,
        // and the broker's peer check refuses it.
        expect(authorityStatus(name, "isomux-server")).toBe("403");
        // The agent user outside an OpenCode turn: the ancestry check refuses.
        expect(authorityStatus(name, "node")).toBe("403");
        // A third user cannot pass through the share: the kernel refuses.
        const third = run(
          "docker",
          ["exec", "-i", "-u", "nobody", name, "python3", "-"],
          `import socket
s = socket.socket(socket.AF_UNIX)
try:
    s.connect("${SHARE}/authority/authority.sock")
    print("connected")
except OSError as e:
    print(e.errno)`,
        );
        expect(third.out.trim()).toBe("13");
      });

      it("inspects OpenCode storage as the agent user", () => {
        const db = "/var/data/home/rig.db";
        expect(
          sh(name, "node", `printf 'not sqlite' > ${db} && chmod 600 ${db}`)
            .status,
        ).toBe(0);
        // The server user cannot even see it.
        expect(sh(name, "isomux-server", `test -e ${db}`).status).toBe(1);
        const opened = runnerRequest(name, "isomux-server", {
          op: "entry",
          name: "opencode-inspect",
          input: { databasePath: db, sessionId: "ses_rig" },
        });
        // The agent user found the file and SQLite refused it; the server
        // user would have answered "missing".
        expect(opened.at(-1)).toEqual({ type: "exit", code: 1, signal: null });
        const missing = runnerRequest(name, "isomux-server", {
          op: "entry",
          name: "opencode-inspect",
          input: {
            databasePath: "/var/data/home/absent.db",
            sessionId: "ses_rig",
          },
        });
        expect(missing).toContainEqual({ stdout: '"missing"' });
      });
    });
  });

  describe("a broken split", () => {
    const refusals: [string, string][] = [
      ["state-readable", `state-root-closed at ${STATE}`],
      ["code-owner", `private-owner at ${CODE}/package.json`],
      ["code-symlink", "private-owner at /tmp/agent-owned"],
      ["share-setgid", `share-setgid at ${SHARE}/files`],
      ["data-owner", "private-owner at /var/data:"],
      [
        "code-dir-link",
        "private-agent-write at /opt/split-rig-target/writable.js",
      ],
      ["code-hop-link", "private-owner at /opt/split-rig-hop:"],
      ["code-relative-link", "private-owner at /opt/split-rig-agent:"],
      // Three levels deep: the start walks the whole code tree (ruling 10).
      [
        "code-deep-acl",
        `private-agent-write at ${CODE}/server/backends/claude.ts`,
      ],
    ];
    // Each case is only a proof if the break is real: what the kernel reads
    // through the link as the server user, and what the agent user can write.
    const kernelReads: Record<string, [string, string]> = {
      "code-relative-link": [`${CODE}/split-rig-relative`, "agent-controlled"],
    };
    const agentWrites: Record<string, string> = {
      "code-deep-acl": `${CODE}/server/backends/claude.ts`,
    };

    // One container per case, all started at once; one test per case, so a
    // mutant shows each property it breaks.
    const names = new Map<string, string>();
    beforeAll(() => {
      for (const [brk] of refusals) names.set(brk, start(brk, brk));
    });

    for (const [brk, expected] of refusals)
      it(`refuses split mode at start: ${brk}`, async () => {
        const name = names.get(brk)!;
        const exit = await settle(name);
        const read = kernelReads[brk];
        if (read)
          expect(sh(name, "isomux-server", `cat ${read[0]}`).out).toBe(read[1]);
        const writable = agentWrites[brk];
        if (writable)
          expect(
            agentTry(name, `fs.closeSync(fs.openSync("${writable}", "r+"))`),
          ).toBe("ok");
        expect(exit).toBe(1);
        expect(logs(name)).toContain(`[split] refusing to start: ${expected}`);
      });

    it("refuses even when a false runner claims every try was denied", async () => {
      const name = start("stub", "state-readable", "stub");
      const exit = await settle(name);
      // The stub is there and gives a clean diagnostic.
      const answer = runnerRequest(name, "isomux-server", {
        op: "entry",
        name: "diagnose",
        input: {},
      });
      expect(answer[0]).toEqual({
        stdout: JSON.stringify({
          readState: "EACCES",
          writeCode: "EACCES",
          renameCode: "EACCES",
          createInShare: "EACCES",
        }),
      });
      // The agent user really can read the state here.
      expect(agentTry(name, `fs.readdirSync("${STATE}")`)).toBe("ok");
      expect(exit).toBe(1);
      expect(logs(name)).toContain(
        `[split] refusing to start: state-root-closed at ${STATE}`,
      );
      expect(logs(name)).not.toContain("runner diagnostic");
    });
  });
});
