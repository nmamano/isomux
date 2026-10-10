import { expect, it } from "bun:test";
import { auditActor } from "../audit-actor.ts";
import type { Identity } from "../identity/index.ts";
it("keeps each token actor distinct from its owner and preserves run/registration identity", () => {
  const base = { userId: "owner", role: "member", capabilities: [] } as const;
  const cases: [Identity, ReturnType<typeof auditActor>][] = [
    [
      { ...base, scope: "user" },
      { kind: "member", id: "owner", name: "Snapshot" },
    ],
    [
      { ...base, scope: "agent", agentId: "agent" },
      { kind: "agent", id: "agent", name: "Snapshot", ownerId: "owner" },
    ],
    [
      { ...base, scope: "api", apiTokenId: "token", apiTokenName: "Token" },
      { kind: "api_token", id: "token", name: "Token", ownerId: "owner" },
    ],
    [
      { ...base, scope: "cron-run", cronjobId: "job", runId: "run" },
      {
        kind: "cronjob",
        id: "job",
        name: "Snapshot",
        ownerId: "owner",
        runId: "run",
      },
    ],
    [
      { ...base, scope: "app", appName: "app" },
      { kind: "app", id: "app:2", name: "app", ownerId: "owner" },
    ],
  ];
  for (const [identity, expected] of cases)
    expect(auditActor(identity, "Snapshot", "app:2")).toEqual(expected);
});
