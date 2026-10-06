import {
  translatorFor,
  type Translator,
} from "../../../shared/i18n/translate.ts";
import { join } from "node:path";
import type {
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeProjectDir } from "../../cwd-utils.ts";
import { getAgentHost } from "../../agent-host.ts";

// The SDK's dir option is a cwd, not a storage directory. Its local helpers
// otherwise use the office process root. A per-call store confines native
// reads and forks to this session's recorded root without changing process.env.
// The transcripts are in agent space: in split mode the agent host reads and
// writes them as the agent user, so a fork belongs to that user.
export function claudeSessionStore(
  sessionId: string,
  cwd: string,
  env?: Record<string, string | undefined>,
  t: Translator["t"] = translatorFor("en").t,
): SessionStore {
  const host = getAgentHost();
  const projectDir = claudeProjectDir(cwd, env ?? host.baseEnv());
  return {
    async load(key) {
      if (key.sessionId !== sessionId || key.subpath)
        throw new Error(t("systemEntries.claudeSession.invalid"));
      try {
        const text = await host.fs.readText(
          join(projectDir, `${sessionId}.jsonl`),
        );
        return text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as SessionStoreEntry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async append(key, entries) {
      // forkSession supplies a new UUID and one complete batch. Never overwrite
      // an existing transcript or accept a path supplied as a session id.
      if (
        key.sessionId === sessionId ||
        key.subpath ||
        !/^[0-9a-f-]{36}$/i.test(key.sessionId)
      ) {
        throw new Error(t("systemEntries.claudeSession.invalid"));
      }
      await host.fs.writeText(
        join(projectDir, `${key.sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { exclusive: true, mode: 0o600 },
      );
    },
  };
}
