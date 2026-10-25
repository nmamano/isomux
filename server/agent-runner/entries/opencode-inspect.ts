// The stored state of one OpenCode session, read from the agent user's
// OpenCode database (server/backends/opencode/storage.ts). No database bytes
// leave.
import { inspectOpenCodeDatabase } from "../../backends/opencode/storage.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as {
    databasePath?: unknown;
    sessionId?: unknown;
    schema?: unknown;
  } | null;
  if (
    typeof req?.databasePath !== "string" ||
    typeof req.sessionId !== "string"
  )
    throw new Error("opencode-inspect needs databasePath and sessionId");
  return inspectOpenCodeDatabase(
    req.databasePath,
    req.sessionId,
    req.schema === "v1" ? "v1" : "v2",
  );
});
