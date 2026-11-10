// The first-launch gate of JsonRpcLiteClient (task 6e4e2012).
//
// Two Codex App Servers that start at the same time on a fresh CODEX_HOME race
// to create its state database, and one exits 1 before it answers initialize.
// In the office that failed the Codex account probe that ran next to
// onboarding's model list, and the member got a second sign-in notice. The
// client lets one launch open a cold home and makes the others wait for its
// initialize answer, at most a bound.
//
// The fake below models that race with real processes: on a home with no
// "ready" marker, the first start takes an O_EXCL lock, and a start that finds
// the lock taken exits 1. The marker is written before the initialize answer,
// as Codex creates its database before it answers.
import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  JsonRpcLiteClient,
  setCodexLaunchGateWaitMsForTests,
} from "./client.ts";
import type { InitializeParams } from "./_generated/InitializeParams.ts";

const INIT = {
  clientInfo: { name: "launch-gate-test", title: null, version: "0" },
  capabilities: null,
} as unknown as InitializeParams;

const roots: string[] = [];
const clients: JsonRpcLiteClient[] = [];

afterEach(async () => {
  setCodexLaunchGateWaitMsForTests(null);
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

// FAKE_MODE: "race" (default) models a Codex start; "die" exits 1 before it
// answers anything; "hang" reads stdin and never answers. Every start and
// every request method is logged as "<id> <event>".
const FAKE = [
  "#!/usr/bin/env bash",
  'echo "$FAKE_ID spawn" >> "$EVENT_LOG"',
  'case "$FAKE_MODE" in',
  "  die) sleep 0.2; exit 1 ;;",
  "  hang) while IFS= read -r line; do :; done; exit 0 ;;",
  "esac",
  'if [ ! -e "$CODEX_HOME/ready" ]; then',
  '  if ! ( set -o noclobber; : > "$CODEX_HOME/lock" ) 2>/dev/null; then',
  '    echo "Error: failed to initialize sqlite state runtime under $CODEX_HOME" >&2',
  "    exit 1",
  "  fi",
  '  sleep "${FAKE_OPEN_DELAY:-0.3}"',
  '  : > "$CODEX_HOME/ready"',
  "fi",
  "while IFS= read -r line; do",
  '  if [[ "$line" =~ \\"method\\":\\"([^\\"]+)\\" ]]; then',
  '    echo "$FAKE_ID ${BASH_REMATCH[1]}" >> "$EVENT_LOG"',
  "  fi",
  '  if [[ "$line" == *\'"method":"initialize"\'* ]] && [[ "$line" =~ \\"id\\":([0-9]+) ]]; then',
  '    printf \'{"id":%s,"result":{"userAgent":"fake/0.0.0"}}\\n\' "${BASH_REMATCH[1]}"',
  "  fi",
  "done",
  "",
].join("\n");

type Fixture = { root: string; bin: string; log: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "codex-launch-gate-"));
  roots.push(root);
  const bin = join(root, "fake-codex.sh");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  return { root, bin, log: join(root, "events.log") };
}

// A fresh CODEX_HOME: no state database yet.
function coldHome(fx: Fixture, name: string): string {
  const home = join(fx.root, name);
  mkdirSync(home);
  return home;
}

function client(
  fx: Fixture,
  home: string,
  id: string,
  opts: {
    mode?: "race" | "die" | "hang";
    openDelay?: string;
    apiKeyLogin?: boolean;
  } = {},
): JsonRpcLiteClient {
  const env: { [key: string]: string | undefined } = {
    ...process.env,
    CODEX_HOME: home,
    EVENT_LOG: fx.log,
    FAKE_ID: id,
    FAKE_MODE: opts.mode ?? "race",
    FAKE_OPEN_DELAY: opts.openDelay ?? "0.3",
  };
  delete env.OPENAI_API_KEY;
  if (opts.apiKeyLogin) env.OPENAI_API_KEY = "sk-launch-gate-test";
  const c = new JsonRpcLiteClient({
    codexBin: fx.bin,
    // "app-server" turns on the env-API-key login step in initialize().
    args: [opts.apiKeyLogin ? "app-server" : "fake"],
    cwd: fx.root,
    env,
    skipSafetyPreflightForTestProbe: true,
  });
  clients.push(c);
  return c;
}

function events(fx: Fixture): string[] {
  if (!existsSync(fx.log)) return [];
  return readFileSync(fx.log, "utf8").split("\n").filter(Boolean);
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs)
      throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

// start() and initialize(); the outcome and the time from the call.
async function launch(
  c: JsonRpcLiteClient,
): Promise<{ outcome: string; ms: number }> {
  const t0 = performance.now();
  try {
    await c.start();
    await c.initialize(INIT);
    return { outcome: "initialized", ms: performance.now() - t0 };
  } catch (err) {
    return {
      outcome: `rejected: ${(err as Error).message}`,
      ms: performance.now() - t0,
    };
  }
}

describe("JsonRpcLiteClient first launch on a cold CODEX_HOME", () => {
  it("the fake races like Codex: concurrent raw starts on a cold home lose one", async () => {
    // The enabling condition for the next test: without a gate, this fake
    // fails a concurrent start. A start that a loaded box delays until the
    // first one is ready does not lose, so the count is at least one.
    const fx = fixture();
    const home = coldHome(fx, "home");
    const procs = ["r1", "r2", "r3"].map((id) =>
      Bun.spawn([fx.bin], {
        env: {
          ...process.env,
          CODEX_HOME: home,
          EVENT_LOG: fx.log,
          FAKE_ID: id,
          FAKE_MODE: "race",
          FAKE_OPEN_DELAY: "0.3",
        },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    await waitFor(() => existsSync(join(home, "ready")), 5000);
    for (const p of procs) p.stdin.end();
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.filter((c) => c === 1).length).toBeGreaterThanOrEqual(1);
  });

  it("three clients started at once on a cold home all initialize, each with one App Server", async () => {
    const fx = fixture();
    const home = coldHome(fx, "home");
    const results = await Promise.all(
      ["a", "b", "c"].map((id) => launch(client(fx, home, id))),
    );
    expect(results.map((r) => r.outcome)).toEqual([
      "initialized",
      "initialized",
      "initialized",
    ]);
    expect(
      events(fx)
        .filter((e) => e.endsWith(" spawn"))
        .sort(),
    ).toEqual(["a spawn", "b spawn", "c spawn"]);
  }, 15_000);

  it("when the opener exits before it answers, one waiter opens the home and the others wait for it", async () => {
    const fx = fixture();
    const home = coldHome(fx, "home");
    const opener = launch(client(fx, home, "a", { mode: "die" }));
    await waitFor(() => events(fx).includes("a spawn"), 5000);
    const waiters = ["b", "c", "d"].map((id) => launch(client(fx, home, id)));
    expect((await opener).outcome).toMatch(/exited with code 1/);
    expect((await Promise.all(waiters)).map((r) => r.outcome)).toEqual([
      "initialized",
      "initialized",
      "initialized",
    ]);
  }, 15_000);

  it("an opener that exits before its caller sends initialize frees the home at the exit", async () => {
    setCodexLaunchGateWaitMsForTests(5000);
    const fx = fixture();
    const home = coldHome(fx, "home");
    // Only start(): no initialize request is pending when the fake exits.
    const opener = client(fx, home, "a", { mode: "die" });
    await opener.start();
    const waiter = await launch(client(fx, home, "b"));
    expect(opener.exitStatus()).toEqual({ code: 1, signal: null });
    expect(waiter.outcome).toBe("initialized");
    expect(waiter.ms).toBeLessThan(2500);
  }, 15_000);

  it("a launch waits at most the bound for an opener that never answers, and its answer makes the home ready", async () => {
    setCodexLaunchGateWaitMsForTests(1500);
    const fx = fixture();
    const home = coldHome(fx, "home");
    const hung = client(fx, home, "a", { mode: "hang" });
    void launch(hung);
    await waitFor(() => events(fx).includes("a spawn"), 5000);

    const waiter = await launch(client(fx, home, "b"));
    expect(waiter.outcome).toBe("initialized");
    // It waited for the hung opener (the gate was engaged), then the bound let
    // it go.
    expect(waiter.ms).toBeGreaterThanOrEqual(1300);
    expect(waiter.ms).toBeLessThan(1500 + 2000);

    // b's answer made the home ready: the next launch does not wait.
    const next = await launch(client(fx, home, "c"));
    expect(next.outcome).toBe("initialized");
    expect(next.ms).toBeLessThan(700);

    // The hung opener settles late (close). The home stays ready: a new hung
    // launch is not an opener that later launches wait for.
    await hung.close();
    void launch(client(fx, home, "d", { mode: "hang" }));
    await waitFor(() => events(fx).includes("d spawn"), 5000);
    const after = await launch(client(fx, home, "e"));
    expect(after.outcome).toBe("initialized");
    expect(after.ms).toBeLessThan(700);
  }, 20_000);

  it("close() on a waiting client rejects its start at once, and it never starts an App Server", async () => {
    setCodexLaunchGateWaitMsForTests(5000);
    const fx = fixture();
    const home = coldHome(fx, "home");
    const opener = launch(client(fx, home, "a", { openDelay: "1.5" }));
    await waitFor(() => events(fx).includes("a spawn"), 5000);

    const waiting = client(fx, home, "b");
    const started = waiting.start().then(
      () => "resolved",
      (err: Error) => `rejected: ${err.message}`,
    );
    await Bun.sleep(150);
    const t0 = performance.now();
    await waiting.close();
    expect(await started).toMatch(/JsonRpcLiteClient is closed/);
    expect(performance.now() - t0).toBeLessThan(500);

    expect((await opener).outcome).toBe("initialized");
    await Bun.sleep(200);
    expect(events(fx).filter((e) => e.startsWith("b "))).toEqual([]);
  }, 15_000);

  it("a launch on another home does not wait for a hung opener", async () => {
    setCodexLaunchGateWaitMsForTests(5000);
    const fx = fixture();
    void launch(client(fx, coldHome(fx, "home-1"), "a", { mode: "hang" }));
    await waitFor(() => events(fx).includes("a spawn"), 5000);
    const other = await launch(
      client(fx, coldHome(fx, "home-2"), "b", { openDelay: "0.05" }),
    );
    expect(other.outcome).toBe("initialized");
    expect(other.ms).toBeLessThan(700);
  }, 15_000);

  it("on a home that answered once, a launch does not wait for one that is still starting", async () => {
    setCodexLaunchGateWaitMsForTests(5000);
    const fx = fixture();
    const home = coldHome(fx, "home");
    expect((await launch(client(fx, home, "a"))).outcome).toBe("initialized");
    void launch(client(fx, home, "b", { mode: "hang" }));
    await waitFor(() => events(fx).includes("b spawn"), 5000);
    const next = await launch(client(fx, home, "c"));
    expect(next.outcome).toBe("initialized");
    expect(next.ms).toBeLessThan(700);
  }, 15_000);

  it("the home is ready at the initialize answer, before the API-key sign-in answers", async () => {
    setCodexLaunchGateWaitMsForTests(5000);
    const fx = fixture();
    const home = coldHome(fx, "home");
    // The fake never answers account/login/start, so a's initialize() stays
    // pending after the initialize answer.
    void launch(client(fx, home, "a", { apiKeyLogin: true }));
    await waitFor(() => events(fx).includes("a account/login/start"), 5000);
    const next = await launch(client(fx, home, "b"));
    expect(next.outcome).toBe("initialized");
    expect(next.ms).toBeLessThan(700);
  }, 15_000);
});
