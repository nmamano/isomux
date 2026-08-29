// Opt-in live measurements for the Codex 0.144.6 hook contract.
// This is probe-only: it installs hooks in a scratch CODEX_HOME and does not
// wire enforcement into an Isomux agent.
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
import { JsonRpcLiteClient, PASS } from "./client.ts";
import { copyScratchAuth } from "./hook-probe-fixture.ts";

type Json = Record<string, unknown>;
type HookEvent = "PreToolUse" | "PermissionRequest";

interface OutputByEvent {
  PreToolUse?: Json | string;
  PermissionRequest?: Json | string;
}

interface ContractCase {
  name: string;
  action: "bash" | "apply_patch";
  events: HookEvent[];
  outputs?: OutputByEvent;
  stderrText?: string;
  exitCode?: number;
  malformed?: boolean;
  missing?: boolean;
  timeoutSec?: number;
  hangMs?: number;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  sandbox?: "danger-full-access" | "read-only";
  bashCommand?: (marker: string) => string;
}

/** Candidate Slice-3 extractor, measured here before production policy uses it. */
export function extractApplyPatchPaths(patch: unknown): string[] | null {
  if (typeof patch !== "string") return null;
  const lines = patch.split("\n");
  if (lines[0] !== "*** Begin Patch") return null;
  if (lines.at(-1) !== "*** End Patch") return null;
  const paths: string[] = [];
  let section: "add" | "delete" | "update" | null = null;
  let movedCurrentUpdate = false;
  for (const line of lines.slice(1, -1)) {
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (header) {
      const path = header[2].trim();
      if (!path || path.includes("\0")) return null;
      section = header[1].toLowerCase() as typeof section;
      movedCurrentUpdate = false;
      paths.push(path);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) {
      const path = move[1].trim();
      if (
        section !== "update" ||
        movedCurrentUpdate ||
        !path ||
        path.includes("\0")
      ) {
        return null;
      }
      movedCurrentUpdate = true;
      paths.push(path);
      continue;
    }
    if (line.startsWith("*** ") && line !== "*** End of File") return null;
  }
  return paths.length > 0 ? paths : null;
}

const authHome = process.env.ISOMUX_TEST_CODEX_AUTH_HOME;
const model = process.env.ISOMUX_TEST_CODEX_MODEL ?? "gpt-5.6-sol";
const deadlineMs = Number(
  process.env.ISOMUX_TEST_CODEX_HOOK_DEADLINE_MS ?? "90000",
);

function initializeParams() {
  return {
    clientInfo: {
      name: "isomux-codex-hook-contract-probe",
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

function eventKey(event: HookEvent): string {
  return /pre.?tool.?use/i.test(event) ? "pre_tool_use" : "permission_request";
}

function writeFixture(root: string, testCase: ContractCase) {
  const home = join(root, "codex-home");
  const hookPath = join(root, "contract-hook.ts");
  const hooksPath = join(home, "hooks.json");
  const invocationsPath = join(root, "invocations.jsonl");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!testCase.missing) {
    writeFileSync(
      hookPath,
      `import { appendFileSync } from "fs";
const payload = await Bun.stdin.text();
appendFileSync(${JSON.stringify(invocationsPath)}, payload.trim() + "\\n");
const event = JSON.parse(payload).hook_event_name;
${testCase.stderrText ? `process.stderr.write(${JSON.stringify(testCase.stderrText + "\n")});` : ""}
${testCase.hangMs ? `await Bun.sleep(${testCase.hangMs});` : ""}
${testCase.exitCode ? `process.exit(${testCase.exitCode});` : ""}
${
  testCase.malformed
    ? 'process.stdout.write("not-json\\n");'
    : `const outputs = ${JSON.stringify(testCase.outputs ?? {})};
const output = outputs[event] ?? {};
process.stdout.write((typeof output === "string" ? output : JSON.stringify(output)) + "\\n");`
}
`,
      { mode: 0o755 },
    );
    chmodSync(hookPath, 0o755);
  }
  const command = testCase.missing
    ? join(root, "missing-hook-executable")
    : `${JSON.stringify(process.execPath)} run ${JSON.stringify(hookPath)}`;
  const hook: Record<string, unknown> = { type: "command", command };
  if (testCase.timeoutSec !== undefined) hook.timeout = testCase.timeoutSec;
  writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        hooks: Object.fromEntries(
          testCase.events.map((event) => [
            event,
            [{ matcher: ".*", hooks: [hook] }],
          ]),
        ),
      },
      null,
      2,
    ),
  );
  return { home, hookPath, hooksPath, invocationsPath };
}

async function listHooks(
  client: JsonRpcLiteClient,
  cwd: string,
): Promise<Json[]> {
  const response = await client.request<{ data: Json[] }>("hooks/list", {
    cwds: [cwd],
  });
  const hooks = response.data[0]?.hooks;
  return Array.isArray(hooks) ? (hooks as Json[]) : [];
}

async function trustFixture(
  fixture: ReturnType<typeof writeFixture>,
  cwd: string,
) {
  copyScratchAuth(authHome!, fixture.home);
  const client = new JsonRpcLiteClient({
    cwd,
    env: { ...process.env, CODEX_HOME: fixture.home },
  });
  client.start();
  try {
    await client.initialize(initializeParams());
    const hooks = await listHooks(client, cwd);
    const lines: string[] = [];
    for (const hook of hooks) {
      const eventName =
        typeof hook.eventName === "string" ? hook.eventName : "";
      if (!eventName || !hook.currentHash) continue;
      const key = `${fixture.hooksPath}:${eventKey(eventName as HookEvent)}:0:0`;
      lines.push(
        `[hooks.state.${JSON.stringify(key)}]`,
        "enabled = true",
        `trusted_hash = ${JSON.stringify(hook.currentHash)}`,
        "",
      );
    }
    writeFileSync(join(fixture.home, "config.toml"), lines.join("\n"));
    return hooks;
  } finally {
    await client.close();
  }
}

async function waitForTurn(
  client: JsonRpcLiteClient,
  threadId: string,
  events: Json[],
) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`turn exceeded ${deadlineMs}ms`)),
      deadlineMs,
    );
    const stop = client.onNotification((event) => {
      events.push(event as unknown as Json);
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

function promptFor(testCase: ContractCase, marker: string): string {
  if (testCase.action === "apply_patch") {
    return `Use apply_patch exactly once to create ${marker} with the single line reached. Do not use Bash or another tool.`;
  }
  const command =
    testCase.bashCommand?.(marker) ?? `printf reached > ${marker}`;
  return `Use Bash exactly once to run: ${command}. Do not use apply_patch or another tool.`;
}

function readJsonLines(path: string): unknown[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function transcriptFacing(events: Json[]): Json[] {
  const methods = new Set([
    "warning",
    "guardianWarning",
    "configWarning",
    "error",
    "item/started",
    "item/completed",
  ]);
  return events.filter((event) => methods.has(String(event.method)));
}

async function runCase(testCase: ContractCase): Promise<Json> {
  const root = mkdtempSync(join(tmpdir(), "isomux-hook-contract-"));
  const cwd = join(root, "workspace");
  const marker = join(cwd, `marker-${testCase.name}`);
  mkdirSync(cwd, { recursive: true });
  let client: JsonRpcLiteClient | null = null;
  try {
    const fixture = writeFixture(root, testCase);
    const discovery = await trustFixture(fixture, cwd);
    client = new JsonRpcLiteClient({
      cwd,
      env: { ...process.env, CODEX_HOME: fixture.home },
    });
    const events: Json[] = [];
    const clientStderr: string[] = [];
    const serverRequests: Json[] = [];
    client.onStderr((chunk) => clientStderr.push(chunk));
    client.onServerRequest(async (request) => {
      serverRequests.push(request as unknown as Json);
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        return { decision: "accept" };
      }
      if (request.method === "execCommandApproval") {
        return { decision: "approved" };
      }
      return PASS;
    });
    client.start();
    await client.initialize(initializeParams());
    const approvalPolicy = testCase.approvalPolicy ?? "never";
    const sandbox = testCase.sandbox ?? "danger-full-access";
    const thread = await client.request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd,
        model,
        approvalPolicy,
        sandbox,
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
          text: promptFor(testCase, marker),
          text_elements: [],
        },
      ],
      approvalPolicy,
      sandbox,
      model,
    });
    await done;
    const hookCompleted = events.filter(
      (event) => event.method === "hook/completed",
    );
    return {
      name: testCase.name,
      action: testCase.action,
      settings: { approvalPolicy, sandbox },
      discovery,
      sideEffect: existsSync(marker),
      hookPayloads: readJsonLines(fixture.invocationsPath),
      hookCompleted,
      clientStderr,
      serverRequests,
      transcriptFacing: transcriptFacing(events),
      eventMethods: events.map((event) => event.method),
    };
  } catch (error) {
    return {
      name: testCase.name,
      action: testCase.action,
      sideEffect: existsSync(marker),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const marker = "ISOMUX_HOOK_FAULT_MARKER";

const cases: ContractCase[] = [
  { name: "allow", action: "bash", events: ["PreToolUse"] },
  {
    name: "stderr-allow",
    action: "bash",
    events: ["PreToolUse"],
    stderrText: marker,
  },
  {
    name: "system-message",
    action: "bash",
    events: ["PreToolUse"],
    outputs: { PreToolUse: { systemMessage: marker } },
  },
  {
    name: "additional-context",
    action: "bash",
    events: ["PreToolUse"],
    outputs: {
      PreToolUse: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: marker,
        },
      },
    },
  },
  {
    name: "missing",
    action: "bash",
    events: ["PreToolUse"],
    missing: true,
  },
  {
    name: "exit-17",
    action: "bash",
    events: ["PreToolUse"],
    stderrText: marker,
    exitCode: 17,
  },
  {
    name: "malformed",
    action: "bash",
    events: ["PreToolUse"],
    stderrText: marker,
    malformed: true,
  },
  {
    name: "timeout",
    action: "bash",
    events: ["PreToolUse"],
    timeoutSec: 1,
    hangMs: 30000,
  },
  {
    name: "apply-patch-envelope",
    action: "apply_patch",
    events: ["PreToolUse"],
  },
  {
    name: "permission-never-control",
    action: "bash",
    events: ["PreToolUse", "PermissionRequest"],
  },
  {
    name: "permission-untrusted-control",
    action: "bash",
    events: ["PreToolUse", "PermissionRequest"],
    approvalPolicy: "untrusted",
    bashCommand: (path) => `touch ${path}`,
  },
  {
    name: "permission-deny",
    action: "bash",
    events: ["PreToolUse", "PermissionRequest"],
    approvalPolicy: "untrusted",
    bashCommand: (path) => `touch ${path}`,
    outputs: {
      PermissionRequest: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: "isomux probe denied" },
        },
      },
    },
  },
];

export async function runHookContractProbe(): Promise<Json> {
  if (!authHome || !existsSync(join(authHome, "auth.json"))) {
    throw new Error(
      "ISOMUX_TEST_CODEX_AUTH_HOME must name an authenticated CODEX_HOME",
    );
  }
  const readings: Json[] = [];
  const selectedNames = new Set(
    (process.env.ISOMUX_TEST_CODEX_HOOK_CONTRACT_CASES ?? "")
      .split(",")
      .filter(Boolean),
  );
  const selectedCases =
    selectedNames.size === 0
      ? cases
      : cases.filter((testCase) => selectedNames.has(testCase.name));
  for (const testCase of selectedCases) readings.push(await runCase(testCase));
  return {
    measuredAt: new Date().toISOString(),
    codexVersion: "0.144.6",
    documentedContractSnapshot: {
      fetchedAt: "2026-08-29",
      fieldsTested: [
        "systemMessage",
        "hookSpecificOutput.additionalContext",
        "hookSpecificOutput.permissionDecision",
        "hookSpecificOutput.decision.behavior",
      ],
    },
    marker,
    readings,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await runHookContractProbe(), null, 2));
}
