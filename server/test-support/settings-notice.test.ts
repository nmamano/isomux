// A settings edit that restarts the agent's process tells the agent, on its
// next turn, what changed and who changed it; the chat shows the same entry
// (server/settings-notice.ts).
//
// Seam: the real harness (auth, the PATCH route, the /model pick) with a
// FakeBackend. A send containing "hold" keeps its turn running.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { english } from "../i18n.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import {
  effortDisplayLabel,
  familyDisplayLabel,
  type AgentInfo,
  type LogEntry,
} from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  clearTestManagedOfficeEnv();
});

const t = english.t;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

function holdingBackend(storedSessionState?: "durable" | "empty"): FakeBackend {
  return new FakeBackend({
    storedSessionState,
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

const agentOf = (srv: TestServer, id: string): AgentInfo =>
  srv.agentManager.getAgent(id)!;

const session = (srv: TestServer, id: string): FakeSession =>
  srv.fakeBackend.sessionForAgent(id)!;

// A Claude resume needs the session's .jsonl under CLAUDE_CONFIG_DIR.
const claudeEnv = (srv: TestServer) => ({
  CLAUDE_CONFIG_DIR: join(srv.stateRoot, "claude-config"),
});

function stubClaudeSession(srv: TestServer, cwd: string, sessionId: string) {
  const env = claudeEnv(srv);
  const projectDir = claudeProjectDir(cwd, env);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "");
}

// A privileged agent of the owner, to edit as an agent caller.
async function editorAgent(srv: TestServer, ownerName: string) {
  const owner = getUserByName(ownerName)!;
  const editor = await srv.agentManager.spawn(
    "Editor",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    owner.name,
    "claude",
    undefined,
    owner.id,
  );
  await srv.agentManager.setPrivileged(editor!.id, true);
  return { bearer: getAgentTokenRaw(editor!.id)! };
}

// A live Claude agent with a resumable conversation. `env`: more office
// variables.
async function liveAgent(
  srv: TestServer,
  cwd = srv.stateRoot,
  opts: { effort?: AgentInfo["effort"]; env?: Record<string, string> } = {},
) {
  setTestManagedOfficeEnv({ ...claudeEnv(srv), ...opts.env });
  const info = await srv.agentManager.spawn(
    "Notice",
    cwd,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    "opus",
    opts.effort ?? "high",
    undefined,
    "claude",
  );
  if (!info) throw new Error("spawn failed");
  await turn(srv, info.id, "first");
  stubClaudeSession(srv, cwd, srv.agentManager.getCurrentSessionId(info.id)!);
  return info.id;
}

async function turn(srv: TestServer, id: string, text: string) {
  await srv.agentManager.sendMessage(id, text, "tester");
  await waitUntil(
    () =>
      session(srv, id).sent.some((m) => m.text.includes(text)) &&
      agentOf(srv, id).state === "waiting_for_response",
    `turn ${text}`,
  );
}

async function patch(
  srv: TestServer,
  id: string,
  body: Record<string, unknown>,
  auth: { rawSessionId?: string; bearer?: string },
) {
  const res = await srv.http(`/api/agents/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify(body),
    rawSessionId: auth.rawSessionId,
  });
  if (res.status !== 200)
    throw new Error(`PATCH ${res.status}: ${await res.text()}`);
}

const NOTICE_BLOCK =
  /--- begin isomux: settings-notice ---\n([\s\S]*?)\n--- end/;

// The settings-notice block of the send that carried `text`, or null.
function noticeSentWith(srv: TestServer, id: string, text: string) {
  const sent = session(srv, id).sent.find((m) => m.text.includes(text));
  if (!sent) throw new Error(`no send with ${text}`);
  return NOTICE_BLOCK.exec(sent.text)?.[1] ?? null;
}

// A live Codex agent with a conversation.
async function liveCodex(srv: TestServer, cwd = srv.stateRoot) {
  const info = await srv.agentManager.spawn(
    "Codex",
    cwd,
    "on-request",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    undefined,
    "codex",
    "workspace-write",
  );
  if (!info) throw new Error("spawn failed");
  await turn(srv, info.id, "first");
  return info.id;
}

const systemEntries = (srv: TestServer, id: string): LogEntry[] =>
  srv.agentManager.getAgentLogs(id).filter((e) => e.kind === "system");

const header = (names: string) =>
  t("systemEntries.settingsNotice.changed", { names });
const line = (setting: string, from: string, to: string) =>
  t("systemEntries.settingsNotice.change", { setting, from, to });

describe("settings notice", () => {
  it("a model edit: the next turn tells the agent and the chat, once", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const models = agentOf(srv, id).claudeFamilyModels;

    await patch(srv, id, { modelFamily: "sonnet" }, owner);
    // Nothing shows before the next turn.
    expect(
      systemEntries(srv, id).some((e) =>
        String(e.content).startsWith(header("Morgan")),
      ),
    ).toBe(false);
    const logsBefore = srv.agentManager.getAgentLogs(id).length;
    await turn(srv, id, "after-model");

    const notice = noticeSentWith(srv, id, "after-model");
    const expected = [
      header("Morgan"),
      line(
        t("common.field.model"),
        familyDisplayLabel("opus", models),
        familyDisplayLabel("sonnet", models),
      ),
    ].join("\n");
    expect(notice).toBe(expected);
    // The member sees the same entry, with the message it went out with.
    const added = srv.agentManager.getAgentLogs(id).slice(logsBefore);
    const shown = added.filter(
      (e) => e.kind === "system" && e.content === expected,
    );
    expect(shown).toHaveLength(1);
    // Marked, so the chat shows the lines as a system message.
    expect(shown[0].metadata?.notice).toBe("settings");

    // One-shot.
    await turn(srv, id, "later");
    expect(noticeSentWith(srv, id, "later")).toBeNull();
    expect(
      srv.agentManager
        .getAgentLogs(id)
        .filter((e) => e.kind === "system" && e.content === expected),
    ).toHaveLength(1);
  });

  it("effort and permission mode in one edit go in one notice, named by an agent caller", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const editor = await editorAgent(srv, owner.username);

    await patch(
      srv,
      id,
      { effort: "low", permissionMode: "bypassPermissions" },
      editor,
    );
    await turn(srv, id, "after-two");

    expect(noticeSentWith(srv, id, "after-two")).toBe(
      [
        header("Editor"),
        line(
          t("common.field.effort"),
          effortDisplayLabel(t, "high"),
          effortDisplayLabel(t, "low"),
        ),
        line(
          t("common.field.permissionMode"),
          t("dialogs.agent.permission.claudeDefault"),
          t("common.permission.claudeBypass"),
        ),
      ].join("\n"),
    );
  });

  it("a Codex sandbox and approval policy edit uses the dialog's words", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const info = await srv.agentManager.spawn(
      "Codex",
      srv.stateRoot,
      "on-request",
      undefined,
      undefined,
      srv.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      undefined,
      "codex",
      "workspace-write",
    );
    const id = info!.id;
    await turn(srv, id, "first");

    await patch(
      srv,
      id,
      { codexSandbox: "read-only", permissionMode: "untrusted" },
      owner,
    );
    await turn(srv, id, "after-sandbox");

    expect(noticeSentWith(srv, id, "after-sandbox")).toBe(
      [
        header("Morgan"),
        line(
          t("common.field.approvalPolicy"),
          t("dialogs.agent.permission.codexOnRequest"),
          t("dialogs.agent.permission.codexUntrusted"),
        ),
        line(
          t("common.field.sandbox"),
          t("common.sandbox.workspaceWrite"),
          t("common.sandbox.readOnly"),
        ),
      ].join("\n"),
    );
  });

  it("a working folder edit shows the path as typed", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const from = join(srv.stateRoot, "folder-a");
    const to = join(srv.stateRoot, "folder-b");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    const id = await liveAgent(srv, from);
    const typed = `${to}/`;

    await patch(srv, id, { cwd: typed }, owner);
    expect(agentOf(srv, id).cwd).toBe(to);
    await turn(srv, id, "after-cwd");

    expect(noticeSentWith(srv, id, "after-cwd")).toBe(
      [
        header("Morgan"),
        line(t("common.field.workingDirectory"), from, typed),
      ].join("\n"),
    );
  });

  it("two edits before a turn merge: the latest value wins, the oldest old value stays", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const editor = await editorAgent(srv, owner.username);
    const models = agentOf(srv, id).claudeFamilyModels;

    await patch(srv, id, { modelFamily: "sonnet", effort: "low" }, owner);
    await patch(srv, id, { modelFamily: "haiku", effort: "high" }, editor);
    await turn(srv, id, "after-merge");

    // Effort is back at its old value, so only the model line is left.
    expect(noticeSentWith(srv, id, "after-merge")).toBe(
      [
        header("Morgan, Editor"),
        line(
          t("common.field.model"),
          familyDisplayLabel("opus", models),
          familyDisplayLabel("haiku", models),
        ),
      ].join("\n"),
    );
  });

  it("an edit that stops a running turn says so, on the queued message the restart sends", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const models = agentOf(srv, id).claudeFamilyModels;

    void srv.agentManager.sendMessage(id, "hold", "tester");
    await waitUntil(
      () => agentOf(srv, id).state === "thinking",
      "turn running",
    );
    void srv.agentManager.sendMessage(id, "queued-one", "tester");
    await sleep(50);
    await patch(srv, id, { modelFamily: "sonnet" }, owner);
    await waitUntil(
      () => session(srv, id).sent.some((m) => m.text.includes("queued-one")),
      "queued message sent",
    );

    expect(noticeSentWith(srv, id, "queued-one")).toBe(
      [
        header("Morgan"),
        line(
          t("common.field.model"),
          familyDisplayLabel("opus", models),
          familyDisplayLabel("sonnet", models),
        ),
        `${t("systemEntries.settingsNotice.interrupted")} ${t("systemEntries.wake.inFlightWarning")}`,
      ].join("\n"),
    );
  });

  it("a turn parked on a permission prompt counts as stopped", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);

    void srv.agentManager.sendMessage(id, "hold", "tester");
    await waitUntil(
      () => agentOf(srv, id).state === "thinking",
      "turn running",
    );
    session(srv, id).push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
    } as never);
    await waitUntil(
      () => agentOf(srv, id).pendingPrompt === "permission",
      "parked",
    );
    await patch(srv, id, { modelFamily: "sonnet" }, owner);
    await turn(srv, id, "after-park");

    expect(noticeSentWith(srv, id, "after-park")).toContain(
      t("systemEntries.settingsNotice.interrupted"),
    );
  });

  it("an effort the new model lacks is named with the model", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    // On Vertex, Sonnet is a limited family: it has no "max" effort.
    const id = await liveAgent(srv, srv.stateRoot, {
      effort: "max",
      env: { CLAUDE_CODE_USE_VERTEX: "1" },
    });
    const models = agentOf(srv, id).claudeFamilyModels;

    await patch(srv, id, { modelFamily: "sonnet" }, owner);
    const downgraded = agentOf(srv, id).effort;
    expect(downgraded).not.toBe("max");
    await turn(srv, id, "after-downgrade");

    expect(noticeSentWith(srv, id, "after-downgrade")).toBe(
      [
        header("Morgan"),
        line(
          t("common.field.model"),
          familyDisplayLabel("opus", models),
          familyDisplayLabel("sonnet", models),
        ),
        line(
          t("common.field.effort"),
          effortDisplayLabel(t, "max"),
          effortDisplayLabel(t, downgraded),
        ),
      ].join("\n"),
    );
  });

  it("a setting set back to its old value before the turn leaves no notice", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);

    await patch(srv, id, { modelFamily: "sonnet" }, owner);
    await patch(srv, id, { modelFamily: "opus" }, owner);
    await turn(srv, id, "after-back");

    expect(noticeSentWith(srv, id, "after-back")).toBeNull();
  });

  it("a working folder edit on a dormant Claude agent arms the notice", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const from = join(srv.stateRoot, "dormant-a");
    const to = join(srv.stateRoot, "dormant-b");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    const id = await liveAgent(srv, from);
    expect(await srv.agentManager.demoteToLazy(id)).toBe(true);
    const sessions = srv.fakeBackend.sessions.length;

    await patch(srv, id, { cwd: to }, owner);
    // No process started for the edit.
    expect(srv.fakeBackend.sessions.length).toBe(sessions);
    await turn(srv, id, "after-dormant");

    expect(noticeSentWith(srv, id, "after-dormant")).toBe(
      [
        header("Morgan"),
        line(t("common.field.workingDirectory"), from, to),
      ].join("\n"),
    );
  });

  it("a Codex working folder edit starts a fresh conversation, with no notice", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const to = join(srv.stateRoot, "codex-b");
    mkdirSync(to, { recursive: true });
    const id = await liveCodex(srv);

    await patch(srv, id, { cwd: to }, owner);
    await turn(srv, id, "after-codex-cwd");

    expect(noticeSentWith(srv, id, "after-codex-cwd")).toBeNull();
  });

  it("an edit whose restart cannot resume the conversation arms no notice", async () => {
    const srv = await startTestServer({
      fakeBackend: holdingBackend("empty"),
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveCodex(srv);

    await patch(srv, id, { codexSandbox: "read-only" }, owner);
    await turn(srv, id, "after-fresh");

    expect(noticeSentWith(srv, id, "after-fresh")).toBeNull();
  });

  it("an edit that does not restart the process arms no notice", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const before = session(srv, id);

    await patch(srv, id, { name: "Renamed" }, owner);
    expect(session(srv, id)).toBe(before);
    await turn(srv, id, "after-rename");

    expect(noticeSentWith(srv, id, "after-rename")).toBeNull();
  });

  it("an edit with no named caller arms no notice", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const before = session(srv, id);

    await srv.agentManager.editAgent(id, { modelFamily: "sonnet" });
    expect(session(srv, id)).not.toBe(before);
    await turn(srv, id, "after-quiet");

    expect(noticeSentWith(srv, id, "after-quiet")).toBeNull();
    expect(
      systemEntries(srv, id).some((e) =>
        String(e.content).includes(t("common.field.model")),
      ),
    ).toBe(false);
  });

  it("a /model pick tells the agent who picked it", async () => {
    const srv = await startTestServer({ fakeBackend: holdingBackend() });
    server = srv;
    await srv.seedOwner("Morgan");
    const id = await liveAgent(srv);
    const models = agentOf(srv, id).claudeFamilyModels;

    await srv.agentManager.sendMessage(id, "/model", "tester");
    const interaction = srv.agentManager
      .getPendingInteractions()
      .find((i) => i.agentId === id)!;
    const index = interaction.choices.findIndex((c) => c.value === "sonnet");
    await srv.agentManager.sendMessage(id, String(index + 1), "tester");
    await waitUntil(
      () => agentOf(srv, id).modelFamily === "sonnet",
      "model picked",
    );
    await turn(srv, id, "after-pick");

    expect(noticeSentWith(srv, id, "after-pick")).toBe(
      [
        header("tester"),
        line(
          t("common.field.model"),
          familyDisplayLabel("opus", models),
          familyDisplayLabel("sonnet", models),
        ),
      ].join("\n"),
    );
  });
});
