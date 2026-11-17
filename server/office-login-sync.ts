// The office sign-in for a member with their own OS user (task 56b68f0f).
//
// A non-isolated member on the office sign-in runs in the office account
// folder. An isolated member's agents cannot read that folder, so their
// "office account folder" is a folder in their own space that Isomux keeps
// signed in with the office's current credential. Only the office ever
// renews the office sign-in:
//
// - Claude: their default Claude root (<member home>/.claude). Their runner
//   writes the claudeAiOauth object of its .credentials.json: the office's
//   current access token, a fixed dummy refresh token and a far expiry, so
//   their Claude never renews on its own. A running Claude re-reads the file
//   when it changes. The member file's other keys stay as they are; the
//   office file's other keys (MCP sign-ins) are never copied.
// - Codex: their default Codex home (<agent space>/codex-home), with no
//   auth.json. Their app-server keeps its sign-in in memory and logs in
//   with the office's current access token (OfficeAuth); on a 401 it asks
//   for a new one, which this module answers from the office auth.json,
//   renewed by the office's own Codex.
//
// A sign-in of the member's own found in that folder (one Isomux did not
// write) moves to their personal home first, with the personal switch on.

import {
  existsSync,
  readFileSync,
  rmSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join, resolve } from "node:path";
import { errMessage } from "../shared/errors.ts";
import type { AgentBackendType } from "../shared/types.ts";
import { officeAgentHost, type AgentHost } from "./agent-host.ts";
import { runClaudeAuthStatus } from "./backends/claude-install-check.ts";
import {
  JsonRpcLiteClient,
  OFFICE_ACCOUNT_CHANGED,
} from "./backends/codex/client.ts";
import { STATE_ROOT } from "./config.ts";
import { buildOfficeEnv } from "./env-loader.ts";
import {
  hostFor as memberHostFor,
  memberHostConnected,
} from "./member-hosts.ts";
import { hasMemberOsUser, memberOsUserIds } from "./member-os-users.ts";
import { effectiveProviderDirectory } from "./provider-account-manager.ts";
import { providerFallback } from "./provider-fallback.ts";
import {
  activatePersonalProvider,
  ensurePersonalProviderHomeOnHost,
} from "./provider-homes.ts";

export type OfficeLoginProvider = "claude" | "codex";

// The office's Codex ChatGPT access token, as the app-server's
// chatgptAuthTokens login and refresh answer take it.
export interface OfficeCodexTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

// Given to a Codex app-server client whose home is a member office folder
// (CreateSessionOptions, OneShotOptions, ListModelsOptions).
export interface OfficeAuth {
  // The office's current tokens. Rejects when the office Codex sign-in is
  // not a ChatGPT sign-in or cannot be read.
  tokens(): Promise<OfficeCodexTokens>;
  // Codex was refused `stale`. Re-reads the office auth.json first: a
  // different token is the answer. Only the same token makes the office's
  // own Codex renew, once for every caller that holds it. Rejects when the
  // renewal fails or the account is not `previousAccountId` (when given).
  refresh(
    stale: string,
    previousAccountId: string | null,
  ): Promise<OfficeCodexTokens>;
}

// The fixed refresh token of a member office file: never a real one.
export const MEMBER_OFFICE_DUMMY_REFRESH = "isomux-office-managed";

// The member office folder of an isolated member for `provider`, or null
// for a member without their own OS user (they use the office's folder).
export function memberOfficeFolder(
  userId: string | null | undefined,
  provider: AgentBackendType,
): string | null {
  if (!userId || !hasMemberOsUser(userId)) return null;
  const host = memberHostFor(userId);
  if (provider === "claude") return resolve(host.home(), ".claude");
  if (provider === "codex") return resolve(host.agentRoot(), "codex-home");
  return null;
}

// The isolated member and provider whose member office folder `dir` is, or
// null. Billing, the usage key and the sign-in label map such a folder to
// the office account.
export function memberOfficeFolderOwner(
  dir: string,
): { userId: string; provider: OfficeLoginProvider } | null {
  const wanted = resolve(dir);
  for (const userId of memberOsUserIds())
    for (const provider of ["claude", "codex"] as const)
      if (memberOfficeFolder(userId, provider) === wanted)
        return { userId, provider };
  return null;
}

type Env = { [key: string]: string | undefined };

// The one decision of the office route (H4): the member office folder that
// a launch of `userId` on `provider` with `env` runs in, or null when it
// runs in another folder.
export function officeRouteFolder(
  userId: string | null | undefined,
  provider: AgentBackendType,
  env: Env | undefined,
): string | null {
  const folder = memberOfficeFolder(userId, provider);
  if (!folder) return null;
  try {
    const dir = effectiveProviderDirectory(
      provider as OfficeLoginProvider,
      env ?? officeAgentHost().baseEnv(),
    );
    return resolve(dir) === folder ? folder : null;
  } catch {
    return null;
  }
}

// Before a launch, or a turn, of `userId` in `dir`: when `dir` is their
// member office folder, the office's Claude token written there, or a Codex
// sign-in of their own moved out. Never rejects.
export async function prepareOfficeLogin(
  sync: OfficeLoginSync | null,
  userId: string | null | undefined,
  provider: AgentBackendType,
  dir: string | null | undefined,
): Promise<void> {
  if (!sync || !userId || !dir) return;
  if (resolve(dir) !== memberOfficeFolder(userId, provider)) return;
  try {
    if (provider === "claude") await sync.syncClaude(userId);
    else await sync.prepareCodex(userId);
  } catch (err) {
    console.error(
      `[office-login-sync] ${userId}: the office ${provider} sign-in is not ready in their folder:`,
      errMessage(err),
    );
  }
}

// prepareOfficeLogin for a launch with the env `env()` gives; an env that
// cannot be built prepares nothing.
export async function prepareOfficeLoginFor(
  sync: OfficeLoginSync | null,
  userId: string | null | undefined,
  provider: AgentBackendType,
  env: () => Env | undefined,
): Promise<void> {
  let folder: string | null;
  try {
    folder = officeRouteFolder(userId, provider, env());
  } catch {
    return;
  }
  await prepareOfficeLogin(sync, userId, provider, folder);
}

// The Codex office login of a launch with `env`: set when its home is the
// member office folder.
export function officeAuthFor(
  sync: OfficeLoginSync | null,
  userId: string | null | undefined,
  provider: AgentBackendType,
  env: Env | undefined,
): OfficeAuth | undefined {
  if (!sync || provider !== "codex") return undefined;
  if (!officeRouteFolder(userId, provider, env)) return undefined;
  return sync.codexOfficeAuth() ?? undefined;
}

// The isolated members among `sessions` (live Claude sessions and the
// folder each launched in) whose Claude runs in their member office folder.
export function membersOnOfficeClaude(
  sessions: Iterable<{
    userId: string | null | undefined;
    dir?: string | null;
  }>,
): string[] {
  const members = new Set<string>();
  for (const { userId, dir } of sessions)
    if (userId && dir && resolve(dir) === memberOfficeFolder(userId, "claude"))
      members.add(userId);
  return [...members];
}

export interface OfficeLoginSync {
  // Before a Claude launch (session, one-shot, schedule run) of `userId` in
  // their member office folder, and at each turn start there: migrate an
  // own sign-in found there, then write the office token when it differs
  // from the member file's, or the file is blank or changed. With the
  // office signed out, removes claudeAiOauth from the member file.
  syncClaude(userId: string): Promise<void>;
  // Before the first Codex office login of `userId`: an auth.json in their
  // codex-home is their own sign-in and moves to their personal home.
  prepareCodex(userId: string): Promise<void>;
  // The Codex office login. Its tokens() rejects when the office Codex
  // sign-in is not a ChatGPT sign-in; the client then logs in as it would
  // without it (an env OPENAI_API_KEY, when there is one).
  codexOfficeAuth(): OfficeAuth | null;
  // Watch the office Claude credential while isolated members use it:
  // rewrite their files at each change, and make the office renew shortly
  // before its end.
  start(): void;
  close(): void;
}

// The claudeAiOauth object of a Claude .credentials.json.
export interface ClaudeOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string | null;
  [key: string]: unknown;
}

export interface OfficeLoginSyncDeps {
  // Isolated members with a live Claude session on their member office
  // folder: the ones a change of the office token is written to.
  liveClaudeMembers: () => string[];
  // Defaults: the office account folders, the member's host
  // (member-hosts.ts), `claude auth status` and the office Codex
  // app-server, as the office user.
  readOfficeClaude?: () => Promise<ClaudeOauth | null>;
  renewOfficeClaude?: () => Promise<void>;
  readOfficeCodex?: () => Promise<OfficeCodexTokens | null>;
  renewOfficeCodex?: () => Promise<void>;
  hostFor?: (userId: string) => AgentHost;
  // Every isolated member, and whether their runner is connected: an office
  // token change reaches the files of those with no live session too.
  isolatedMembers?: () => string[];
  connected?: (userId: string) => boolean;
  now?: () => number;
}

// A member file's expiry: far enough that their Claude never renews on its
// own, and fixed, so an unchanged office token writes nothing.
const FAR_END = Date.UTC(2100, 0, 1);
const CREDENTIALS = ".credentials.json";
// The office renews this long before its token ends while a member uses it
// (Claude itself renews within 5 minutes of the end).
const RENEW_BEFORE_MS = 4 * 60 * 1000;
// A renewal for the same office token is not tried again before this.
const RENEW_RETRY_MS = 60 * 1000;
// The backstop of the office file watch, and of the renewal check.
const POLL_MS = 30 * 1000;
const RENEW_TIMEOUT_MS = 30 * 1000;

type Json = Record<string, unknown>;

function parseObject(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Json)
      : {};
  } catch {
    return {};
  }
}

function isClaudeOauth(value: unknown): value is ClaudeOauth {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ClaudeOauth).accessToken === "string" &&
    (value as ClaudeOauth).accessToken !== ""
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The office account folder of `provider`, as the office's env names it
// (the folder the member usage cap reads).
function officeDir(provider: OfficeLoginProvider): string {
  return effectiveProviderDirectory(provider, buildOfficeEnv());
}

function officeEnv(provider: OfficeLoginProvider): Record<string, string> {
  const env = buildOfficeEnv();
  const name = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return Object.fromEntries(
    Object.entries({ ...env, [name]: officeDir(provider) }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

// Null only when the office is signed out: no file, or no claudeAiOauth in
// it. Any other failure (a read error, a file that does not parse) throws,
// and the members' files stay as they are.
async function defaultReadOfficeClaude(): Promise<ClaudeOauth | null> {
  let text: string;
  try {
    text = readFileSync(join(officeDir("claude"), CREDENTIALS), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const file: unknown = JSON.parse(text);
  const oauth =
    file && typeof file === "object" ? (file as Json).claudeAiOauth : undefined;
  return isClaudeOauth(oauth) ? oauth : null;
}

async function defaultRenewOfficeClaude(): Promise<void> {
  // `claude auth status` renews a token near its end, as the office user,
  // under Claude's own lock; it runs no model.
  await runClaudeAuthStatus(officeEnv("claude"), undefined, RENEW_TIMEOUT_MS);
}

function jwtClaims(token: unknown): Json | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return parseObject(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// The office auth.json's access token, account and plan; never its refresh
// token. Null when it holds no ChatGPT sign-in.
async function defaultReadOfficeCodex(): Promise<OfficeCodexTokens | null> {
  let file: Json | null;
  try {
    file = parseObject(
      readFileSync(join(officeDir("codex"), "auth.json"), "utf8"),
    );
  } catch {
    return null;
  }
  const tokens = file?.tokens as Json | undefined;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  const auth = (jwtClaims(tokens?.id_token)?.["https://api.openai.com/auth"] ??
    {}) as Json;
  const accountId =
    typeof tokens?.account_id === "string"
      ? tokens.account_id
      : typeof auth.chatgpt_account_id === "string"
        ? auth.chatgpt_account_id
        : null;
  if (!accountId) return null;
  return {
    accessToken,
    chatgptAccountId: accountId,
    chatgptPlanType:
      typeof auth.chatgpt_plan_type === "string"
        ? auth.chatgpt_plan_type
        : null,
  };
}

// The office's own Codex renews its sign-in (the managed refresh, which
// re-reads auth.json first and writes it in place).
async function defaultRenewOfficeCodex(): Promise<void> {
  const client = new JsonRpcLiteClient({
    env: officeEnv("codex"),
    envApiKeyLogin: false,
  });
  const timer = setTimeout(
    () => void client.close().catch(() => {}),
    RENEW_TIMEOUT_MS,
  );
  try {
    await client.start();
    await client.initialize({
      clientInfo: { name: "isomux", version: "1", title: null },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    });
    await client.request("account/read", { refreshToken: true });
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

export function createOfficeLoginSync(
  deps: OfficeLoginSyncDeps,
): OfficeLoginSync {
  const now = deps.now ?? Date.now;
  const readOfficeClaude = deps.readOfficeClaude ?? defaultReadOfficeClaude;
  const renewOfficeClaude = deps.renewOfficeClaude ?? defaultRenewOfficeClaude;
  const readOfficeCodex = deps.readOfficeCodex ?? defaultReadOfficeCodex;
  const renewOfficeCodex = deps.renewOfficeCodex ?? defaultRenewOfficeCodex;
  const hostOf = deps.hostFor ?? ((userId: string) => memberHostFor(userId));

  // One sync per member at a time.
  const chains = new Map<string, Promise<void>>();
  function serial(key: string, run: () => Promise<void>): Promise<void> {
    const next = (chains.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(run);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  }

  async function readText(
    host: AgentHost,
    path: string,
  ): Promise<string | null> {
    if (!(await host.fs.exists(path))) return null;
    try {
      return await host.fs.readText(path);
    } catch {
      return null;
    }
  }

  async function writePrivate(
    host: AgentHost,
    path: string,
    text: string,
  ): Promise<void> {
    // A running Claude re-reads the file at each change: it never sees a
    // part of one.
    await host.fs.writeText(path, text, { mode: 0o600, atomic: true });
  }

  // A sign-in of the member's own found in their member office folder goes
  // to their personal home, with the personal switch on. An existing file
  // there is never replaced: the moved one gets a name of its own.
  async function moveOwnSignIn(
    userId: string,
    provider: OfficeLoginProvider,
    host: AgentHost,
    name: string,
    text: string,
  ): Promise<void> {
    const personal = await ensurePersonalProviderHomeOnHost(userId, provider);
    let target = join(personal, name);
    if (await host.fs.exists(target))
      target = join(personal, `${name}.from-office-folder-${now()}`);
    await writePrivate(host, target, text);
    activatePersonalProvider(userId, provider);
    providerFallback().accountChanged(userId, provider);
    console.log(
      `[office-login-sync] ${userId}: their own ${provider} sign-in moved from the office sign-in folder to their personal home (${target})`,
    );
  }

  // `copyOnly`: only a file that holds an office copy (a member with no
  // live session); anything else there stays as it is.
  async function syncClaudeNow(
    userId: string,
    copyOnly = false,
  ): Promise<void> {
    const folder = memberOfficeFolder(userId, "claude");
    if (!folder) return;
    const host = hostOf(userId);
    const path = join(folder, CREDENTIALS);
    const text = await readText(host, path);
    let file = parseObject(text) ?? {};
    const current = file.claudeAiOauth;
    if (
      copyOnly &&
      (!isClaudeOauth(current) ||
        current.refreshToken !== MEMBER_OFFICE_DUMMY_REFRESH)
    )
      return;
    if (
      isClaudeOauth(current) &&
      typeof current.refreshToken === "string" &&
      current.refreshToken !== "" &&
      current.refreshToken !== MEMBER_OFFICE_DUMMY_REFRESH
    ) {
      await moveOwnSignIn(userId, "claude", host, CREDENTIALS, text!);
      const { claudeAiOauth: _own, ...rest } = file;
      file = rest;
    }
    const office = await readOfficeClaude();
    if (!office) {
      // The office signed out: their copy of its token goes too.
      if (!("claudeAiOauth" in file)) return;
      const { claudeAiOauth: _gone, ...rest } = file;
      await host.fs.mkdir(folder, 0o700);
      await writePrivate(host, path, JSON.stringify(rest));
      return;
    }
    const wanted: ClaudeOauth = {
      ...office,
      refreshToken: MEMBER_OFFICE_DUMMY_REFRESH,
      expiresAt: FAR_END,
    };
    if (sameJson(file.claudeAiOauth, wanted) && text !== null) return;
    await host.fs.mkdir(folder, 0o700);
    await writePrivate(
      host,
      path,
      JSON.stringify({ ...file, claudeAiOauth: wanted }),
    );
  }

  async function prepareCodexNow(userId: string): Promise<void> {
    const folder = memberOfficeFolder(userId, "codex");
    if (!folder) return;
    const host = hostOf(userId);
    const path = join(folder, "auth.json");
    const text = await readText(host, path);
    if (text === null) return;
    await moveOwnSignIn(userId, "codex", host, "auth.json", text);
    await host.fs.rm(path);
  }

  // The Codex refresh: one office renewal per refused token. A failed one
  // answers every caller with that token for RENEW_RETRY_MS, so many
  // sessions on a dead token start one renewal a minute.
  type Renewal = { renewal: Promise<OfficeCodexTokens>; failedAt?: number };
  const renewals = new Map<string, Renewal>();
  async function current(): Promise<OfficeCodexTokens> {
    const tokens = await readOfficeCodex();
    if (!tokens)
      throw new Error("the office Codex sign-in is not a ChatGPT sign-in");
    return tokens;
  }
  function sameAccount(
    tokens: OfficeCodexTokens,
    previousAccountId: string | null,
  ): OfficeCodexTokens {
    if (previousAccountId && tokens.chatgptAccountId !== previousAccountId)
      throw Object.assign(
        // Only the app-server reads it, as the refresh's error.
        new Error("the office Codex sign-in is now another ChatGPT account"),
        { code: OFFICE_ACCOUNT_CHANGED },
      );
    return tokens;
  }
  const officeAuth: OfficeAuth = {
    tokens: current,
    async refresh(stale, previousAccountId) {
      const tokens = sameAccount(await current(), previousAccountId);
      if (tokens.accessToken !== stale) return tokens;
      for (const [token, entry] of renewals)
        if (
          entry.failedAt !== undefined &&
          now() - entry.failedAt >= RENEW_RETRY_MS
        )
          renewals.delete(token);
      let entry = renewals.get(stale);
      if (!entry) {
        const made: Renewal = {
          renewal: (async () => {
            await renewOfficeCodex();
            const next = await current();
            if (next.accessToken === stale)
              throw new Error("the office Codex sign-in was not renewed");
            return next;
          })(),
        };
        renewals.set(stale, made);
        made.renewal.then(
          () => {
            if (renewals.get(stale) === made) renewals.delete(stale);
          },
          () => {
            made.failedAt = now();
          },
        );
        entry = made;
      }
      return sameAccount(await entry.renewal, previousAccountId);
    },
  };

  // The office Claude token while members use it.
  let watcher: FSWatcher | null = null;
  let watchedDir: string | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let renewing: Promise<void> | null = null;
  let lastRenewal: { token: string; at: number } | null = null;
  let closed = true;

  function syncMember(userId: string, copyOnly = false): void {
    void serial(userId, () => syncClaudeNow(userId, copyOnly)).catch(
      (err: unknown) =>
        console.error(
          `[office-login-sync] ${userId}: the office Claude sign-in did not reach their folder:`,
          errMessage(err),
        ),
    );
  }

  function syncLive(): void {
    for (const userId of new Set(deps.liveClaudeMembers())) syncMember(userId);
  }

  // A change of the office token (a sign-out, another account, a renewal)
  // also reaches a connected member with no live session whose file holds
  // an office copy: the copy goes, or is the new token. A member whose
  // runner is not connected gets it at their next launch.
  let swept: string | null | undefined;
  let readError: string | null = null;
  async function sweepIdle(): Promise<void> {
    const members = (deps.isolatedMembers ?? memberOsUserIds)();
    if (members.length === 0) return;
    let office: ClaudeOauth | null;
    try {
      office = await readOfficeClaude();
      readError = null;
    } catch (err) {
      // Logged once per error, not at every poll.
      if (errMessage(err) !== readError)
        console.error(
          "[office-login-sync] cannot read the office Claude sign-in:",
          errMessage(err),
        );
      readError = errMessage(err);
      return;
    }
    const token = office?.accessToken ?? null;
    if (token === swept) return;
    swept = token;
    const live = new Set(deps.liveClaudeMembers());
    for (const userId of members)
      if (!live.has(userId) && (deps.connected ?? memberHostConnected)(userId))
        syncMember(userId, true);
  }

  async function renewIfEnding(): Promise<void> {
    if (renewing || deps.liveClaudeMembers().length === 0) return;
    const office = await readOfficeClaude();
    if (!office || typeof office.expiresAt !== "number") return;
    const at = now();
    if (office.expiresAt - at > RENEW_BEFORE_MS) return;
    if (
      lastRenewal &&
      lastRenewal.token === office.accessToken &&
      at - lastRenewal.at < RENEW_RETRY_MS
    )
      return;
    lastRenewal = { token: office.accessToken, at };
    renewing = renewOfficeClaude()
      .catch((err: unknown) =>
        console.error(
          "[office-login-sync] the office Claude sign-in did not renew:",
          errMessage(err),
        ),
      )
      .finally(() => {
        renewing = null;
      });
    await renewing;
    if (!closed) syncLive();
  }

  function check(): void {
    if (closed) return;
    rewatch();
    syncLive();
    void sweepIdle().catch(() => {});
    void renewIfEnding().catch(() => {});
  }

  // Claude renews by write-then-rename: the folder is watched, not the file.
  function rewatch(): void {
    let dir: string;
    try {
      dir = officeDir("claude");
    } catch {
      return;
    }
    if (dir === watchedDir && watcher) return;
    watcher?.close();
    watcher = null;
    watchedDir = dir;
    if (!existsSync(dir)) return;
    try {
      watcher = watch(dir, (_event, name) => {
        if (name !== null && name !== CREDENTIALS) return;
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          check();
        }, 50);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  return {
    syncClaude: (userId) => serial(userId, () => syncClaudeNow(userId)),
    prepareCodex: (userId) =>
      serial(`${userId}:codex`, () => prepareCodexNow(userId)),
    codexOfficeAuth: () => officeAuth,
    start() {
      if (!closed) return;
      closed = false;
      poll = setInterval(check, POLL_MS);
      poll.unref?.();
      check();
    },
    close() {
      closed = true;
      if (poll) clearInterval(poll);
      poll = null;
      if (pending) clearTimeout(pending);
      pending = null;
      watcher?.close();
      watcher = null;
      watchedDir = null;
      swept = undefined;
    },
  };
}

// The office's instance, set by the agent manager that owns the agents it
// watches; the model list and schedules use it too.
let shared: OfficeLoginSync | null = null;
export function setOfficeLoginSync(sync: OfficeLoginSync | null): void {
  if (shared !== sync) shared?.close();
  shared = sync;
}
export function officeLoginSync(): OfficeLoginSync | null {
  return shared;
}

// The file of the removed members' Claude token (task b94dfd25, part 4a):
// the office sign-in in their own space replaces it.
export const LEGACY_MEMBER_TOKEN_FILE = join(
  STATE_ROOT,
  "secrets",
  "claude-member-token.json",
);

// Deletes the file of the removed members' Claude token feature, once.
export function removeLegacyMemberToken(): void {
  if (!existsSync(LEGACY_MEMBER_TOKEN_FILE)) return;
  try {
    rmSync(LEGACY_MEMBER_TOKEN_FILE, { force: true });
    console.log(
      "[office-login-sync] removed the members' Claude token: members with their own OS user now use the office sign-in in their own space",
    );
  } catch (err) {
    console.error(
      "[office-login-sync] could not remove the members' Claude token file:",
      errMessage(err),
    );
  }
}
