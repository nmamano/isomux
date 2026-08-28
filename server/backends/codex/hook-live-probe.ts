// Opt-in live integration probe for Codex 0.144.6 PreToolUse behavior.
//
// This script makes coverage claims only from model-driven App Server turns.
// It never reads or writes the effective Isomux CODEX_HOME. The caller must
// name an auth source, which is copied into a fresh /tmp CODEX_HOME replica.
//
// Run through hook-live-probe.test.ts so a missing opt-in prints as a skip.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";
import { JsonRpcLiteClient, PASS } from "./client.ts";
import {
  copyScratchAuth,
  readHookPayloads,
  trustHook,
  type HookBehavior,
  writeHookFixture,
} from "./hook-probe-fixture.ts";

type Json = Record<string, unknown>;
type ActionKind = "bash" | "apply_patch" | "dynamic_tool" | "mcp";
type SessionMode = "start" | "resume" | "fork" | "one-shot";

interface Reading {
  action: ActionKind;
  behavior: HookBehavior | "untrusted";
  sessionMode: SessionMode;
  emitted: boolean;
  sideEffect: boolean;
  blocked: boolean;
  hookStatus: string[];
  hookDurationMs: number[];
  hookRuns: Json[];
  payloads: unknown[];
  itemTypes: string[];
  wallMs: number;
  error?: string;
  hookListing?: Json;
  homeLayout?: "default-replica" | "per-user-override" | "managed-system";
  userHookPayloads?: unknown[];
}

const enabled = process.env.ISOMUX_TEST_CODEX_HOOK_LIVE === "1";
const authHome = process.env.ISOMUX_TEST_CODEX_AUTH_HOME;
const model = process.env.ISOMUX_TEST_CODEX_MODEL ?? "gpt-5.6-sol";
const runCount = Number(process.env.ISOMUX_TEST_CODEX_HOOK_RUNS ?? "1");
const outerDeadlineMs = Number(
  process.env.ISOMUX_TEST_CODEX_HOOK_DEADLINE_MS ?? "90000",
);
const selectedActions = (
  process.env.ISOMUX_TEST_CODEX_HOOK_ACTIONS ??
  "bash,apply_patch,dynamic_tool,mcp"
).split(",") as ActionKind[];
const selectedControls = (
  process.env.ISOMUX_TEST_CODEX_HOOK_CONTROLS ?? "allow,deny,untrusted"
).split(",") as Array<HookBehavior | "untrusted">;
const includeSessionModes =
  process.env.ISOMUX_TEST_CODEX_HOOK_SESSION_MODES !== "0";
const includeFailures = process.env.ISOMUX_TEST_CODEX_HOOK_FAILURES !== "0";
const includeMatrix = process.env.ISOMUX_TEST_CODEX_HOOK_MATRIX !== "0";
const includeManaged = process.env.ISOMUX_TEST_CODEX_HOOK_MANAGED !== "0";
const includeReload = process.env.ISOMUX_TEST_CODEX_HOOK_RELOAD !== "0";
const scratchRoots = new Set<string>();

function makeScratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.add(root);
  return root;
}

function removeScratchRoot(root: string): void {
  scratchRoots.delete(root);
  rmSync(root, { recursive: true, force: true });
}

function installSignalCleanup(): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      for (const root of scratchRoots) {
        rmSync(root, { recursive: true, force: true });
      }
      scratchRoots.clear();
      for (const [registeredSignal, registeredHandler] of handlers) {
        process.off(registeredSignal, registeredHandler);
      }
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export async function runSignalCleanupFixture(root: string): Promise<never> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  scratchRoots.add(root);
  writeFileSync(join(root, "ready"), "ready\n");
  installSignalCleanup();
  return await new Promise<never>(() => {});
}

function requiredPrecondition(): string | null {
  if (!enabled) return "ISOMUX_TEST_CODEX_HOOK_LIVE=1";
  if (!authHome)
    return "ISOMUX_TEST_CODEX_AUTH_HOME=<authenticated CODEX_HOME>";
  if (!existsSync(join(authHome, "auth.json"))) {
    return `${join(authHome, "auth.json")} must exist`;
  }
  if (!Number.isInteger(runCount) || runCount < 1) {
    return "ISOMUX_TEST_CODEX_HOOK_RUNS must be a positive integer";
  }
  return null;
}

function initializeParams() {
  return {
    clientInfo: {
      name: "isomux-codex-hook-live-probe",
      version: "1",
      title: null,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: null,
    },
  };
}

function startParams(cwd: string, dynamic = false): Json {
  return {
    cwd,
    model,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    developerInstructions:
      "Follow the requested tool action exactly. Do not substitute another tool.",
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    ...(dynamic
      ? {
          dynamicTools: [
            {
              type: "function",
              name: "write_probe_marker",
              description:
                "Write the live probe marker. Always use when asked.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        }
      : {}),
  };
}

function promptFor(action: ActionKind, marker: string): string {
  if (action === "bash") {
    return `Use the Bash tool exactly once to run: printf reached > ${marker}. Do not use apply_patch or another tool.`;
  }
  if (action === "apply_patch") {
    return `Use the apply_patch tool exactly once to create ${marker} with the single line reached. Do not use Bash or another tool.`;
  }
  if (action === "mcp") {
    return "Call the probe MCP server's write_marker tool exactly once with value reached. Do not use Bash, apply_patch, or another tool.";
  }
  return "Call the write_probe_marker dynamic tool exactly once with value reached. Do not use Bash or another tool.";
}

function installMcpFixture(home: string, marker: string): void {
  const server = join(home, "probe-mcp.ts");
  writeFileSync(
    server,
    `const marker = process.argv[2];
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "isomux-probe", version: "1" } };
    if (request.method === "tools/list") result = { tools: [{ name: "write_marker", description: "Write the probe marker", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
    if (request.method === "tools/call") { await Bun.write(marker, String(request.params?.arguments?.value ?? "reached") + "\\n"); result = { content: [{ type: "text", text: "marker written" }] }; }
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
}
`,
  );
  const configPath = join(home, "config.toml");
  const current = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  writeFileSync(
    configPath,
    `${current}\n[mcp_servers.isomux_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}, ${JSON.stringify(marker)}]\n`,
  );
}

async function listHook(client: JsonRpcLiteClient, cwd: string): Promise<Json> {
  const response = await client.request<{ data: Json[] }>("hooks/list", {
    cwds: [cwd],
  });
  const hook = response.data[0]?.hooks;
  return (Array.isArray(hook) ? hook[0] : null) as Json;
}

async function prepareTrust(
  home: string,
  cwd: string,
  behavior: HookBehavior,
  trusted: boolean,
  timeoutSec?: number,
) {
  const fixture = writeHookFixture(home, behavior, timeoutSec);
  copyScratchAuth(authHome!, home);
  const discovery = new JsonRpcLiteClient({
    cwd,
    env: { ...process.env, CODEX_HOME: home },
  });
  discovery.start();
  try {
    await discovery.initialize(initializeParams());
    const hook = await listHook(discovery, cwd);
    if (trusted) {
      const hash = typeof hook.currentHash === "string" ? hook.currentHash : "";
      if (!hash.startsWith("sha256:")) {
        throw new Error(
          `hooks/list did not return currentHash: ${JSON.stringify(hook)}`,
        );
      }
      trustHook(fixture, hash);
    }
    return { fixture, discovery: hook };
  } finally {
    await discovery.close();
  }
}

function managedClient(cwd: string, home: string, managedEtc: string) {
  const native = join(
    import.meta.dir,
    "../../../node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  return new JsonRpcLiteClient({
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    codexBin: "/usr/bin/bwrap",
    args: [
      "--ro-bind",
      "/",
      "/host",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--bind",
      "/tmp",
      "/tmp",
      "--dir",
      "/etc",
      "--bind",
      managedEtc,
      "/etc/codex",
      "--ro-bind",
      "/etc/ssl",
      "/etc/ssl",
      "--ro-bind",
      "/etc/resolv.conf",
      "/etc/resolv.conf",
      "--",
      `/host${native}`,
      "app-server",
      "--listen",
      "stdio://",
    ],
  });
}

function prepareManaged(
  root: string,
  home: string,
  behavior: "allow" | "deny",
) {
  const user = writeHookFixture(home, "deny");
  const managedHome = join(root, "managed-hook");
  const managed = writeHookFixture(managedHome, behavior);
  copyScratchAuth(authHome!, home);
  const managedEtc = join(root, "managed-etc");
  mkdirSync(managedEtc, { recursive: true });
  writeFileSync(
    join(managedEtc, "requirements.toml"),
    [
      "allow_managed_hooks_only = true",
      "[features]",
      "hooks = true",
      "[hooks]",
      `managed_dir = ${JSON.stringify(managedHome)}`,
      "[[hooks.PreToolUse]]",
      'matcher = ".*"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      `command = ${JSON.stringify(managed.hookPath)}`,
      "timeout = 2",
      "",
    ].join("\n"),
  );
  return { user, managed, managedEtc };
}

async function waitForTurn(
  client: JsonRpcLiteClient,
  threadId: string,
  events: Json[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`turn exceeded outer deadline ${outerDeadlineMs}ms`)),
      outerDeadlineMs,
    );
    const stop = client.onNotification((event) => {
      events.push(event as Json);
      const params = event.params as Json | undefined;
      if (params?.threadId !== threadId) return;
      if (event.method === "turn/completed") {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  });
}

async function runReading(
  action: ActionKind,
  behavior: HookBehavior | "untrusted",
  sessionMode: SessionMode = "start",
  timeoutSec?: number,
  homeLayout: "default-replica" | "per-user-override" = "default-replica",
): Promise<Reading> {
  const root = makeScratchRoot("isomux-codex-hook-live-");
  const home =
    homeLayout === "default-replica"
      ? join(root, ".isomux", "codex-home")
      : join(root, "users", "probe-user", "codex-home");
  const cwd = join(root, "workspace");
  const marker = join(cwd, `marker-${action}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".keep"), "");
  const startedAt = performance.now();
  let client: JsonRpcLiteClient | null = null;
  try {
    const { fixture } = await prepareTrust(
      home,
      cwd,
      behavior === "untrusted" ? "deny" : behavior,
      behavior !== "untrusted",
      timeoutSec,
    );
    if (action === "mcp") installMcpFixture(home, marker);
    client = new JsonRpcLiteClient({
      cwd,
      env: { ...process.env, CODEX_HOME: home },
    });
    const events: Json[] = [];
    client.onServerRequest(async (request) => {
      if (request.method !== "item/tool/call") return PASS;
      writeFileSync(marker, "reached\n");
      return {
        contentItems: [{ type: "inputText", text: "marker written" }],
        success: true,
      };
    });
    client.start();
    await client.initialize(initializeParams());
    let thread = await client.request<{ thread: { id: string } }>(
      "thread/start",
      startParams(cwd, action === "dynamic_tool"),
    );
    if (sessionMode === "resume" || sessionMode === "fork") {
      const setupEvents: Json[] = [];
      const setupDone = waitForTurn(client, thread.thread.id, setupEvents);
      await client.request("turn/start", {
        threadId: thread.thread.id,
        input: [
          {
            type: "text",
            text: "Reply with ready. Do not call any tool.",
            text_elements: [],
          },
        ],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model,
      });
      await setupDone;
    }
    if (sessionMode === "resume") {
      thread = await client.request<{ thread: { id: string } }>(
        "thread/resume",
        {
          threadId: thread.thread.id,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          model,
        },
      );
    } else if (sessionMode === "fork") {
      thread = await client.request<{ thread: { id: string } }>("thread/fork", {
        threadId: thread.thread.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model,
      });
    }
    const threadId = thread.thread.id;
    const done = waitForTurn(client, threadId, events);
    await client.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: promptFor(action, marker), text_elements: [] },
      ],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model,
    });
    await done;
    const payloads = readHookPayloads(fixture.invocationsPath);
    const completed = events
      .filter((event) => event.method === "hook/completed")
      .map((event) => (event.params as Json)?.run as Json)
      .filter(Boolean);
    const items = events
      .filter(
        (event) =>
          event.method === "item/started" || event.method === "item/completed",
      )
      .map((event) => ((event.params as Json)?.item as Json)?.type)
      .filter((type): type is string => typeof type === "string");
    return {
      action,
      behavior,
      sessionMode,
      emitted:
        payloads.length > 0 ||
        items.some((type) =>
          /commandExecution|fileChange|dynamicToolCall|mcpToolCall/.test(type),
        ),
      sideEffect: existsSync(marker),
      blocked: completed.some((run) => run.status === "blocked"),
      hookStatus: completed.map((run) => String(run.status)),
      hookDurationMs: completed
        .map((run) => Number(run.durationMs))
        .filter(Number.isFinite),
      hookRuns: completed,
      payloads,
      itemTypes: [...new Set(items)],
      wallMs: Math.round(performance.now() - startedAt),
      homeLayout,
    };
  } catch (error) {
    return {
      action,
      behavior,
      sessionMode,
      emitted: false,
      sideEffect: existsSync(marker),
      blocked: false,
      hookStatus: [],
      hookDurationMs: [],
      hookRuns: [],
      payloads: [],
      itemTypes: [],
      wallMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      homeLayout,
    };
  } finally {
    await client?.close();
    removeScratchRoot(root);
  }
}

async function runManagedReading(behavior: "allow" | "deny"): Promise<Reading> {
  const root = makeScratchRoot("isomux-codex-managed-live-");
  const home = join(root, "codex-home");
  const cwd = join(root, "workspace");
  const marker = join(cwd, "marker-bash");
  mkdirSync(cwd, { recursive: true });
  const startedAt = performance.now();
  let client: JsonRpcLiteClient | null = null;
  try {
    const fixture = prepareManaged(root, home, behavior);
    client = managedClient(cwd, home, fixture.managedEtc);
    const events: Json[] = [];
    client.start();
    await client.initialize(initializeParams());
    const hookListing = await listHook(client, cwd);
    const thread = await client.request<{ thread: { id: string } }>(
      "thread/start",
      startParams(cwd),
    );
    const done = waitForTurn(client, thread.thread.id, events);
    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: [
        { type: "text", text: promptFor("bash", marker), text_elements: [] },
      ],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model,
    });
    await done;
    const payloads = readHookPayloads(fixture.managed.invocationsPath);
    const completed = events
      .filter((event) => event.method === "hook/completed")
      .map((event) => (event.params as Json)?.run as Json)
      .filter(Boolean);
    return {
      action: "bash",
      behavior,
      sessionMode: "start",
      emitted: payloads.length > 0,
      sideEffect: existsSync(marker),
      blocked: completed.some((run) => run.status === "blocked"),
      hookStatus: completed.map((run) => String(run.status)),
      hookDurationMs: completed
        .map((run) => Number(run.durationMs))
        .filter(Number.isFinite),
      hookRuns: completed,
      payloads,
      itemTypes: [],
      wallMs: Math.round(performance.now() - startedAt),
      hookListing,
      homeLayout: "managed-system",
      userHookPayloads: readHookPayloads(fixture.user.invocationsPath),
    };
  } catch (error) {
    return {
      action: "bash",
      behavior,
      sessionMode: "start",
      emitted: false,
      sideEffect: existsSync(marker),
      blocked: false,
      hookStatus: [],
      hookDurationMs: [],
      hookRuns: [],
      payloads: [],
      itemTypes: [],
      wallMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      homeLayout: "managed-system",
    };
  } finally {
    await client?.close();
    removeScratchRoot(root);
  }
}

async function runOneShotReading(
  behavior: "allow" | "deny" | "untrusted",
): Promise<Reading> {
  const root = makeScratchRoot("isomux-codex-one-shot-live-");
  const home = join(root, ".isomux", "codex-home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const startedAt = performance.now();
  let client: JsonRpcLiteClient | null = null;
  try {
    const { fixture } = await prepareTrust(
      home,
      cwd,
      behavior === "untrusted" ? "deny" : behavior,
      behavior !== "untrusted",
    );
    client = new JsonRpcLiteClient({
      cwd,
      env: { ...process.env, CODEX_HOME: home },
    });
    const events: Json[] = [];
    client.start();
    await client.initialize(initializeParams());
    const thread = await client.request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd,
        model,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    );
    const done = waitForTurn(client, thread.thread.id, events);
    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: [
        {
          type: "text",
          text: "Use Bash exactly once to run: printf ISOMUX_ONE_SHOT_SENTINEL. Do not use another tool.",
          text_elements: [],
        },
      ],
      approvalPolicy: "never",
      model,
    });
    await done;
    const payloads = readHookPayloads(fixture.invocationsPath);
    const completed = events
      .filter((event) => event.method === "hook/completed")
      .map((event) => (event.params as Json)?.run as Json)
      .filter(Boolean);
    const commandItems = events
      .filter((event) => event.method === "item/completed")
      .map((event) => (event.params as Json)?.item as Json)
      .filter((item) => item?.type === "commandExecution");
    const outputObserved = commandItems.some((item) =>
      JSON.stringify(item).includes("ISOMUX_ONE_SHOT_SENTINEL"),
    );
    return {
      action: "bash",
      behavior,
      sessionMode: "one-shot",
      emitted: payloads.length > 0 || commandItems.length > 0,
      sideEffect: outputObserved,
      blocked: completed.some((run) => run.status === "blocked"),
      hookStatus: completed.map((run) => String(run.status)),
      hookDurationMs: completed
        .map((run) => Number(run.durationMs))
        .filter(Number.isFinite),
      hookRuns: completed,
      payloads,
      itemTypes: commandItems.map((item) => String(item.type)),
      wallMs: Math.round(performance.now() - startedAt),
      homeLayout: "default-replica",
    };
  } catch (error) {
    return {
      action: "bash",
      behavior,
      sessionMode: "one-shot",
      emitted: false,
      sideEffect: false,
      blocked: false,
      hookStatus: [],
      hookDurationMs: [],
      hookRuns: [],
      payloads: [],
      itemTypes: [],
      wallMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      homeLayout: "default-replica",
    };
  } finally {
    await client?.close();
    removeScratchRoot(root);
  }
}

async function runBashTurn(
  client: JsonRpcLiteClient,
  threadId: string,
  marker: string,
): Promise<Json[]> {
  const events: Json[] = [];
  const done = waitForTurn(client, threadId, events);
  await client.request("turn/start", {
    threadId,
    input: [
      { type: "text", text: promptFor("bash", marker), text_elements: [] },
    ],
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model,
  });
  await done;
  return events;
}

async function runMidSessionReload(
  mutation: "trust-state" | "hooks-json",
): Promise<Json> {
  const root = makeScratchRoot("isomux-codex-hook-reload-");
  const home = join(root, ".isomux", "codex-home");
  const cwd = join(root, "workspace");
  const firstMarker = join(cwd, "before-mutation");
  const secondMarker = join(cwd, "after-mutation");
  mkdirSync(cwd, { recursive: true });
  let client: JsonRpcLiteClient | null = null;
  try {
    const { fixture } = await prepareTrust(home, cwd, "allow", true);
    client = new JsonRpcLiteClient({
      cwd,
      env: { ...process.env, CODEX_HOME: home },
    });
    client.start();
    await client.initialize(initializeParams());
    const thread = await client.request<{ thread: { id: string } }>(
      "thread/start",
      startParams(cwd),
    );
    await runBashTurn(client, thread.thread.id, firstMarker);
    const beforePayloads = readHookPayloads(fixture.invocationsPath);

    let replacementInvocations: string | null = null;
    if (mutation === "trust-state") {
      writeHookFixture(home, "deny");
      trustHook(fixture, `sha256:${"0".repeat(64)}`);
    } else {
      const replacement = writeHookFixture(join(root, "replacement"), "deny");
      replacementInvocations = replacement.invocationsPath;
      writeFileSync(
        fixture.hooksPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: ".*",
                  hooks: [{ type: "command", command: replacement.hookPath }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
    }

    const secondEvents = await runBashTurn(
      client,
      thread.thread.id,
      secondMarker,
    );
    const afterPayloads = readHookPayloads(fixture.invocationsPath);
    const replacementPayloads = replacementInvocations
      ? readHookPayloads(replacementInvocations)
      : [];
    const listingAfter = await listHook(client, cwd);
    return {
      mutation,
      first: {
        emitted: beforePayloads.length > 0,
        sideEffect: existsSync(firstMarker),
        payloadCount: beforePayloads.length,
      },
      second: {
        emitted:
          afterPayloads.length > beforePayloads.length ||
          replacementPayloads.length > 0 ||
          secondEvents.some((event) => event.method === "item/completed"),
        sideEffect: existsSync(secondMarker),
        originalHookPayloadDelta: afterPayloads.length - beforePayloads.length,
        replacementHookPayloadCount: replacementPayloads.length,
        hookStatuses: secondEvents
          .filter((event) => event.method === "hook/completed")
          .map((event) => ((event.params as Json)?.run as Json)?.status),
      },
      listingAfter,
    };
  } finally {
    await client?.close();
    removeScratchRoot(root);
  }
}

function summarize(readings: Reading[]) {
  return [...new Set(readings.map((reading) => reading.action))].map(
    (action) => {
      const cells = readings.filter((reading) => reading.action === action);
      return {
        action,
        runs: cells.length,
        emitted: cells.filter((cell) => cell.emitted).length,
        blocked: cells.filter((cell) => cell.blocked).length,
        sideEffects: cells.filter((cell) => cell.sideEffect).length,
        wallMs: cells.map((cell) => cell.wallMs),
      };
    },
  );
}

function validate(readings: Reading[]): string[] {
  const errors: string[] = [];
  for (const [index, reading] of readings.entries()) {
    const label = `${index}:${reading.homeLayout ?? "user"}:${reading.action}:${reading.sessionMode}:${reading.behavior}`;
    if (reading.error) errors.push(`${label} errored: ${reading.error}`);
    if (!reading.emitted)
      errors.push(`${label} did not emit the requested action`);
    if (reading.behavior === "allow" && !reading.sideEffect) {
      errors.push(`${label} allow control did not create its side effect`);
    }
    if (reading.behavior === "deny" && reading.sideEffect) {
      errors.push(`${label} deny control created its side effect`);
    }
    if (reading.behavior === "deny" && !reading.blocked) {
      errors.push(`${label} deny control did not report blocked`);
    }
    if (reading.behavior === "untrusted" && !reading.sideEffect) {
      errors.push(`${label} untrusted control did not create its side effect`);
    }
    if (
      ["missing", "exit", "malformed", "hang"].includes(reading.behavior) &&
      !reading.sideEffect
    ) {
      errors.push(
        `${label} did not demonstrate the measured fail-open side effect`,
      );
    }
    if (reading.behavior === "self-timeout" && reading.sideEffect) {
      errors.push(`${label} self-timeout deny created its side effect`);
    }
  }
  return errors;
}

export async function runLiveProbe(): Promise<Json> {
  const missing = requiredPrecondition();
  if (missing) throw new Error(`missing live-probe precondition: ${missing}`);
  const uninstallSignalCleanup = installSignalCleanup();
  try {
    return await runLiveProbeWithCleanup();
  } finally {
    uninstallSignalCleanup();
  }
}

async function runLiveProbeWithCleanup(): Promise<Json> {
  const readings: Reading[] = [];
  if (includeMatrix) {
    for (let run = 0; run < runCount; run++) {
      for (const action of selectedActions) {
        for (const behavior of selectedControls) {
          readings.push(await runReading(action, behavior));
        }
      }
    }
  }
  if (includeSessionModes) {
    for (let run = 0; run < runCount; run++) {
      for (const mode of ["resume", "fork"] as const) {
        for (const behavior of ["allow", "deny", "untrusted"] as const) {
          readings.push(await runReading("bash", behavior, mode));
        }
      }
      for (const behavior of ["allow", "deny", "untrusted"] as const) {
        readings.push(await runOneShotReading(behavior));
      }
    }
  }
  if (includeFailures) {
    for (let run = 0; run < runCount; run++) {
      for (const behavior of ["missing", "exit", "malformed"] as const) {
        readings.push(await runReading("bash", behavior));
      }
      readings.push(await runReading("bash", "hang", "start", 1));
      readings.push(await runReading("bash", "self-timeout"));
      for (const behavior of ["allow", "deny", "untrusted"] as const) {
        readings.push(
          await runReading(
            "bash",
            behavior,
            "start",
            undefined,
            "per-user-override",
          ),
        );
      }
    }
  }
  if (includeManaged) {
    for (let run = 0; run < runCount; run++) {
      readings.push(await runManagedReading("allow"));
      readings.push(await runManagedReading("deny"));
    }
  }
  const midSessionReload: Json[] = [];
  if (includeReload) {
    for (let run = 0; run < runCount; run++) {
      midSessionReload.push(await runMidSessionReload("trust-state"));
      midSessionReload.push(await runMidSessionReload("hooks-json"));
    }
  }
  const validationErrors = validate(readings);
  return {
    measuredAt: new Date().toISOString(),
    codexVersion: "0.144.6",
    settings: { approvalPolicy: "never", sandbox: "danger-full-access", model },
    consecutiveRunCount: runCount,
    authMaterialCopied: { file: "auth.json", from: authHome },
    summary: summarize(readings),
    validationErrors,
    readings,
    midSessionReload,
  };
}

if (import.meta.main) {
  const missing = requiredPrecondition();
  if (missing) {
    console.error(
      `SKIP Codex hook live probe: missing precondition ${missing}`,
    );
    process.exit(2);
  }
  console.log(JSON.stringify(await runLiveProbe(), null, 2));
}
