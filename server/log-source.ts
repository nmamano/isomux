// Filesystem-backed LogSource for the conversation-log search core
// (server/log-search.ts). Reads the same tree persistence.ts writes:
//
//   <logsDir>/<agentId>/sessions.json      per-session metadata
//   <logsDir>/<agentId>/<sessionId>.jsonl  one log entry per line
//
// The logs directory is a CONSTRUCTOR ARGUMENT rather than a module-level
// STATE_ROOT read, because the search scan runs inside a child process -
// handing it an explicit path removes any dependence on environment
// inheritance across the process boundary, and lets tests point at a temp tree.
//
// Every read is failure-tolerant by design: a missing directory, an unreadable
// sessions.json, or a torn final line is an EMPTY result, never a throw. A
// caller searching their history should get "nothing there" rather than a 500
// because one file was mid-write.

import { join } from "path";
import { readdir } from "fs/promises";
import type { LogEntry } from "../shared/types.ts";
import { isSafeId, type LogSource, type SessionMeta } from "./log-search.ts";

// Split a byte stream into lines without ever holding the whole file. A 35 MB
// session is walked in chunks, so the scan's memory stays flat regardless of
// session size.
async function* streamFileLines(path: string): AsyncGenerator<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of file.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf;
}

export function fileLogSource(logsDir: string): LogSource {
  // Every path is built from ids that passed isSafeId, so no caller-supplied
  // string can traverse out of logsDir. The guard is repeated at each entry
  // point rather than assumed from the route layer - this module is reachable
  // from the search child too.
  const agentDir = (agentId: string): string | null =>
    isSafeId(agentId) ? join(logsDir, agentId) : null;

  return {
    async listSessions(
      agentId: string,
    ): Promise<{ sessionId: string; mtime: number }[]> {
      const dir = agentDir(agentId);
      if (!dir) return [];
      try {
        const names = await readdir(dir);
        const ids = names
          .filter((n) => n.endsWith(".jsonl"))
          .map((n) => n.slice(0, -".jsonl".length))
          .filter(isSafeId);
        return ids.map((sessionId) => ({
          sessionId,
          // Mirrors persistence.listAgentSessions' fallback for a session with
          // no recorded lastModified. Bun.file().lastModified is 0 for a file
          // that vanished between the readdir and here, which is the same
          // "unknown, sort last" value the caller would use anyway.
          mtime: Bun.file(join(dir, `${sessionId}.jsonl`)).lastModified,
        }));
      } catch {
        return [];
      }
    },

    async readSessionsMeta(
      agentId: string,
    ): Promise<Record<string, SessionMeta>> {
      const dir = agentDir(agentId);
      if (!dir) return {};
      try {
        const raw = await Bun.file(join(dir, "sessions.json")).text();
        const parsed = JSON.parse(raw) as Record<string, SessionMeta>;
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    },

    async readEntries(agentId: string, sessionId: string): Promise<LogEntry[]> {
      const dir = agentDir(agentId);
      if (!dir || !isSafeId(sessionId)) return [];
      const out: LogEntry[] = [];
      for await (const line of streamFileLines(
        join(dir, `${sessionId}.jsonl`),
      )) {
        if (line.length === 0) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (typeof entry?.id === "string") out.push(entry);
        } catch {
          // Skip a malformed line rather than failing the whole read.
        }
      }
      return out;
    },

    streamLines(agentId: string, sessionId: string): AsyncIterable<string> {
      const dir = agentDir(agentId);
      if (!dir || !isSafeId(sessionId)) {
        return (async function* () {})();
      }
      return streamFileLines(join(dir, `${sessionId}.jsonl`));
    },
  };
}
