// Regression for task 1a3a0820 - editing a message that carried attachments.
//
// Repro (Nil, 2026-07-24): send a chat message with an image attached, then
// edit it. The edit failed with "Cannot edit: could not locate message in
// backend session", while editing an attachment-free message in the same chat
// worked.
//
// Cause, from the real recorded shapes: attachments are never inlined - each
// becomes one notice line, and the whole notice block is pushed as a SECOND
// text content block after the user's text (buildClaudeUserMessage /
// buildCodexUserInput). Both backends' getSessionMessages flatten content
// blocks by concatenation with NO separator, so the transcript entry reads
// `<user text><notice block>` while the isomux log entry only holds
// `<user text>`. editMessage matched the two by equality, so it never found
// the message.
//
// Seam: the DI manager (createAgentManager + FakeBackend + event sink), same
// idiom as fork-usage.test.ts's B2 block. The fake's sessionMessages are
// stitched from the REAL formatter (resolveAttachmentNotices +
// formatAttachmentLines) against a real on-disk attachment, so the fixture
// can't drift from what the backends actually record. Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { loadLog, loadSessionsMap } from "../persistence.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import {
  formatAttachmentLines,
  resolveAttachmentNotices,
} from "../attachment-prompt.ts";
import { FakeBackend, type FakeBackendConfig } from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import type { Attachment, RoomWire } from "../../shared/types.ts";

const PARENT_SID = "fake-session-1";
const FORK_SID = "forked-1";

const ATTACHMENT: Attachment = {
  filename: "image_7.png",
  originalName: "image.png",
  mediaType: "image/png",
  size: 539643,
};

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];

afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  clearTestManagedOfficeEnv();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function capture() {
  const events: Parameters<EventHandler>[0][] = [];
  const sink: EventHandler = (e) => events.push(e);
  return { events, sink };
}

type AnyEvent = {
  type?: string;
  entry?: { kind?: string; content?: string; attachments?: Attachment[] };
};

function makeManager(fake: FakeBackend, sink: EventHandler) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return mgr;
}

function claudeHome(): string {
  return join(STATE_ROOT, "claude-home");
}

function wireClaudeConfigDir(): void {
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
}

function seedClaudeSession(cwd: string, sessionId: string): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

// The uploaded file has to exist for resolveAttachmentNotices to keep it, and
// it lands where a real upload would (persistence.getFilePath's directory).
function seedAttachmentFile(agentId: string): void {
  const dir = join(STATE_ROOT, "logs", agentId, "files");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ATTACHMENT.filename), Buffer.from([0x89, 0x50]));
}

// What a backend actually records for a turn that carried attachments: the
// user's text block and the notice block, flattened by concatenation.
function flattenedWithNotices(agentId: string, text: string): string {
  const lines = formatAttachmentLines(
    resolveAttachmentNotices(agentId, [ATTACHMENT]),
  );
  return text + lines.join("\n");
}

function editFake(sessionMessagesFor: (agentId: string) => string) {
  // The notice line embeds the agent's own files dir, so the transcript
  // fixture can only be built once the agent exists. FakeBackend keeps the
  // config object by reference, so `install` fills it in after spawn.
  const cfg: FakeBackendConfig = {
    session: {
      onSend: (_t, _a, s) => s.completeTurn({ text: "reply" }),
    },
    forkResult: {
      kind: "fork",
      sessionId: FORK_SID,
      forkedFromSessionId: PARENT_SID,
    },
  };
  const fake = new FakeBackend(cfg);
  const install = (id: string) => {
    cfg.sessionMessages = [
      { uuid: "u-1", role: "user", text: sessionMessagesFor(id) },
      { uuid: "a-1", role: "assistant", text: "reply" },
    ];
  };
  return { fake, install };
}

async function seedAgentWithAttachmentMessage(
  mgr: ReturnType<typeof makeManager>,
  fake: FakeBackend,
  install: (id: string) => void,
) {
  const info = (await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  ))!;
  seedAttachmentFile(info.id);
  install(info.id);
  await mgr.sendMessage(
    info.id,
    "Here is the screenshot of the cutoff slide.",
    undefined,
    undefined,
    [ATTACHMENT],
  );
  expect(fake.sessionForAgent(info.id)!.sessionId).toBe(PARENT_SID);
  await waitUntil(
    () =>
      loadLog(info.id, PARENT_SID).some((e) => e.kind === "user_message") &&
      mgr.getAgent(info.id)?.state === "waiting_for_response",
    3000,
    "attachment turn settled",
  );
  return info;
}

function userMsgId(agentId: string, content: string): string {
  const e = loadLog(agentId, PARENT_SID).find(
    (x) => x.kind === "user_message" && x.content === content,
  );
  if (!e) throw new Error(`no user_message "${content}"`);
  return e.id;
}

describe("editMessage on a message with attachments (task 1a3a0820)", () => {
  it("locates the message despite the appended notice block and forks", async () => {
    wireClaudeConfigDir();
    const { fake, install } = editFake((id) =>
      flattenedWithNotices(id, "Here is the screenshot of the cutoff slide."),
    );
    const { events, sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = await seedAgentWithAttachmentMessage(mgr, fake, install);
    seedClaudeSession(info.cwd, FORK_SID);
    events.length = 0;

    await mgr.editMessage(
      info.id,
      userMsgId(info.id, "Here is the screenshot of the cutoff slide."),
      "Here is the screenshot of the cut-off slide.",
    );
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );

    // The failure mode this test exists for: an error entry instead of a fork.
    const errors = (events as AnyEvent[])
      .filter((e) => e.type === "log_entry" && e.entry?.kind === "error")
      .map((e) => e.entry?.content ?? "");
    expect(errors).toEqual([]);
    expect(loadSessionsMap(info.id)[FORK_SID].forkedFrom).toBe(PARENT_SID);
  });

  it("carries the original attachments onto the edited turn", async () => {
    wireClaudeConfigDir();
    const { fake, install } = editFake((id) =>
      flattenedWithNotices(id, "look at this"),
    );
    const { events, sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    ))!;
    seedAttachmentFile(info.id);
    install(info.id);
    await mgr.sendMessage(info.id, "look at this", undefined, undefined, [
      ATTACHMENT,
    ]);
    await waitUntil(
      () =>
        loadLog(info.id, PARENT_SID).some((e) => e.kind === "user_message") &&
        mgr.getAgent(info.id)?.state === "waiting_for_response",
      3000,
      "attachment turn settled",
    );
    seedClaudeSession(info.cwd, FORK_SID);
    events.length = 0;

    await mgr.editMessage(
      info.id,
      userMsgId(info.id, "look at this"),
      "look at this image",
    );
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );

    // The edit UI rewrites text only - the attachments belong to the message,
    // so they ride along instead of being silently dropped.
    const edited = (events as AnyEvent[]).find(
      (e) =>
        e.type === "log_entry" &&
        e.entry?.kind === "user_message" &&
        e.entry?.content === "look at this image",
    );
    expect(edited?.entry?.attachments).toEqual([ATTACHMENT]);

    // And they reach the backend: the post-fork session's send carries the specs.
    expect(fake.sessions.at(-1)!.sent.at(-1)?.attachments).toEqual([
      ATTACHMENT,
    ]);
  });

  it("still fails loudly when the message really isn't in the session", async () => {
    wireClaudeConfigDir();
    const { fake, install } = editFake(() => "something else entirely");
    const { events, sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = await seedAgentWithAttachmentMessage(mgr, fake, install);
    seedClaudeSession(info.cwd, FORK_SID);
    events.length = 0;

    await mgr.editMessage(
      info.id,
      userMsgId(info.id, "Here is the screenshot of the cutoff slide."),
      "nope",
    );
    await waitUntil(
      () =>
        (events as AnyEvent[]).some(
          (e) => e.type === "log_entry" && e.entry?.kind === "error",
        ),
      2000,
      "error surfaced",
    );

    const errors = (events as AnyEvent[])
      .filter((e) => e.type === "log_entry" && e.entry?.kind === "error")
      .map((e) => e.entry?.content ?? "");
    expect(errors[0]).toContain("could not locate message in backend session");
    expect(loadSessionsMap(info.id)[FORK_SID]).toBeUndefined();
  });
});
