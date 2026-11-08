// An isolated child (spawnChild with isolate) on both agent hosts: the local
// host and the agent runner (split mode), with a real bwrap. The child is the
// outer bwrap; the command runs inside a new PID namespace. Skips where this
// host cannot make one (checked directly, never through the office's probe).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  localAgentHost,
  type AgentChild,
  type AgentHost,
} from "./agent-host.ts";
import { RunnerAgentHost } from "./agent-runner/client.ts";
import { startRunner } from "./agent-runner/runner.ts";
import {
  ISOLATION_SETUP_FAILED,
  isolatedArgv,
  probeProcessIsolation,
} from "./process-isolation.ts";
import {
  bwrapMakesPidNamespace,
  killMarked,
  pidsWith,
  waitFor,
} from "./test-support/process-markers.ts";

const pidNamespaces = bwrapMakesPidNamespace();

let dir: string;
let marker: string;
let runner: { stop(): void } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "process-isolation-host-"));
  marker = `iso-host-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  killMarked(marker);
  runner?.stop();
  runner = null;
  rmSync(dir, { recursive: true, force: true });
});

const hosts: [string, () => Promise<AgentHost>][] = [
  ["local host", async () => localAgentHost],
  [
    "agent runner",
    async () => {
      const socketPath = join(dir, "runner.sock");
      runner = startRunner({
        socketPath,
        serverUid: process.getuid!(),
        readPeerUid: () => process.getuid!(),
        killGraceMs: 300,
      });
      return RunnerAgentHost.connect(socketPath);
    },
  ],
];

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// Every event of a child, in order; done resolves at close.
function record(child: AgentChild): { events: string[]; done: Promise<void> } {
  const events: string[] = [];
  child.on("spawn", () => events.push("spawn"));
  child.on("exit", (code, signal) => events.push(`exit:${code}:${signal}`));
  child.on("error", (error: NodeJS.ErrnoException) =>
    events.push(`error:${error.code}`),
  );
  const done = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  return { events, done };
}

async function stdoutOf(child: AgentChild): Promise<string> {
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return out;
}

// A command that traps SIGTERM and takes half a second to clean up before it
// writes `${dir}/${name}.graceful`, so a SIGKILL that follows the signal at
// once leaves no file. It starts a marked background sleep (its output
// closed, so it cannot hold the child's stdout open), prints "ready" and
// waits.
function slowCleanup(name: string, extra = "", seconds = 0.5): string {
  return script(
    `${name}.sh`,
    `trap 'sleep ${seconds}; echo graceful > ${dir}/${name}.graceful; exit 0' TERM
(exec -a ${marker}-${name}-bg sleep 300) </dev/null >/dev/null 2>&1 &
${extra}
echo ready
wait; wait`,
  );
}

async function ready(child: AgentChild): Promise<void> {
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    let out = "";
    const onData = (chunk: string) => {
      out += chunk;
      if (out.includes("ready")) {
        child.stdout.off("data", onData);
        child.stdout.resume();
        resolve();
      }
    };
    child.stdout.on("data", onData);
  });
}

describe.skipIf(!pidNamespaces).each(hosts)(
  "isolated child on the %s",
  (_name, makeHost) => {
    let host: AgentHost;
    beforeEach(async () => {
      host = await makeHost();
    });

    it("does not show the command processes outside its namespace", async () => {
      const outside = Bun.spawn([
        "bash",
        "-c",
        `exec -a ${marker}-outside sleep 300`,
      ]);
      try {
        expect(
          await waitFor(() => pidsWith(`${marker}-outside`).length === 1),
        ).toBe(true);
        const list = ["bash", "-c", "cat /proc/[0-9]*/cmdline | tr '\\0' ' '"];
        const inside = await stdoutOf(host.spawnChild(list, { isolate: true }));
        // The enabling condition: the listing read the namespace's own processes.
        // Booleans, not the listing: a failure must not print every command
        // line on the host.
        expect(inside.includes("cat")).toBe(true);
        expect(inside.includes(`${marker}-outside`)).toBe(false);
        // The control: the same listing without isolate sees the process.
        const plain = await stdoutOf(host.spawnChild(list));
        expect(plain.includes(`${marker}-outside`)).toBe(true);
      } finally {
        outside.kill("SIGKILL");
      }
    });

    it("lets the command clean up on kill(SIGTERM), then ends the whole namespace", async () => {
      const child = host.spawnChild([slowCleanup("kill")], { isolate: true });
      const { done } = record(child);
      await ready(child);
      expect(
        await waitFor(() => pidsWith(`${marker}-kill-bg`).length === 1),
      ).toBe(true);
      child.kill("SIGTERM");
      await done;
      expect(existsSync(join(dir, "kill.graceful"))).toBe(true);
      expect(
        await waitFor(() => pidsWith(`${marker}-kill-bg`).length === 0, 1000),
      ).toBe(true);
    });

    // signalGroup reaches a whole launcher tree today (the Codex close path
    // relies on it). Inside a namespace it reaches a process that left the
    // group too, and the command still gets its clean-up time.
    it("signals every process in the namespace on signalGroup(SIGTERM)", async () => {
      // own-session.sh says it is ready only after its trap is set, and the
      // command waits for that before it says ready itself.
      const own = script(
        "own-session.sh",
        `trap 'sleep 0.3; echo graceful > ${dir}/own.graceful; exit 0' TERM
touch ${dir}/own.ready
sleep 300 & wait`,
      );
      const child = host.spawnChild(
        [
          slowCleanup(
            "group",
            `setsid ${own} </dev/null >/dev/null 2>&1 &
while [ ! -e ${dir}/own.ready ]; do sleep 0.01; done`,
          ),
        ],
        { isolate: true },
      );
      const { done } = record(child);
      await ready(child);
      child.signalGroup("SIGTERM");
      await done;
      expect(existsSync(join(dir, "group.graceful"))).toBe(true);
      expect(
        await waitFor(() => existsSync(join(dir, "own.graceful")), 1000),
      ).toBe(true);
    });

    it("ends the whole namespace at once on kill(SIGKILL)", async () => {
      const child = host.spawnChild([slowCleanup("sigkill")], {
        isolate: true,
      });
      const { done } = record(child);
      await ready(child);
      expect(
        await waitFor(() => pidsWith(`${marker}-sigkill-bg`).length === 1),
      ).toBe(true);
      child.kill("SIGKILL");
      await done;
      expect(
        await waitFor(
          () => pidsWith(`${marker}-sigkill-bg`).length === 0,
          1000,
        ),
      ).toBe(true);
      expect(existsSync(join(dir, "sigkill.graceful"))).toBe(false);
    });

    // The real bwrap, first on the child's PATH behind a wrapper that adds a
    // bind of a missing source: bwrap reports its child pid, then fails its
    // setup. The command never runs, and the start fails as an error, not as
    // the command's exit.
    it("reports a failed bwrap setup as an error and never runs the command", async () => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "bwrap"),
        `#!/bin/bash\nexec ${Bun.which("bwrap")} --bind ${dir}/missing ${dir}/target "$@"\n`,
      );
      chmodSync(join(bin, "bwrap"), 0o755);
      const ran = join(dir, "ran");
      const child = host.spawnChild(["bash", "-c", `echo yes > ${ran}`], {
        isolate: true,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const { events, done } = record(child);
      await done;
      expect(existsSync(ran)).toBe(false);
      expect(events).toContain(`error:${ISOLATION_SETUP_FAILED}`);
    });

    it("reports the command's own failing exit as an exit, not a setup error", async () => {
      const child = host.spawnChild(["bash", "-c", "exit 3"], {
        isolate: true,
      });
      const { events, done } = record(child);
      await done;
      expect(events).toContain("exit:3:null");
      expect(events.filter((event) => event.startsWith("error"))).toEqual([]);
    });
  },
);

// Headless Chrome inside the namespace (task ffb7007c): wherever the probe
// turns isolation on, agents must still reach a local page with a browser.
// On Ubuntu with bwrap's AppArmor profile, Chrome there gets no network, so
// the probe must say not available. The case passes at once where the probe
// says not available, as in an agent session, where a nested bwrap fails; it
// tests something only where bwrap works, for example under systemd-run --user.
const chrome = Bun.which("google-chrome") ?? Bun.which("chromium");
describe.skipIf(chrome === null || Bun.which("bwrap") === null)(
  "headless Chrome in the namespace",
  () => {
    it("loads a 127.0.0.1 page wherever the probe turns isolation on", async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(`<p>${marker}</p>`, {
            headers: { "content-type": "text/html" },
          }),
      });
      const load = (wrap: boolean) => {
        const argv = [
          "timeout",
          "30",
          chrome!,
          "--headless=new",
          "--no-sandbox",
          `--user-data-dir=${join(dir, wrap ? "inside" : "outside")}`,
          "--dump-dom",
          `http://127.0.0.1:${server.port}/`,
        ];
        return localAgentHost.run(
          wrap ? isolatedArgv(argv, { dieWithParent: true }) : argv,
        );
      };
      try {
        const probe = await probeProcessIsolation({
          platform: process.platform,
          env: process.env,
          run: (argv, options) => localAgentHost.run(argv, options),
        });
        if (!probe.available) return;
        // The control: Chrome loads the page outside the namespace.
        expect((await load(false)).stdout.includes(marker)).toBe(true);
        // A failed load dumps Chrome's error page, which names the net error.
        const inside = await load(true);
        expect({
          loaded: inside.stdout.includes(marker),
          error: /\bERR_[A-Z_]+/.exec(inside.stdout)?.[0] ?? null,
        }).toEqual({ loaded: true, error: null });
      } finally {
        await server.stop(true);
      }
    }, 90_000);
  },
);

// The runner stops what a connection started when the connection ends (the
// server went away). For an isolated child that stop also gives the command
// its clean-up time: here 0.1 s, inside the runner's 300 ms grace.
describe.skipIf(!pidNamespaces)(
  "isolated child when the runner connection ends",
  () => {
    it("lets the command clean up, then ends the namespace", async () => {
      const host = await hosts[1][1]();
      const child = host.spawnChild([slowCleanup("lost", "", 0.1)], {
        isolate: true,
      });
      await ready(child);
      expect(
        await waitFor(() => pidsWith(`${marker}-lost-bg`).length === 1),
      ).toBe(true);
      runner!.stop();
      runner = null;
      expect(
        await waitFor(() => existsSync(join(dir, "lost.graceful")), 1000),
      ).toBe(true);
      expect(
        await waitFor(() => pidsWith(`${marker}-lost-bg`).length === 0, 1000),
      ).toBe(true);
    });
  },
);

// Task 14e12aa8: the Codex client's SIGKILL escalation fires after its grace
// even when the child has exited. By then an isolated child's namespace is
// gone (--die-with-parent), and the outer pid may be another process's, so
// signalGroup must signal nothing. Runs wherever bwrap exists: where it
// cannot make a namespace, its failed setup is an exited child too.
describe.skipIf(Bun.which("bwrap") === null)(
  "isolated child on the local host, after it exited",
  () => {
    it("signals nothing on signalGroup", async () => {
      const child = localAgentHost.spawnChild(["true"], { isolate: true });
      const { done } = record(child);
      await done;
      // Recorded, never sent: a wrong signal must not reach a real process.
      const kill = spyOn(process, "kill").mockImplementation(() => true);
      try {
        child.signalGroup("SIGKILL");
        child.signalGroup("SIGTERM");
        // The enabling condition: an outer bwrap that started and exited.
        expect({
          started: child.pid !== undefined,
          exited: child.exitCode !== null || child.signalCode !== null,
          signals: kill.mock.calls.length,
        }).toEqual({ started: true, exited: true, signals: 0 });
      } finally {
        kill.mockRestore();
      }
    });
  },
);
