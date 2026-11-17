// The ids of the trusted checks (server/split/trusted-checks.ts) and the
// format of one failure. They sit here so the owner's page can name a failed
// check in plain words (ui/components/MemberOsUserSection.tsx).

export const CHECK_IDS = [
  "agent-user",
  "agent-not-root",
  "agent-not-server",
  "server-group-private",
  "missing",
  "acl-unreadable",
  "private-owner",
  "private-agent-write",
  "state-root-closed",
  "share-owner",
  "share-group",
  "share-setgid",
  "share-agent-write",
  "share-entry-type",
  "member-privileged-group",
  "office-home-closed",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckFailure {
  check: CheckId;
  path?: string;
  detail: string;
}

export function describeFailure(failure: CheckFailure): string {
  return `${failure.check}${failure.path ? ` at ${failure.path}` : ""}: ${failure.detail}`;
}

// The check a described failure names: the inverse of describeFailure's
// prefix. null when the reason does not start with a known id.
export function failureCheckId(reason: string): CheckId | null {
  return (
    CHECK_IDS.find(
      (id) => reason.startsWith(`${id} at `) || reason.startsWith(`${id}: `),
    ) ?? null
  );
}
