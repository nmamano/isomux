import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAccountProvider } from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

const PROVIDER_HOMES_DIR = join(STATE_ROOT, "provider-homes");
const PROVIDER_ACCOUNT_STATE_FILE = join(
  STATE_ROOT,
  "provider-account-state.json",
);

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

export function personalProviderHome(
  userId: string,
  provider: ProviderAccountProvider,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error("Invalid user id for provider home");
  }
  return join(PROVIDER_HOMES_DIR, userId, providerDirName(provider));
}

export function ensurePersonalProviderHome(
  userId: string,
  provider: ProviderAccountProvider,
): string {
  const userDir = join(PROVIDER_HOMES_DIR, userId);
  const providerDir = personalProviderHome(userId, provider);
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
