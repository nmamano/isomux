// The stored state of one OpenCode session, read from the agent user's
// opencode.db (server/backends/opencode/storage.ts). No database bytes leave.
import { inspectOpenCodeDatabase } from "../../backends/opencode/storage.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as { databasePath?: unknown; sessionId?: unknown } | null;
  if (
    typeof req?.databasePath !== "string" ||
    typeof req.sessionId !== "string"
  )
    throw new Error("opencode-inspect needs databasePath and sessionId");
  return inspectOpenCodeDatabase(req.databasePath, req.sessionId);
});
