// Shared responses for the settings report layout and cleanup navigation tests.
export const settingsReportsApi = async (
  method: string,
  path: string,
  body?: unknown,
) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  // Leave usage unloaded: this test exercises the page layout, including its
  // loading state, without coupling it to usage totals. Storage answers with
  // an empty measurement so its cleanup guard can run below.
  if (path === "/api/usage") return null;
  if (path === "/api/storage/usage")
    return {
      stateRoot: "/state",
      measuredAt: Date.now(),
      stateRootBytes: 0,
      categories: [],
      agents: [],
    };
  if (path === "/api/backup/status")
    return {
      lastRunAt: null,
      ok: false,
      error: null,
      retention: 0,
      destDir: "/backups",
    };
  if (method === "POST" && path === "/api/storage/prune") {
    const plan = {
      target: "transcripts",
      policy: { olderThanDays: 90, keepPerAgent: 5 },
      candidates: [
        {
          path: "agent-1/session.jsonl",
          bytes: 100,
          agentId: "agent-1",
          sessionId: "session",
          ageDays: 100,
          mtimeMs: 0,
        },
      ],
      bytes: 100,
      skipped: [],
    };
    if ((body as { apply?: boolean } | undefined)?.apply)
      return new Promise(() => {});
    return { plan, applied: null };
  }
  return {};
};
