// The text a person reads when an agent's session cannot start, or when it
// needs sign-in, is stored in English and carries a message each reader
// words in their own language (tasks beb6089b, c37a7365):
//   - a bad cwd, per cause, with a Spanish owner;
//   - a resume failure shows exactly one "/resume" hint, from the entry
//     around it, whichever path wrote it;
//   - the sign-in walkthrough on the auth path and on /login, also when the
//     backend cannot give one.
// The FakeBackend returns its walkthrough as a message, as every real
// backend does (server/backends/auth-detect.test.ts); what these tests check
// is what the orchestrator writes.
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import {
  localizeLogParts,
  msg,
  type LogText,
} from "../../shared/i18n/log-message.ts";
import type { LogEntry } from "../../shared/types.ts";
import { expectWorded } from "./worded.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createMember, deleteUserById, updateUserById } from "../users.ts";
import { FakeBackend } from "./fake-backend.ts";

type Manager = ReturnType<typeof createAgentManager>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

const ROOM = "room-start-i18n";
function rooms(): RoomWire[] {
  return [{ id: ROOM, name: ROOM, prompt: null, canCloseWhenEmpty: false }];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-start-i18n-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let memberCount = 0;
/** A member on `language`. */
// An owner, so the office sign-in is not withheld from them.
function member(language: SupportedLanguageCode): { id: string; name: string } {
  const made = createMember(`Start I18n ${process.pid} ${++memberCount}`, {
    role: "owner",
  });
  if (!made.ok) throw new Error(made.error);
  cleanups.push(() => deleteUserById(made.user.id));
  const r = updateUserById(made.user.id, { language });
  if (!r.ok) throw new Error(r.error);
  return { id: made.user.id, name: made.user.name };
}

function manager(fake: FakeBackend): Manager {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms() }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

async function spawnAgent(
  mgr: Manager,
  name: string,
  cwd: string,
  owner?: { id: string; name: string },
): Promise<string> {
  const info = await mgr.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    ROOM,
    undefined,
    undefined,
    undefined,
    owner?.name,
    "codex",
    undefined,
    owner?.id ?? null,
  );
  if (!info) throw new Error("spawn returned null");
  return info.id;
}

const errors = (mgr: Manager, id: string) =>
  mgr
    .getAgentLogs(id)
    .filter((entry) => entry.kind === "error")
    .map((entry) => entry.content);

const systemEntries = (mgr: Manager, id: string): LogEntry[] =>
  mgr.getAgentLogs(id).filter((entry) => entry.kind === "system");

const resumeHints = (text: string) => text.split("/resume").length - 1;

// The part of `entry` that `key` wraps as {error}, or null when the entry is
// not that key's text in `language`.
function wrapped(
  language: SupportedLanguageCode,
  key: "systemEntries.sessionStartFailed",
  entry: string,
): string | null {
  const [prefix, suffix] = translatorFor(language)
    .t(key, { error: "\u0000" })
    .split("\u0000");
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return null;
  return entry.slice(prefix.length, entry.length - suffix.length);
}

describe("a bad cwd at session start", () => {
  type Cause = "missing" | "not_directory" | "inaccessible";
  // Spawn checks the cwd, so each cause is made after the spawn.
  function breakCwd(cause: Cause, cwd: string): void {
    if (cause === "missing") rmSync(cwd, { recursive: true });
    if (cause === "not_directory") {
      rmSync(cwd, { recursive: true });
      writeFileSync(cwd, "not a directory");
    }
    if (cause === "inaccessible") {
      const parent = join(cwd, "..");
      chmodSync(parent, 0o000);
      cleanups.push(() => chmodSync(parent, 0o755));
    }
  }
  // The cwd lives one level down, so "inaccessible" can lock its parent.
  function agentCwd(): string {
    const cwd = join(tempDir(), "work");
    mkdirSync(cwd);
    return cwd;
  }

  async function startFailure(
    cause: Cause,
    owner?: { id: string; name: string },
  ): Promise<{ entry: LogEntry; cwd: string }> {
    const fake = new FakeBackend();
    const mgr = manager(fake);
    const cwd = agentCwd();
    const id = await spawnAgent(mgr, `Cwd ${cause}`, cwd, owner);
    breakCwd(cause, cwd);
    void mgr.sendMessage(id, "hi", owner?.name).catch(() => {});
    await waitUntil(() => errors(mgr, id).length > 0, "start failure");
    expect(fake.createSessionCount + fake.resumeSessionCount).toBe(0);
    const entry = mgr.getAgentLogs(id).find((e) => e.kind === "error")!;
    return { entry, cwd };
  }

  for (const cause of ["missing", "not_directory", "inaccessible"] as const) {
    it(`stores the ${cause} cause in English, worded for each reader`, async () => {
      // The ENABLING CONDITION: the owner reads Spanish, the case the old
      // writer worded in Spanish.
      const { entry, cwd } = await startFailure(cause, member("es"));
      const englishCause = wrapped(
        "en",
        "systemEntries.sessionStartFailed",
        entry.content,
      );
      const spanishText = localizeLogParts(translatorFor("es"), entry.message);
      expect(spanishText).not.toBeNull();
      const spanishCause = wrapped(
        "es",
        "systemEntries.sessionStartFailed",
        spanishText!,
      );
      expect(englishCause).not.toBeNull();
      expect(spanishCause).not.toBeNull();
      // Each names the path; the cause inside the wrapper is worded too.
      expect(englishCause).toContain(cwd);
      expect(spanishCause).toContain(cwd);
      expect(spanishCause).not.toBe(englishCause);
    });
  }
});

describe("a resume failure", () => {
  const PROBLEM = "The stored fake session is missing.";

  // An agent with a durable session and no live process: its next message
  // resumes, so the resume check runs.
  async function dormantWithSession(): Promise<{
    fake: FakeBackend;
    mgr: Manager;
    id: string;
    sessionId: string;
  }> {
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const mgr = manager(fake);
    const id = await spawnAgent(mgr, "Resume hint", tempDir());
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "wake",
    });
    await waitUntil(
      () =>
        mgr.getCurrentSessionId(id) !== null &&
        mgr.getAgent(id)?.state === "waiting_for_response",
      "first turn done",
    );
    expect(await mgr.demoteToLazy(id)).toBe(true);
    const sessionId = mgr.getCurrentSessionId(id)!;
    fake.setSessionResumableError(sessionId, PROBLEM);
    return { fake, mgr, id, sessionId };
  }

  async function failureEntry(mgr: Manager, id: string): Promise<string> {
    await waitUntil(
      () => errors(mgr, id).some((text) => text.includes(PROBLEM)),
      "resume failure",
    );
    return errors(mgr, id).find((text) => text.includes(PROBLEM))!;
  }

  it("on a queued message's wake: one /resume hint", async () => {
    const { mgr, id } = await dormantWithSession();
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "again",
    });
    expect(resumeHints(await failureEntry(mgr, id))).toBe(1);
  });

  it("on a direct send's wake: one /resume hint", async () => {
    const { mgr, id } = await dormantWithSession();
    void mgr.sendMessage(id, "again", "tester").catch(() => {});
    expect(resumeHints(await failureEntry(mgr, id))).toBe(1);
  });

  it("on an explicit resume: one /resume hint", async () => {
    const { mgr, id, sessionId } = await dormantWithSession();
    await mgr.resume(id, sessionId);
    expect(resumeHints(await failureEntry(mgr, id))).toBe(1);
  });
});

describe("the sign-in walkthrough", () => {
  // Any key with a translation: the fake returns it as its walkthrough.
  const KEY = "systemEntries.resumeCancelled" as const;
  const GENERIC = "systemEntries.loginInstructions.generic" as const;

  function fakeWith(getText: () => LogText): FakeBackend {
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, session) => {
          session.push({ kind: "auth_needed" });
          session.push({ kind: "turn_completed", status: "failed" });
        },
      },
    });
    fake.getLoginInstructions = async () => ({
      kind: "login",
      cardEligible: false,
      text: getText(),
    });
    return fake;
  }

  async function authFailure(fake: FakeBackend): Promise<LogEntry[]> {
    const mgr = manager(fake);
    const owner = member("es");
    const id = await spawnAgent(mgr, "Sign-in", tempDir(), owner);
    const before = systemEntries(mgr, id).length;
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: owner.name },
      text: "hi",
    });
    await waitUntil(
      () => systemEntries(mgr, id).length > before,
      "walkthrough written",
    );
    // Nothing else follows it: give a second entry time to land.
    await sleep(50);
    return systemEntries(mgr, id).slice(before);
  }

  it("is stored in English and worded for each reader on the auth path", async () => {
    const entries = await authFailure(fakeWith(() => msg(KEY)));
    expect(entries).toHaveLength(1);
    expectWorded(entries[0], KEY);
  });

  it("falls back to the generic walkthrough, worded for each reader", async () => {
    const fake = fakeWith(() => {
      throw new Error("sign-in state unknown");
    });
    const entries = await authFailure(fake);
    expect(entries).toHaveLength(1);
    expectWorded(entries[0], GENERIC);
  });

  it("is stored in English and worded for each reader on /login", async () => {
    const fake = fakeWith(() => msg(KEY));
    const mgr = manager(fake);
    const owner = member("es");
    const typist = member("ca");
    const id = await spawnAgent(mgr, "Login typist", tempDir(), owner);
    const before = systemEntries(mgr, id).length;
    void mgr.sendMessage(id, "/login", typist.name).catch(() => {});
    await waitUntil(
      () => systemEntries(mgr, id).length > before,
      "walkthrough written",
    );
    const entries = systemEntries(mgr, id).slice(before);
    expect(entries).toHaveLength(1);
    expectWorded(entries[0], KEY);
  });
});
