// The account usage card (Integrations > Model providers, task 3e70b6d4):
// every provider account the office's agents can run on, with its usage read
// straight from the provider by the account usage reader
// (server/office-usage.ts). Owners see every account, a member the office's
// and their own (task faf036ad). The usage key never leaves the server: rows
// carry opaque ids.

import type {
  AccountUsageListRes,
  AccountUsageRowWire,
} from "../shared/contract-shapes.ts";
import type {
  ProviderAccountProvider,
  SubscriptionWindowWire,
} from "../shared/types.ts";
import { randomUUID } from "node:crypto";
import { cloudFlag } from "./backends/claude-install-check.ts";
import {
  foldAccountUsageRow,
  sameAccountUsage,
} from "../shared/account-usage.ts";
import type { AccountUsageAnswer, AccountUsageReader } from "./office-usage.ts";

type Env = Record<string, string | undefined>;

export type AccountUsageOwner =
  { kind: "office" } | { kind: "member"; userId: string };

// One account to list: its usage key, the env a session on it gets, whose it
// is, and whether it is the office sign-in (a warm reader slot).
export type AccountUsageSource = {
  provider: ProviderAccountProvider;
  key: string;
  env: Env;
  owners: AccountUsageOwner[];
  office: boolean;
};

// Whether the env alone says the account has no plan limit (an API key, a
// cloud, another endpoint): no reader process starts for it. A Claude
// OAuth token has plan limits.
export function noLimitFromEnv(
  provider: ProviderAccountProvider,
  env: Env,
): boolean {
  return NO_LIMIT_VARIABLES[provider].some((name) =>
    CLOUD_FLAGS.has(name) ? cloudFlag(env[name]) : !!env[name]?.trim(),
  );
}

// The cloud switches, on by the CLI's rule (cloudFlag), not for any value.
const CLOUD_FLAGS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

// The variables of usage-account.ts AUTH_VARIABLES that bill outside a plan:
// every one but the Claude OAuth token, which is a plan's.
const NO_LIMIT_VARIABLES: Record<ProviderAccountProvider, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
  ],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
};

export interface AccountUsageSourceDeps {
  // The office sign-in's env for a provider, its directory set.
  officeEnv(provider: ProviderAccountProvider): Env;
  memberIds(): string[];
  // The member's personal sign-in env, or null when they have none.
  personalEnv(userId: string, provider: ProviderAccountProvider): Env | null;
  // The env a session of the member's agent gets (buildEnvForUserId), on
  // `dir` when given. Null when it cannot load.
  agentEnv(
    userId: string | null,
    provider: ProviderAccountProvider,
    dir: string | null,
  ): Env | null;
  // The live agents: their usage key and the directory it names.
  liveAgents(): Array<{
    provider: ProviderAccountProvider;
    userId: string | null;
    dir: string | null;
    key: string | null;
  }>;
  keyOf(provider: ProviderAccountProvider, env: Env): string | null;
}

// The union of the office sign-in, each member's personal sign-in and env,
// and the accounts the live agents run on, one source per usage key.
export function collectAccountUsageSources(
  deps: AccountUsageSourceDeps,
): AccountUsageSource[] {
  const byKey = new Map<string, AccountUsageSource>();
  const officeKeys = new Set<string>();
  type Account = { env: Env; key: string } | null;
  // One env build and key per member, provider and directory: many agents
  // share them.
  const built = new Map<string, Account>();
  const agentAccount = (
    userId: string | null,
    provider: ProviderAccountProvider,
    dir: string | null,
  ): Account => {
    const name = JSON.stringify([userId, provider, dir]);
    if (built.has(name)) return built.get(name)!;
    const env = safely(() => deps.agentEnv(userId, provider, dir));
    const key = env ? deps.keyOf(provider, env) : null;
    const account = env && key !== null ? { env, key } : null;
    built.set(name, account);
    return account;
  };
  const accountOf = (
    provider: ProviderAccountProvider,
    env: Env | null,
  ): Account => {
    if (!env) return null;
    const key = deps.keyOf(provider, env);
    return key === null ? null : { env, key };
  };
  const add = (
    provider: ProviderAccountProvider,
    account: Account,
    owner: AccountUsageOwner,
    expectedKey?: string,
  ) => {
    if (!account) return;
    const { env, key } = account;
    // An env that no longer gives the agent's key is not the account it
    // runs on: its next turn moves it.
    if (expectedKey !== undefined && key !== expectedKey) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { provider, key, env, owners: [owner], office: false });
      return;
    }
    // A member on an office account folds into the office's row.
    if (officeKeys.has(key)) return;
    if (!existing.owners.some((o) => sameOwner(o, owner)))
      existing.owners.push(owner);
  };
  for (const provider of PROVIDERS) {
    const office = accountOf(
      provider,
      safely(() => deps.officeEnv(provider)),
    );
    if (office) {
      officeKeys.add(office.key);
      byKey.set(office.key, {
        provider,
        key: office.key,
        env: office.env,
        owners: [{ kind: "office" }],
        office: true,
      });
    }
    // The office's agents run on another account than the sign-in when an
    // office variable or secret holds a credential: the office's too.
    const agents = agentAccount(null, provider, null);
    if (agents && !byKey.has(agents.key)) {
      officeKeys.add(agents.key);
      add(provider, agents, { kind: "office" });
    }
  }
  for (const userId of deps.memberIds())
    for (const provider of PROVIDERS) {
      const owner: AccountUsageOwner = { kind: "member", userId };
      add(
        provider,
        accountOf(
          provider,
          safely(() => deps.personalEnv(userId, provider)),
        ),
        owner,
      );
      add(provider, agentAccount(userId, provider, null), owner);
    }
  for (const agent of deps.liveAgents()) {
    if (agent.key === null) continue;
    const owner: AccountUsageOwner = agent.userId
      ? { kind: "member", userId: agent.userId }
      : { kind: "office" };
    add(
      agent.provider,
      agentAccount(agent.userId, agent.provider, agent.dir),
      owner,
      agent.key,
    );
  }
  return [...byKey.values()];
}

const PROVIDERS: readonly ProviderAccountProvider[] = ["claude", "codex"];

// An env that cannot load lists nothing.
function safely(read: () => Env | null): Env | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function sameOwner(a: AccountUsageOwner, b: AccountUsageOwner): boolean {
  return a.kind === "office"
    ? b.kind === "office"
    : b.kind === "member" && a.userId === b.userId;
}

export interface AccountUsageServiceDeps {
  reader: Pick<AccountUsageReader, "peek" | "readAccount" | "retain">;
  sources(): AccountUsageSource[];
  // Each live agent's usage key and manager, for "members on it now".
  liveAgents(): Array<{ key: string | null; userId: string | null }>;
  username(userId: string): string | null;
  newId?: () => string;
  now?: () => number;
}

// Who reads the card (task faf036ad): an owner sees every account; a member
// sees the office's accounts and their own, with no other member's name and
// no email of an account that is not theirs.
export type AccountUsageViewer = { userId: string; owner: boolean };

export interface AccountUsageService {
  // The rows the viewer sees, at once, with what each slot holds; starts the
  // reads they need.
  list(opts: {
    refresh: boolean;
    viewer: AccountUsageViewer;
  }): AccountUsageListRes;
  // The row once its read ends. Null for an id the last list did not give,
  // or a row the viewer does not see.
  row(
    rowId: string,
    viewer: AccountUsageViewer,
  ): Promise<AccountUsageRowWire | null>;
}

export function createAccountUsageService(
  deps: AccountUsageServiceDeps,
): AccountUsageService {
  const newId = deps.newId ?? randomUUID;
  // Opaque ids, server-side: key <-> row id, and provider + email <->
  // identity token.
  const idOfKey = new Map<string, string>();
  const keyOfId = new Map<string, string>();
  const tokens = new Map<string, string>();
  // The sources of the last list, by key.
  let listed = new Map<string, AccountUsageSource>();

  function idFor(key: string): string {
    let id = idOfKey.get(key);
    if (id === undefined) {
      id = newId();
      idOfKey.set(key, id);
      keyOfId.set(id, key);
    }
    return id;
  }

  function tokenFor(
    provider: ProviderAccountProvider,
    email: string | null,
  ): string | null {
    if (email === null) return null;
    const name = `${provider}\0${email}`;
    let token = tokens.get(name);
    if (token === undefined) {
      token = newId();
      tokens.set(name, token);
    }
    return token;
  }

  // The usernames of the members whose agents run on each key now.
  function membersByKey(): Map<string, string[]> {
    const members = new Map<string, string[]>();
    for (const agent of deps.liveAgents()) {
      if (agent.key === null || agent.userId === null) continue;
      const name = deps.username(agent.userId);
      if (name === null) continue;
      const list = members.get(agent.key) ?? [];
      if (!list.includes(name)) list.push(name);
      members.set(agent.key, list);
    }
    return members;
  }

  function owners(source: AccountUsageSource): AccountUsageRowWire["owners"] {
    const out: AccountUsageRowWire["owners"] = [];
    for (const owner of source.owners) {
      if (owner.kind === "office") out.push({ kind: "office" });
      else {
        const username = deps.username(owner.userId);
        if (username !== null) out.push({ kind: "member", username });
      }
    }
    return out;
  }

  function rowOf(
    source: AccountUsageSource,
    answer: AccountUsageAnswer | null,
    members: string[],
  ): AccountUsageRowWire {
    const base = {
      id: idFor(source.key),
      provider: source.provider,
      owners: owners(source),
      members,
    };
    if (noLimitFromEnv(source.provider, source.env))
      return {
        ...base,
        accountLabel: null,
        identity: null,
        state: "no_limit",
        plan: null,
        windows: [],
        weeklyIndex: null,
        observedAtMs: null,
      };
    if (!answer)
      return {
        ...base,
        accountLabel: null,
        identity: null,
        state: "loading",
        plan: null,
        windows: [],
        weeklyIndex: null,
        observedAtMs: null,
      };
    const reading = answer.reading;
    const windows: SubscriptionWindowWire[] =
      reading.kind === "usage"
        ? reading.windows.map((w) => ({
            label: w.label,
            shortLabel: w.shortLabel,
            usedPercent: w.usedPercent,
            resetsAtMs: w.resetsAtMs,
            ...(w.modelFamily === undefined
              ? {}
              : { modelFamily: w.modelFamily }),
          }))
        : [];
    const weekly = windows.findIndex(
      (w) => w.shortLabel === WEEKLY_SHORT_LABEL && w.modelFamily === undefined,
    );
    return {
      ...base,
      accountLabel: answer.identity,
      identity: tokenFor(source.provider, answer.identity),
      state: reading.kind,
      plan: reading.kind === "usage" ? reading.plan : null,
      windows,
      weeklyIndex: weekly < 0 ? null : weekly,
      observedAtMs: answer.observedAtMs,
    };
  }

  function targetOf(source: AccountUsageSource) {
    return {
      key: source.key,
      provider: source.provider,
      env: source.env,
      warm: source.office,
    };
  }

  // Rows of one provider account merge: the first keeps its place and id,
  // and lists every owner and member.
  function merged(rows: AccountUsageRowWire[]): AccountUsageRowWire[] {
    const out: AccountUsageRowWire[] = [];
    for (const row of rows) {
      const at = out.findIndex((shown) => sameAccountUsage(shown, row));
      if (at < 0) out.push(row);
      else out[at] = foldAccountUsageRow(out[at], row);
    }
    return out;
  }

  // Whether the viewer sees the account: an owner every one, a member the
  // office's and their own.
  function visible(
    source: AccountUsageSource,
    viewer: AccountUsageViewer,
  ): boolean {
    return (
      viewer.owner ||
      source.owners.some(
        (owner) =>
          owner.kind === "office" ||
          (owner.kind === "member" && owner.userId === viewer.userId),
      )
    );
  }

  // A row as a member reads it: the office and the member as owners, the
  // member alone as a member on it, and the email only on their own
  // account. The identity token stays: it names no one.
  function redact(
    row: AccountUsageRowWire,
    viewer: AccountUsageViewer,
  ): AccountUsageRowWire {
    if (viewer.owner) return row;
    const name = deps.username(viewer.userId);
    const owners = row.owners.filter(
      (owner) => owner.kind === "office" || owner.username === name,
    );
    const theirs = owners.some((owner) => owner.kind === "member");
    return {
      ...row,
      owners,
      members: row.members.filter((member) => member === name),
      accountLabel: theirs ? row.accountLabel : null,
    };
  }

  return {
    list({ refresh, viewer }) {
      const sources = deps.sources();
      listed = new Map(sources.map((source) => [source.key, source]));
      // Ids of accounts no longer listed go, and the reader drops their
      // slots.
      for (const [key, id] of idOfKey)
        if (!listed.has(key)) {
          idOfKey.delete(key);
          keyOfId.delete(id);
        }
      deps.reader.retain(new Set(listed.keys()));
      // The viewer's accounts only: a member's visit reads no other
      // member's account, and keeps every slot above.
      const shown = sources.filter((source) => visible(source, viewer));
      for (const source of shown) {
        if (noLimitFromEnv(source.provider, source.env)) continue;
        // The read lands in the reader's slot; the card asks for the row.
        void deps.reader
          .readAccount(targetOf(source), { refresh })
          .catch(() => {});
      }
      const members = membersByKey();
      const rows = shown.map((source) => {
        const slot = deps.reader.peek(source.key);
        return rowOf(
          source,
          slot.reading ? null : slot.answer,
          members.get(source.key) ?? [],
        );
      });
      // Redacted after the merge: a merged row lists the viewer as an
      // owner when any of its accounts is theirs.
      return { rows: merged(rows).map((row) => redact(row, viewer)) };
    },
    async row(rowId, viewer) {
      const key = keyOfId.get(rowId);
      const source = key === undefined ? undefined : listed.get(key);
      if (!source || !visible(source, viewer)) return null;
      const answer = noLimitFromEnv(source.provider, source.env)
        ? null
        : await deps.reader.readAccount(targetOf(source));
      // The account may have left the list during the read.
      if (!listed.has(source.key)) return null;
      return redact(
        rowOf(source, answer, membersByKey().get(source.key) ?? []),
        viewer,
      );
    },
  };
}

// The pill's tag of a weekly window (server/backends/claude.ts and the
// Codex adapter): the account-wide one has no model family.
const WEEKLY_SHORT_LABEL = "WK";
