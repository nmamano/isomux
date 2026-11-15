import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderAccountProvider } from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import { hostFor } from "./member-hosts.ts";
import { atomicWriteFileSync } from "./persistence.ts";

const PROVIDER_HOMES_DIR = join(STATE_ROOT, "provider-homes");
const PROVIDER_ACCOUNT_STATE_FILE = join(
  STATE_ROOT,
  "provider-account-state.json",
);

const SAFE_USER_ID = /^[a-zA-Z0-9_-]+$/;

type ProviderActivationState = Record<
  string,
  Partial<Record<ProviderAccountProvider, true>>
>;

function readState(): ProviderActivationState {
  try {
    const parsed = JSON.parse(
      readFileSync(PROVIDER_ACCOUNT_STATE_FILE, "utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ProviderActivationState)
      : {};
  } catch {
    return {};
  }
}

function providerDirName(provider: ProviderAccountProvider): string {
  return provider;
}

// The member's provider home: in their agent space when they have their own
// OS user (server/member-hosts.ts), else in STATE_ROOT.
export function personalProviderHome(
  userId: string,
  provider: ProviderAccountProvider,
): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid user id for provider home");
  }
  const host = hostFor(userId);
  if (host.member !== undefined)
    return join(
      host.agentRoot(),
      "provider-homes",
      userId,
      providerDirName(provider),
    );
  return officePersonalProviderHome(userId, provider);
}

// The provider home in STATE_ROOT, whatever the member's host: what the
// purge and the boot sweep remove (an isolated member's copy in their agent
// space goes through their runner, slice 1c-ii).
export function officePersonalProviderHome(
  userId: string,
  provider: ProviderAccountProvider,
): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid user id for provider home");
  }
  return join(PROVIDER_HOMES_DIR, userId, providerDirName(provider));
}

// Either host: an isolated member's folders are made by their runner, as
// the member.
export async function ensurePersonalProviderHomeOnHost(
  userId: string,
  provider: ProviderAccountProvider,
): Promise<string> {
  const host = hostFor(userId);
  if (host.member === undefined)
    return ensurePersonalProviderHome(userId, provider);
  const providerDir = personalProviderHome(userId, provider);
  await host.fs.mkdir(providerDir, 0o700);
  return providerDir;
}

// The office's file system only: refuses an isolated member, whose home
// only their runner makes (ensurePersonalProviderHomeOnHost).
export function ensurePersonalProviderHome(
  userId: string,
  provider: ProviderAccountProvider,
): string {
  if (hostFor(userId).member !== undefined)
    throw new Error(
      "an isolated member's provider home is made through their host",
    );
  const providerDir = personalProviderHome(userId, provider);
  const userDir = join(PROVIDER_HOMES_DIR, userId);
  for (const dir of [PROVIDER_HOMES_DIR, userDir, providerDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return providerDir;
}

export function isPersonalProviderActive(
  userId: string,
  provider: ProviderAccountProvider,
): boolean {
  return readState()[userId]?.[provider] === true;
}

export function activatePersonalProvider(
  userId: string,
  provider: ProviderAccountProvider,
): void {
  const state = readState();
  state[userId] = { ...state[userId], [provider]: true };
  atomicWriteFileSync(
    PROVIDER_ACCOUNT_STATE_FILE,
    JSON.stringify(state, null, 2),
    0o600,
  );
}

export function deactivatePersonalProvider(
  userId: string,
  provider: ProviderAccountProvider,
): void {
  const state = readState();
  if (!state[userId]?.[provider]) return;
  delete state[userId][provider];
  if (Object.keys(state[userId]).length === 0) delete state[userId];
  atomicWriteFileSync(
    PROVIDER_ACCOUNT_STATE_FILE,
    JSON.stringify(state, null, 2),
    0o600,
  );
}

// The purge of a removed member (task 548d607b): provider-homes/<userId>/,
// with their conversations, and their entry in provider-account-state.json.
export function removePersonalProviderHomes(userId: string): void {
  rmSync(dirname(officePersonalProviderHome(userId, "claude")), {
    recursive: true,
    force: true,
  });
  dropStateEntries((id) => id === userId);
}

// Boot: the provider homes and state entries of ids that are not in
// `keepIds` (the live and the removed members) go.
export function sweepPersonalProviderHomes(keepIds: Iterable<string>): void {
  const keep = new Set(keepIds);
  let names: string[] = [];
  try {
    names = readdirSync(PROVIDER_HOMES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
  }
  for (const name of names)
    if (SAFE_USER_ID.test(name) && !keep.has(name))
      removePersonalProviderHomes(name);
  dropStateEntries((id) => !keep.has(id));
}

// Writes only when an entry goes, so a state file that does not parse
// (read as empty) is never rewritten.
function dropStateEntries(drop: (userId: string) => boolean): void {
  const state = readState();
  const ids = Object.keys(state).filter(drop);
  if (ids.length === 0) return;
  for (const id of ids) delete state[id];
  atomicWriteFileSync(
    PROVIDER_ACCOUNT_STATE_FILE,
    JSON.stringify(state, null, 2),
    0o600,
  );
}
