// auto-deploy.sh, one tick at a time, against a local bare origin, a stub of
// GitHub's Build-runs API, a stub deploy.sh committed in the fixture repository
// and a stub of the check of what runs. Nothing here touches Docker, systemd or
// the network beyond loopback.
//
// The repositories are built once and copied for each test: a tick costs about
// 0.2 s, and the git setup would cost twice that again in every test.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const VPS = path.join(import.meta.dir, "vps");
const SCRIPT = path.join(VPS, "auto-deploy.sh");
const UNITS = [
  "isomux-hosted-autodeploy.service",
  "isomux-hosted-autodeploy.timer",
];

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const STUB_DEPLOY = `#!/usr/bin/env bash
# The fixture's deploy.sh: records its call, and acts as the test says.
held=free
flock -n "$ISOMUX_HOSTED_ROOT/deploy.lock" true || held=held
echo "$1 inherited=\${ISOMUX_HOSTED_LOCK_INHERITED:-} fd9=$(readlink /proc/$$/fd/9 2>/dev/null) lock=$held" >>"$STUB_DIR/deploy-calls"
code=$(cat "$STUB_DIR/deploy-exit" 2>/dev/null || echo 0)
if [[ $code == 0 ]]; then
  mkdir -p "$ISOMUX_HOSTED_ROOT/releases/$1"
  ln -sfn "$ISOMUX_HOSTED_ROOT/releases/$1" "$ISOMUX_HOSTED_ROOT/current"
  echo "$1" >"$STUB_DIR/running"
fi
if [[ -f $STUB_DIR/running-after ]]; then cp "$STUB_DIR/running-after" "$STUB_DIR/running"; fi
exit "$code"
`;

const STUB_PROBE = `#!/usr/bin/env bash
running=$(cat "$STUB_DIR/running")
[[ $running != none ]] && echo "$running"
`;

const STUB_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/systemctl-calls"
[[ $1 != "$(cat "$STUB_DIR/systemctl-fail" 2>/dev/null)" ]]
`;

interface RunJson {
  head_sha: string;
  run_number: number;
  status: string;
  conclusion: string | null;
}

interface Status {
  tick_at: string;
  deployed: string | null;
  result: string;
  phase: string;
  target: string | null;
  stopped: boolean;
  held: boolean;
  waiting: boolean;
  waiting_since: string | null;
  tick_error_since: string | null;
  units: string;
  last_attempt: {
    at: string | null;
    target: string | null;
    result: string | null;
  };
}

// The stub API: pages of runs, newest first, or a forced answer.
const api = {
  runs: [] as RunJson[],
  answer: null as null | { status: number; body: string },
  requests: 0,
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    api.requests++;
    const url = new URL(request.url);
    if (
      url.pathname !== "/repos/owner/repo/actions/workflows/build.yml/runs" ||
      url.searchParams.get("branch") !== "main" ||
      url.searchParams.get("event") !== "push"
    ) {
      return new Response("unexpected", { status: 404 });
    }
    if (api.answer) {
      return new Response(api.answer.body, { status: api.answer.status });
    }
    const per = Number(url.searchParams.get("per_page"));
    const page = Number(url.searchParams.get("page"));
    return Response.json({
      workflow_runs: api.runs.slice((page - 1) * per, page * per),
    });
  },
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
  }).trim();
}

// Built once: a bare origin whose main is the deployed commit, a work clone
// to commit from, and the decider's clone.
let template: string;
let deployed: string;
beforeAll(() => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), "auto-deploy-template-"));
  const origin = path.join(template, "origin.git");
  const work = path.join(template, "work");
  git(template, "init", "-q", "--bare", "-b", "main", origin);
  git(template, "init", "-q", "-b", "main", work);
  const files: Record<string, string> = {
    "README.md": "fixture\n",
    "control-plane/store.ts": "export {};\n",
    "control-plane/deploy/vps/compose.yaml": "services: {}\n",
    "control-plane/deploy/vps/deploy.sh": STUB_DEPLOY,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  fs.chmodSync(path.join(work, "control-plane/deploy/vps/deploy.sh"), 0o755);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "deployed");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "HEAD:main");
  git(
    template,
    "clone",
    "-q",
    "-b",
    "main",
    origin,
    path.join(template, "src"),
  );
  deployed = git(work, "rev-parse", "HEAD");
});

afterAll(() => {
  void server.stop(true);
  fs.rmSync(template, { recursive: true, force: true });
});

let dir: string;
let work: string;
let src: string;
let root: string;
let envDir: string;
let stub: string;
let units: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-deploy-test-"));
  execFileSync("cp", ["-a", `${template}/.`, dir]);
  work = path.join(dir, "work");
  src = path.join(dir, "src");
  for (const clone of [work, src]) {
    git(clone, "remote", "set-url", "origin", path.join(dir, "origin.git"));
  }
  root = path.join(dir, "root");
  envDir = path.join(dir, "env");
  stub = path.join(dir, "stub");
  units = path.join(dir, "units");
  for (const d of [root, stub, units]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(envDir, "generated"), {
    recursive: true,
    mode: 0o700,
  });
  fs.chmodSync(envDir, 0o700);
  fs.writeFileSync(path.join(envDir, "generated", "installed"), "");
  fs.writeFileSync(
    path.join(envDir, "auto-deploy.env"),
    `ISOMUX_HOSTED_SRC=${src}\nISOMUX_HOSTED_GITHUB_REPO=owner/repo\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(root, "release.env"),
    "ISOMUX_HOSTED_PROJECT=fixture\n",
  );
  fs.writeFileSync(path.join(stub, "probe"), STUB_PROBE, { mode: 0o755 });
  fs.writeFileSync(path.join(stub, "systemctl"), STUB_SYSTEMCTL, {
    mode: 0o755,
  });
  deployAt(deployed);
  api.runs = [];
  api.answer = null;
  api.requests = 0;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Commit the given files (null deletes) in the work clone and push main. */
function commit(files: Record<string, string | null>): string {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(work, file);
    if (content === null) fs.rmSync(full);
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "change");
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

const change = (n = 1) =>
  commit({ "control-plane/store.ts": `export const a = ${n};\n` });

function green(sha: string, run_number = 1): RunJson {
  return {
    head_sha: sha,
    run_number,
    status: "completed",
    conclusion: "success",
  };
}

function deployAt(commit: string) {
  fs.mkdirSync(path.join(root, "releases", commit), { recursive: true });
  fs.rmSync(path.join(root, "current"), { force: true });
  fs.symlinkSync(
    path.join(root, "releases", commit),
    path.join(root, "current"),
  );
  fs.writeFileSync(path.join(stub, "running"), `${commit}\n`);
}

async function tick(
  options: { script?: string; probe?: boolean } = {},
): Promise<Status> {
  const proc = Bun.spawn(["bash", options.script ?? SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...GIT_ENV,
      STUB_DIR: stub,
      ISOMUX_HOSTED_ENV_DIR: envDir,
      ISOMUX_HOSTED_ROOT: root,
      ISOMUX_HOSTED_GITHUB_API: `http://127.0.0.1:${server.port}`,
      ISOMUX_HOSTED_BUN: process.execPath,
      ...(options.probe === false
        ? {}
        : { ISOMUX_HOSTED_PROBE: path.join(stub, "probe") }),
      ISOMUX_HOSTED_UNIT_DIR: units,
      ISOMUX_HOSTED_SYSTEMCTL: path.join(stub, "systemctl"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
  return JSON.parse(
    fs.readFileSync(path.join(root, "auto-deploy", "status.json"), "utf8"),
  ) as Status;
}

function lines(file: string): string[] {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n")
    : [];
}
const deployCalls = () => lines(path.join(stub, "deploy-calls"));
const failedList = () => lines(path.join(root, "auto-deploy", "failed"));
const systemctlCalls = () => lines(path.join(stub, "systemctl-calls"));

describe("which commits deploy", () => {
  test("a change outside the Hosted inputs deploys nothing and asks no API", async () => {
    commit({
      "README.md": "changed\n",
      "server/index.ts": "x\n",
      "deploy/other.sh": "x\n",
    });
    expect(await tick()).toMatchObject({
      result: "up_to_date",
      deployed,
      waiting: false,
    });
    expect(api.requests).toBe(0);
    expect(deployCalls()).toEqual([]);
  });

  for (const [what, files] of [
    ["a web file", { "control-plane/web/app/page.tsx": "x\n" }],
    ["a test file", { "control-plane/store.test.ts": "x\n" }],
    ["the installer", { "deploy/install.sh": "x\n" }],
    ["the root .dockerignore", { ".dockerignore": "*\n" }],
    ["a deleted file", { "control-plane/store.ts": null }],
  ] as const) {
    test(`${what} is a Hosted input`, async () => {
      const t = commit(files);
      api.runs = [green(t)];
      expect(await tick()).toMatchObject({ result: "deployed", deployed: t });
    });
  }

  test("a rename into control-plane and one out of it are both inputs", async () => {
    commit({ "docs/moved.md": "x\n" });
    const docs = git(work, "rev-parse", "HEAD");
    git(work, "mv", "docs/moved.md", "control-plane/moved.md");
    git(work, "commit", "-q", "-m", "in");
    const into = git(work, "rev-parse", "HEAD");
    git(work, "mv", "control-plane/moved.md", "docs/moved.md");
    git(work, "commit", "-q", "-m", "out");
    git(work, "push", "-q", "origin", "HEAD:main");
    const out = git(work, "rev-parse", "HEAD");
    // Deployed at the commit after the move in: only the move out is left.
    deployAt(into);
    api.runs = [green(out)];
    expect(await tick()).toMatchObject({ result: "deployed", deployed: out });
    // Deployed before it: only the move in.
    deployAt(docs);
    git(work, "reset", "-q", "--hard", into);
    git(work, "push", "-q", "-f", "origin", "HEAD:main");
    api.runs = [green(into)];
    expect(await tick()).toMatchObject({ result: "deployed", deployed: into });
  });

  test("an input change waits for a green Build", async () => {
    const t = change();
    api.runs = [
      { head_sha: t, run_number: 1, status: "in_progress", conclusion: null },
    ];
    const status = await tick();
    expect(status).toMatchObject({
      result: "waiting",
      waiting: true,
      deployed,
    });
    expect(status.waiting_since).not.toBeNull();
    expect(deployCalls()).toEqual([]);
  });

  test("a green input change deploys with T's deploy.sh under the held lock", async () => {
    const t = change();
    api.runs = [green(t)];
    expect(await tick()).toMatchObject({
      result: "deployed",
      deployed: t,
      target: t,
      waiting: false,
      waiting_since: null,
      last_attempt: { target: t, result: "deployed" },
    });
    const lock = fs.realpathSync(path.join(root, "deploy.lock"));
    expect(deployCalls()).toEqual([`${t} inherited=1 fd9=${lock} lock=held`]);
    expect(git(src, "rev-parse", "HEAD")).toBe(t);
  });

  test("the newest green commit in main's ancestry wins, not the newest run", async () => {
    const older = change(1);
    const newer = change(2);
    // The older commit's run is listed first, as a rerun would put it.
    api.runs = [green(older, 9), { ...green(newer, 8), conclusion: "failure" }];
    // The newer commit's input change still waits.
    expect(await tick()).toMatchObject({
      result: "deployed",
      deployed: older,
      waiting: true,
    });
  });

  test("a sha's newest run decides: a red rerun is red, a green rerun is green", async () => {
    const t = change();
    api.runs = [{ ...green(t, 11), conclusion: "failure" }, green(t, 10)];
    expect(await tick()).toMatchObject({ result: "waiting", deployed });
    api.runs = [green(t, 12), { ...green(t, 11), conclusion: "failure" }];
    expect(await tick()).toMatchObject({ result: "deployed", deployed: t });
  });

  test("a green commit with no input change since the deployed one waits for the next", async () => {
    const docs = commit({ "README.md": "x\n" });
    change();
    api.runs = [green(docs)];
    expect(await tick()).toMatchObject({ result: "waiting", deployed });
    expect(deployCalls()).toEqual([]);
  });

  const other = (n: number) =>
    green(n.toString(16).padStart(40, "0"), 1000 - n);

  test("runs are read page by page", async () => {
    const t = change();
    api.runs = [...Array.from({ length: 100 }, (_, n) => other(n)), green(t)];
    expect(await tick()).toMatchObject({ result: "deployed", deployed: t });
    expect(api.requests).toBe(2);
  });

  test("a candidate beyond three pages is not green", async () => {
    const t = change();
    api.runs = [...Array.from({ length: 300 }, (_, n) => other(n)), green(t)];
    expect(await tick()).toMatchObject({ result: "waiting", deployed });
    expect(api.requests).toBe(3);
  });

  test("a commit that changes compose.yaml is left for a manual deploy", async () => {
    const t = commit({
      "control-plane/deploy/vps/compose.yaml": "services: {a: {}}\n",
    });
    api.runs = [green(t)];
    expect(await tick()).toMatchObject({
      result: "manual_deploy_needed",
      target: t,
      waiting: true,
    });
    expect(deployCalls()).toEqual([]);
  });

  test("a deployed commit that is not on main deploys nothing", async () => {
    const side = git(
      work,
      "commit-tree",
      "-p",
      deployed,
      "-m",
      "side",
      `${deployed}^{tree}`,
    );
    git(work, "push", "-q", "origin", `${side}:refs/heads/side`);
    git(src, "fetch", "-q", "origin", "side");
    deployAt(side);
    change();
    expect(await tick()).toMatchObject({ result: "diverged", deployed: side });
    expect(api.requests).toBe(0);
  });
});

describe("fail closed", () => {
  for (const [what, answer] of [
    ["a 500", { status: 500, body: "{}" }],
    ["a rate limit", { status: 403, body: '{"message":"rate limit"}' }],
    ["an answer that is not JSON", { status: 200, body: "not json" }],
    [
      "a run without its fields",
      { status: 200, body: '{"workflow_runs":[{"head_sha":"zz"}]}' },
    ],
    ["an answer without runs", { status: 200, body: '{"runs":[]}' }],
  ] as const) {
    test(`${what} is a tick error that marks no commit`, async () => {
      change();
      api.answer = answer;
      const status = await tick();
      expect(status).toMatchObject({ result: "tick_error", phase: "api" });
      expect(status.tick_error_since).not.toBeNull();
      expect(deployCalls()).toEqual([]);
      expect(failedList()).toEqual([]);
    });
  }

  test("a tick error keeps its start, and clears on the next run that reads the API", async () => {
    const t = change();
    api.answer = { status: 500, body: "{}" };
    const since = (await tick()).tick_error_since;
    expect(since).not.toBeNull();
    expect((await tick()).tick_error_since).toBe(since);
    api.answer = null;
    api.runs = [green(t)];
    expect(await tick()).toMatchObject({
      result: "deployed",
      tick_error_since: null,
    });
  });

  test("a failed fetch is a tick error", async () => {
    change();
    git(src, "remote", "set-url", "origin", path.join(dir, "missing.git"));
    expect(await tick()).toMatchObject({
      result: "tick_error",
      phase: "fetch",
    });
  });

  test("a clone with local changes is not deployed from", async () => {
    api.runs = [green(change())];
    fs.writeFileSync(path.join(src, "README.md"), "local edit\n");
    expect(await tick()).toMatchObject({
      result: "tick_error",
      phase: "clone",
    });
    expect(deployCalls()).toEqual([]);
  });

  test("an install that --prepare left deploys nothing", async () => {
    api.runs = [green(change())];
    fs.writeFileSync(path.join(envDir, "generated", "prepared"), "");
    expect(await tick()).toMatchObject({
      result: "refused",
      phase: "install",
    });
    expect(deployCalls()).toEqual([]);
  });

  test("a hold deploys nothing", async () => {
    api.runs = [green(change())];
    fs.writeFileSync(path.join(envDir, "auto-deploy.hold"), "");
    expect(await tick()).toMatchObject({
      result: "held",
      held: true,
      deployed,
    });
    expect(deployCalls()).toEqual([]);
  });

  test("a held lock deploys nothing and leaves the units alone", async () => {
    api.runs = [green(change())];
    for (const name of UNITS) fs.writeFileSync(path.join(units, name), "old\n");
    // One process holds the lock and says so; killing it frees the lock.
    const holder = Bun.spawn(
      [
        "bash",
        "-c",
        'exec 9>"$0"; flock 9; echo ready; exec sleep 30',
        path.join(root, "deploy.lock"),
      ],
      { stdout: "pipe" },
    );
    const ready = await holder.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    try {
      expect(await tick()).toMatchObject({
        result: "locked",
        units: "unchecked",
      });
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(deployCalls()).toEqual([]);
    for (const name of UNITS) {
      expect(fs.readFileSync(path.join(units, name), "utf8")).toBe("old\n");
    }
  });

  test("a config file that is not private refuses", async () => {
    fs.chmodSync(path.join(envDir, "auto-deploy.env"), 0o644);
    expect(await tick()).toMatchObject({ result: "error", phase: "config" });
    expect(deployCalls()).toEqual([]);
  });
});

describe("a failed deploy", () => {
  test("a rollback marks the commit failed, and it is never tried again", async () => {
    const t = change();
    api.runs = [green(t)];
    fs.writeFileSync(path.join(stub, "deploy-exit"), "5");
    expect(await tick()).toMatchObject({
      result: "rolled_back",
      deployed,
      target: t,
      stopped: false,
      last_attempt: { target: t, result: "rolled_back" },
    });
    expect(failedList()).toEqual([t]);
    // The attempt stays in the status after a run that does not deploy.
    expect(await tick()).toMatchObject({
      result: "failed_target",
      target: t,
      last_attempt: { target: t, result: "rolled_back" },
    });
    expect(deployCalls()).toHaveLength(1);
  });

  test("a newer green commit deploys after a failed one", async () => {
    const t = change(1);
    const next = change(2);
    fs.mkdirSync(path.join(root, "auto-deploy"), { recursive: true });
    fs.writeFileSync(path.join(root, "auto-deploy", "failed"), `${t}\n`);
    api.runs = [green(next), green(t)];
    expect(await tick()).toMatchObject({ result: "deployed", deployed: next });
  });

  test("when the old release does not run healthy afterwards, unattended deploys stop", async () => {
    api.runs = [green(change())];
    fs.writeFileSync(path.join(stub, "deploy-exit"), "5");
    fs.writeFileSync(path.join(stub, "running-after"), "none\n");
    expect(await tick()).toMatchObject({
      result: "rollback_failed",
      stopped: true,
    });
    fs.rmSync(path.join(stub, "running-after"));
    fs.writeFileSync(path.join(stub, "running"), `${deployed}\n`);
    expect(await tick()).toMatchObject({ result: "stopped", stopped: true });
    expect(deployCalls()).toHaveLength(1);
  });

  test("deleting the stopped marker lets the next run deploy", async () => {
    const t = change();
    api.runs = [green(t)];
    fs.mkdirSync(path.join(root, "auto-deploy"), { recursive: true });
    fs.writeFileSync(path.join(root, "auto-deploy", "stopped"), "");
    expect(await tick()).toMatchObject({ result: "stopped" });
    fs.rmSync(path.join(root, "auto-deploy", "stopped"));
    expect(await tick()).toMatchObject({
      result: "deployed",
      deployed: t,
      stopped: false,
    });
  });

  test("a deploy.sh that reports success while the new release does not run stops too", async () => {
    api.runs = [green(change())];
    fs.writeFileSync(path.join(stub, "running-after"), `${deployed}\n`);
    expect(await tick()).toMatchObject({
      result: "rollback_failed",
      stopped: true,
    });
  });

  test("a failure before the swap is retried twice before the commit is marked", async () => {
    const t = change();
    api.runs = [green(t)];
    fs.writeFileSync(path.join(stub, "deploy-exit"), "1");
    expect(await tick()).toMatchObject({ result: "build_failed" });
    expect(failedList()).toEqual([]);
    // The second failure takes the same path as the first; start from it.
    fs.writeFileSync(path.join(root, "auto-deploy", "attempts", t), "2\n");
    expect(await tick()).toMatchObject({ result: "failed", phase: "build" });
    expect(failedList()).toEqual([t]);
    expect(deployCalls()).toHaveLength(2);
  });

  test("the check of what runs comes from the release that started the run", async () => {
    // The run starts through `current`, as the service does. The deployed
    // release's check reads the stub; the candidate's would pass anything.
    const vps = (commit: string) =>
      path.join(root, "releases", commit, "control-plane", "deploy", "vps");
    fs.mkdirSync(vps(deployed), { recursive: true });
    for (const file of ["auto-deploy.sh", "build-runs.ts", ...UNITS]) {
      fs.copyFileSync(path.join(VPS, file), path.join(vps(deployed), file));
    }
    fs.writeFileSync(
      path.join(vps(deployed), "running.sh"),
      'release_healthy() { [[ $(cat "$STUB_DIR/running") == "$1" ]]; }\n',
    );
    const t = change();
    fs.mkdirSync(vps(t), { recursive: true });
    fs.writeFileSync(
      path.join(vps(t), "running.sh"),
      "release_healthy() { return 0; }\n",
    );
    api.runs = [green(t)];
    fs.writeFileSync(path.join(stub, "running-after"), "none\n");
    const viaCurrent = path.join(
      root,
      "current",
      "control-plane",
      "deploy",
      "vps",
      "auto-deploy.sh",
    );
    expect(await tick({ script: viaCurrent, probe: false })).toMatchObject({
      result: "rollback_failed",
      stopped: true,
    });
  });
});

describe("the installed units", () => {
  test("units that were never installed are left alone", async () => {
    expect((await tick()).units).toBe("absent");
    expect(fs.readdirSync(units)).toEqual([]);
  });

  test("installed units follow the release's copies", async () => {
    for (const name of UNITS) fs.writeFileSync(path.join(units, name), "old\n");
    expect((await tick()).units).toBe("ok");
    for (const name of UNITS) {
      expect(fs.readFileSync(path.join(units, name), "utf8")).toBe(
        fs.readFileSync(path.join(VPS, name), "utf8"),
      );
    }
    expect(systemctlCalls()).toEqual([
      "daemon-reload",
      "restart isomux-hosted-autodeploy.timer",
    ]);
    expect((await tick()).units).toBe("ok");
    expect(systemctlCalls()).toHaveLength(2);
  });

  test("a failed write is retried", async () => {
    for (const name of UNITS) fs.writeFileSync(path.join(units, name), "old\n");
    fs.chmodSync(units, 0o500);
    try {
      expect((await tick()).units).toBe("error");
    } finally {
      fs.chmodSync(units, 0o700);
    }
    expect((await tick()).units).toBe("ok");
    expect(systemctlCalls()).toEqual([
      "daemon-reload",
      "restart isomux-hosted-autodeploy.timer",
    ]);
  });

  test("a failed reload, and then a failed timer restart, are each retried", async () => {
    for (const name of UNITS) fs.writeFileSync(path.join(units, name), "old\n");
    fs.writeFileSync(path.join(stub, "systemctl-fail"), "daemon-reload");
    expect((await tick()).units).toBe("error");
    expect(systemctlCalls()).toEqual(["daemon-reload"]);
    fs.writeFileSync(path.join(stub, "systemctl-fail"), "restart");
    expect((await tick()).units).toBe("error");
    expect(systemctlCalls()).toEqual([
      "daemon-reload",
      "daemon-reload",
      "restart isomux-hosted-autodeploy.timer",
    ]);
    fs.rmSync(path.join(stub, "systemctl-fail"));
    expect((await tick()).units).toBe("ok");
    expect(systemctlCalls()).toHaveLength(5);
    expect((await tick()).units).toBe("ok");
    expect(systemctlCalls()).toHaveLength(5);
  });
});

test("the status file holds exactly the documented fields", async () => {
  const status = await tick();
  expect(Object.keys(status).sort()).toEqual(
    [
      "deployed",
      "held",
      "last_attempt",
      "phase",
      "result",
      "stopped",
      "target",
      "tick_at",
      "tick_error_since",
      "units",
      "waiting",
      "waiting_since",
    ].sort(),
  );
  expect(Date.parse(status.tick_at)).not.toBeNaN();
});

test("waiting_since is shown only while waiting", async () => {
  change();
  expect((await tick()).waiting_since).not.toBeNull();
  fs.writeFileSync(path.join(envDir, "auto-deploy.hold"), "");
  expect(await tick()).toMatchObject({
    result: "held",
    waiting: false,
    waiting_since: null,
  });
});
