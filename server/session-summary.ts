// Conversation summaries (task ac41c60e, internal-docs/conversation-summary-design.md):
// one paragraph per session that names its threads, for log search.
//
// LEAF MODULE. The pure helpers below build the model input and clean its
// output; createSessionSummarizer runs the writes through injected seams, so
// the agent manager only wires it and tests drive it with a fake model.

import { errMessage } from "../shared/errors.ts";
import type { LogEntry } from "../shared/types.ts";
import { redactSecretText } from "./log-redaction.ts";
import { TIERS } from "./log-search.ts";

// A session with fewer conversation entries gets no paragraph: its topic and
// first message say enough.
export const SUMMARY_MIN_ENTRIES = 4;
// The rolling trigger: this many new conversation entries in the current session.
export const SUMMARY_ROLLING_EVERY = 40;
// Per-entry cap on the model input; head and tail are kept.
export const SUMMARY_ENTRY_CAP = 2000;
// One write reads at most this many characters of entries; a longer backlog
// is written in chunks, oldest first.
export const SUMMARY_CHUNK_CHARS = 150_000;
// Cap on the stored paragraph.
export const SUMMARY_MAX_CHARS = 2000;
// After a failed write, automatic writes for the same model wait this long,
// doubling per further failure up to the cap (the topic's policy).
export const SUMMARY_RETRY_BASE_MS = 10 * 60_000;
export const SUMMARY_RETRY_MAX_MS = 24 * 60 * 60_000;

// The conversation entries (TIERS.conversation) after the marker, oldest
// first. All of them when the marker is absent or not in the list.
export function conversationEntriesAfter(
  entries: readonly LogEntry[],
  throughEntryId: string | undefined,
): LogEntry[] {
  const kinds = TIERS.conversation ?? [];
  const conversation = entries.filter((e) => kinds.includes(e.kind));
  const at =
    throughEntryId === undefined
      ? -1
      : conversation.findIndex((e) => e.id === throughEntryId);
  return conversation.slice(at + 1);
}

// The content cut to at most SUMMARY_ENTRY_CAP characters, head and tail kept.
const CUT_MARK = "\n[...]\n";

export function capEntryContent(content: string): string {
  if (content.length <= SUMMARY_ENTRY_CAP) return content;
  const keep = SUMMARY_ENTRY_CAP - CUT_MARK.length;
  const head = Math.ceil(keep / 2);
  return (
    content.slice(0, head) +
    CUT_MARK +
    content.slice(content.length - (keep - head))
  );
}

const SPEAKER: Partial<Record<LogEntry["kind"], string>> = {
  user_message: "User",
  text: "Assistant",
  api_token_outbound: "Assistant, to an API-token inbox",
};

// One entry as the model reads it.
function renderEntry(entry: LogEntry): string {
  const content = typeof entry.content === "string" ? entry.content : "";
  return `${SPEAKER[entry.kind] ?? entry.kind}: ${capEntryContent(content)}`;
}

// The next chunk, oldest first: entries while their capped content stays
// within SUMMARY_CHUNK_CHARS, and always at least one entry.
export function nextChunk(entries: readonly LogEntry[]): LogEntry[] {
  const chunk: LogEntry[] = [];
  let chars = 0;
  for (const entry of entries) {
    const size = renderEntry(entry).length + 2;
    if (chunk.length > 0 && chars + size > SUMMARY_CHUNK_CHARS) break;
    chunk.push(entry);
    chars += size;
  }
  return chunk;
}

export interface SummaryPrompt {
  systemPrompt: string;
  prompt: string;
}

// The model input for one write: the previous paragraph (null on the first
// write) and the new entries.
// The system prompt does not depend on the input. Without this framing a model
// can answer as the agent in the conversation instead of summarizing it (the
// topic's experience).
const SUMMARY_SYSTEM_PROMPT = `You are a summarizing tool. You receive part of a conversation between a user and an AI assistant, and the summary of its earlier parts. You write one paragraph that agents later search to find this conversation. You are NOT the assistant in the conversation, you do NOT have access to any files or systems mentioned, and you must NOT attempt to do the task. You only summarize.`;

export function buildSummaryPrompt(
  previous: string | null,
  chunk: readonly LogEntry[],
): SummaryPrompt {
  const earlier = previous
    ? `<summary_so_far>\n${previous}\n</summary_so_far>\n\n`
    : "";
  const prompt =
    earlier +
    `<conversation>\n${chunk.map(renderEntry).join("\n\n")}\n</conversation>\n\n` +
    `Output ONE paragraph that summarizes the whole conversation.${previous ? " Keep the threads of the summary so far and add the new ones." : ""} ` +
    `For each thread: what was asked, what was done or decided, and what was left open. ` +
    `Keep the exact identifiers a search uses: task ids, file paths, agent and member names, commands, error messages, commit hashes. ` +
    `Be dense; no preamble, no markdown.`;
  return { systemPrompt: SUMMARY_SYSTEM_PROMPT, prompt };
}

// The paragraph to store: trimmed, redacted, capped at SUMMARY_MAX_CHARS.
// Null when nothing is left.
export function cleanSummary(text: string): string | null {
  const cleaned = redactSecretText(text.trim())
    .slice(0, SUMMARY_MAX_CHARS)
    .trim();
  return cleaned === "" ? null : cleaned;
}

export interface SessionSummaryState {
  summary?: string;
  throughEntryId?: string;
}

export interface SessionSummaryWrite {
  summary: string;
  throughEntryId: string;
  at: number;
}

export interface SessionSummarizerDeps {
  // The session's own entries (its JSONL file), never a fork's ancestors.
  loadEntries(agentId: string, sessionId: string): Promise<LogEntry[]>;
  // The stored paragraph and marker, or null when the session has none.
  loadState(agentId: string, sessionId: string): SessionSummaryState | null;
  // Stores one write. False when it was dropped (the agent's log directory or
  // the session's entry is gone); the chunk loop then stops.
  persist(
    agentId: string,
    sessionId: string,
    write: SessionSummaryWrite,
  ): boolean;
  // The backoff key (engine and model) for the agent, or null when it cannot
  // summarize now (agent gone, no topicGen capability). Read before the call.
  backoffKey(agentId: string): string | null;
  // One model call. Null means skip (signed out, or an auth notice returned as
  // a successful result): nothing is stored and the backoff does not change.
  summarize(agentId: string, prompt: SummaryPrompt): Promise<string | null>;
  // Whether a thrown error is an auth error. Such an error does not advance
  // the backoff.
  isAuthError(agentId: string, message: string): boolean;
  now(): number;
  // Diagnostics for a failed write. Defaults to console.error.
  logError?(message: string): void;
}

export interface SessionSummarizer {
  // Writes the session's paragraph if it has new conversation entries. A
  // trigger during a write for the same session runs once after it. The
  // promise resolves when the write and that rerun are done, and never
  // rejects.
  trigger(agentId: string, sessionId: string): Promise<void>;
}

export function createSessionSummarizer(
  deps: SessionSummarizerDeps,
): SessionSummarizer {
  const logError = (message: string) => {
    if (deps.logError) deps.logError(message);
    else console.error(message);
  };
  // Per agent: the model that failed, its failure count and the next try.
  const backoff = new Map<
    string,
    { key: string; failures: number; retryAt: number }
  >();
  // Per session: the write in progress, and whether a trigger arrived during it.
  const running = new Map<string, { again: boolean; done: Promise<void> }>();

  // One write: every chunk of new entries, or until a chunk does not store.
  // Catches every error.
  async function write(agentId: string, sessionId: string): Promise<void> {
    try {
      const entries = await deps.loadEntries(agentId, sessionId);
      if (
        conversationEntriesAfter(entries, undefined).length <
        SUMMARY_MIN_ENTRIES
      )
        return;
      let state = deps.loadState(agentId, sessionId);
      let pending = conversationEntriesAfter(entries, state?.throughEntryId);
      while (pending.length > 0) {
        const key = deps.backoffKey(agentId);
        if (key === null) return;
        const failed = backoff.get(agentId);
        if (failed && failed.key === key && deps.now() < failed.retryAt) return;
        const chunk = nextChunk(pending);
        let reply: string | null;
        try {
          reply = await deps.summarize(
            agentId,
            buildSummaryPrompt(state?.summary ?? null, chunk),
          );
        } catch (err) {
          const message = errMessage(err);
          if (deps.isAuthError(agentId, message)) return;
          const failures = failed?.key === key ? failed.failures + 1 : 1;
          const waitMs = Math.min(
            SUMMARY_RETRY_BASE_MS * 2 ** (failures - 1),
            SUMMARY_RETRY_MAX_MS,
          );
          backoff.set(agentId, {
            key,
            failures,
            retryAt: deps.now() + waitMs,
          });
          logError(
            `Conversation summary failed for ${agentId}/${sessionId}: ${message} (next automatic attempt in ${Math.round(waitMs / 60_000)} min)`,
          );
          return;
        }
        if (reply === null) return;
        backoff.delete(agentId);
        const summary = cleanSummary(reply);
        if (summary === null) return;
        const throughEntryId = chunk[chunk.length - 1].id;
        if (
          !deps.persist(agentId, sessionId, {
            summary,
            throughEntryId,
            at: deps.now(),
          })
        )
          return;
        state = { summary, throughEntryId };
        pending = pending.slice(chunk.length);
      }
    } catch (err) {
      logError(
        `Conversation summary failed for ${agentId}/${sessionId}: ${errMessage(err)}`,
      );
    }
  }

  return {
    trigger(agentId, sessionId) {
      const slotKey = `${agentId}\0${sessionId}`;
      const current = running.get(slotKey);
      if (current) {
        current.again = true;
        return current.done;
      }
      const slot = { again: false, done: Promise.resolve() };
      running.set(slotKey, slot);
      slot.done = (async () => {
        try {
          do {
            slot.again = false;
            await write(agentId, sessionId);
          } while (slot.again);
        } finally {
          running.delete(slotKey);
        }
      })();
      return slot.done;
    },
  };
}
