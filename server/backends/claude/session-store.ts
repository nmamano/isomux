import {
  translatorFor,
  type Translator,
} from "../../../shared/i18n/translate.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeProjectDir } from "../../cwd-utils.ts";

// The SDK's dir option is a cwd, not a storage directory. Its local helpers
// otherwise use the office process root. A per-call store confines native
// reads and forks to this session's recorded root without changing process.env.
export function claudeSessionStore(
  sessionId: string,
  cwd: string,
  env?: Record<string, string | undefined>,
  t: Translator["t"] = translatorFor("en").t,
): SessionStore {
  const projectDir = claudeProjectDir(cwd, env ?? process.env);
  return {
    async load(key) {
      if (key.sessionId !== sessionId || key.subpath)
        throw new Error(t("systemEntries.claudeSession.invalid"));
      try {
        const text = await readFile(
          join(projectDir, `${sessionId}.jsonl`),
          "utf8",
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
      await writeFile(
        join(projectDir, `${key.sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
    },
  };
}
