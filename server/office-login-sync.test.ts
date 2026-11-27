// The office sign-in in an isolated member's own space
// (server/office-login-sync.ts, task 56b68f0f). The properties:
// - the member office folder is the member's default Claude root and Codex
//   home, and only an isolated member has one;
// - the member's Claude file gets only the office's access token, never a
//   refresh token the office could lose to it, and never the office file's
//   other keys; the member file's other keys stay (W);
// - a blank or changed member file is written again, also with the office
//   token unchanged (T); an office sign-out takes the token away (S);
// - a sign-in of the member's own found there moves to their personal home
//   with the personal switch on, never overwritten (M), for both engines;
// - the Codex refresh renews the office sign-in only when the office still
//   holds the refused token, once for every caller (C1, C5).
//
// Seam: createOfficeLoginSync with the office reads and renewals injected,
// and the recording member host of member-host-fixture.ts, whose files are
// local files.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  createOfficeLoginSync,
  MEMBER_OFFICE_DUMMY_REFRESH,
  type ClaudeOauth,
  type OfficeCodexTokens,
  type OfficeLoginSyncDeps,
} from "./office-login-sync.ts";
import {
  memberOfficeFolder,
  memberOfficeFolderOwner,
} from "./provider-folders.ts";
import {
  activatePersonalProvider,
  isPersonalProviderActive,
  personalProviderHome,
} from "./provider-homes.ts";
import { ProviderAccountManager } from "./provider-account-manager.ts";
import { createMember, deleteUserById, getUserByName } from "./users.ts";
import {
  isolateMember,
  type IsolatedMember,
} from "./test-support/member-host-fixture.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./test-support/managed-office-env.ts";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  forgetMemberOsUser,
  memberOsUserState,
  recordMemberOsUser,
} from "./member-os-users.ts";
import { connectMemberHost } from "./member-hosts.ts";

function memberId(name: string): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const created = createMember(name, { role: "member" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

const HOUR = 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function officeOauth(accessToken: string, expiresAt = Date.now() + 5 * HOUR) {
  return {
    accessToken,
    refreshToken: "office-refresh-SECRET",
    expiresAt,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  } satisfies ClaudeOauth;
}

let iso: IsolatedMember;
let scratch: string;
const opened: { close(): void }[] = [];

beforeEach(async () => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
  scratch = mkdtempSync(join(tmpdir(), "office-login-sync-"));
  iso = await isolateMember(memberId("Olga"));
});

afterEach(() => {
  for (const sync of opened.splice(0)) sync.close();
  iso.dispose();
  clearTestManagedOfficeEnv();
  rmSync(scratch, { recursive: true, force: true });
});

// A sync whose office Claude sign-in is `office.claude` and Codex sign-in
// `office.codex`, with recorded renewals.
function makeSync(
  office: {
    claude?: ClaudeOauth | null;
    codex?: OfficeCodexTokens | null;
  },
  extra: Partial<OfficeLoginSyncDeps> = {},
) {
  const renewals = { claude: 0, codex: 0 };
  const sync = createOfficeLoginSync({
    liveClaudeMembers: () => [],
    readOfficeClaude: async () => office.claude ?? null,
    renewOfficeClaude: async () => {
      renewals.claude++;
    },
    readOfficeCodex: async () => office.codex ?? null,
    renewOfficeCodex: async () => {
      renewals.codex++;
    },
    ...extra,
  });
  opened.push(sync);
  return { sync, renewals };
}

const claudeFolder = () => join(iso.home, ".claude");
const claudeFile = () => join(claudeFolder(), ".credentials.json");
const codexFolder = () => join(iso.member.host.agentRoot(), "codex-home");
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
const oauthIn = (path: string) =>
  readJson(path).claudeAiOauth as ClaudeOauth | undefined;

describe("the member office folder", () => {
  it("is an isolated member's default Claude root and Codex home, and no one else has one", () => {
    const plain = memberId("Pia");
    expect({
      claude: memberOfficeFolder(iso.userId, "claude"),
      codex: memberOfficeFolder(iso.userId, "codex"),
      opencode: memberOfficeFolder(iso.userId, "opencode"),
      plain: memberOfficeFolder(plain, "claude"),
      none: memberOfficeFolder(null, "claude"),
    }).toEqual({
      claude: claudeFolder(),
      codex: codexFolder(),
      opencode: null,
      plain: null,
      none: null,
    });
  });

  it("maps back to its member and provider, and no other folder does", () => {
    expect({
      claude: memberOfficeFolderOwner(claudeFolder()),
      codex: memberOfficeFolderOwner(codexFolder()),
      personal: memberOfficeFolderOwner(
        personalProviderHome(iso.userId, "claude"),
      ),
      other: memberOfficeFolderOwner(join(STATE_ROOT, "office-claude")),
    }).toEqual({
      claude: { userId: iso.userId, provider: "claude" },
      codex: { userId: iso.userId, provider: "codex" },
      personal: null,
      other: null,
    });
  });
});

describe("the member's Claude file", () => {
  it("gets the office's access token with a dummy refresh token and a far end, and keeps the member's other keys", async () => {
    const office = officeOauth("office-access-1");
    writeJson(claudeFile(), {
      mcpOAuth: { "her-server": { accessToken: "hers" } },
    });
    const { sync } = makeSync({ claude: office });
    await sync.syncClaude(iso.userId);
    const file = readJson(claudeFile());
    const oauth = file.claudeAiOauth as ClaudeOauth;
    expect({
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      farEnd: oauth.expiresAt > Date.now() + 365 * 24 * HOUR,
      scopes: oauth.scopes,
      mcpOAuth: file.mcpOAuth,
      mode: statSync(claudeFile()).mode & 0o777,
      officeRefresh: readFileSync(claudeFile(), "utf8").includes(
        "office-refresh-SECRET",
      ),
    }).toEqual({
      accessToken: "office-access-1",
      refreshToken: MEMBER_OFFICE_DUMMY_REFRESH,
      farEnd: true,
      scopes: office.scopes,
      mcpOAuth: { "her-server": { accessToken: "hers" } },
      mode: 0o600,
      officeRefresh: false,
    });
  });

  // W, with the office's real file: its MCP sign-ins (with their refresh
  // tokens) never reach the member.
  it("never gets the office file's other keys", async () => {
    const officeDir = join(scratch, "office-claude");
    writeJson(join(officeDir, ".credentials.json"), {
      claudeAiOauth: officeOauth("office-access-1"),
      mcpOAuth: {
        "office-server": {
          accessToken: "office-mcp-access",
          refreshToken: "office-mcp-refresh",
        },
      },
    });
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeDir });
    const { sync } = makeSync(
      {},
      { readOfficeClaude: undefined, renewOfficeClaude: async () => {} },
    );
    await sync.syncClaude(iso.userId);
    const text = readFileSync(claudeFile(), "utf8");
    expect({
      // The enabling condition: the office's token was read and written.
      access: oauthIn(claudeFile())?.accessToken,
      keys: Object.keys(JSON.parse(text)),
      leaked: ["office-mcp", "office-refresh-SECRET"].filter((s) =>
        text.includes(s),
      ),
    }).toEqual({
      access: "office-access-1",
      keys: ["claudeAiOauth"],
      leaked: [],
    });
  });

  it("is written again when the office token changes", async () => {
    const office = { claude: officeOauth("office-access-1") };
    const { sync } = makeSync(office);
    await sync.syncClaude(iso.userId);
    office.claude = officeOauth("office-access-2");
    await sync.syncClaude(iso.userId);
    expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-2");
  });

  // T: the member's Claude blanks its file after a refused token (its
  // refresh with the dummy fails). The office token did not change, and the
  // next sync still writes it.
  for (const [how, blank] of [
    ["blanked", (path: string) => writeJson(path, {})],
    ["emptied", (path: string) => writeFileSync(path, "")],
    ["removed", (path: string) => rmSync(path)],
    [
      "rewritten by the member",
      (path: string) =>
        writeJson(path, {
          claudeAiOauth: { ...oauthIn(path)!, accessToken: "edited" },
        }),
    ],
  ] as const) {
    it(`is written again when the member file was ${how}, with the office token unchanged`, async () => {
      const { sync } = makeSync({ claude: officeOauth("office-access-1") });
      await sync.syncClaude(iso.userId);
      // The enabling condition: the first sync wrote the token.
      expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
      blank(claudeFile());
      await sync.syncClaude(iso.userId);
      expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
    });
  }

  // S: an owner's sign-out takes the token away from the member, who keeps
  // the rest of their file.
  it("loses the office token when the office signs out, and keeps its other keys", async () => {
    const office: { claude: ClaudeOauth | null } = {
      claude: officeOauth("office-access-1"),
    };
    const { sync } = makeSync(office);
    await sync.syncClaude(iso.userId);
    const file = readJson(claudeFile());
    writeJson(claudeFile(), {
      ...file,
      mcpOAuth: { "her-server": { accessToken: "hers" } },
    });
    // The enabling condition: the token was there.
    expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
    office.claude = null;
    await sync.syncClaude(iso.userId);
    const after = readJson(claudeFile());
    expect({
      oauth: after.claudeAiOauth,
      mcpOAuth: after.mcpOAuth,
      token: readFileSync(claudeFile(), "utf8").includes("office-access-1"),
    }).toEqual({
      oauth: undefined,
      mcpOAuth: { "her-server": { accessToken: "hers" } },
      token: false,
    });
  });

  // F9: only a missing file, or one with no Claude sign-in, is a sign-out.
  // An office file that cannot be read or parsed changes no member file.
  it("keeps the member's token when the office file does not parse", async () => {
    const officeDir = join(scratch, "office-claude");
    const officeFile = join(officeDir, ".credentials.json");
    writeJson(officeFile, { claudeAiOauth: officeOauth("office-access-1") });
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeDir });
    const { sync } = makeSync(
      {},
      { readOfficeClaude: undefined, renewOfficeClaude: async () => {} },
    );
    await sync.syncClaude(iso.userId);
    // The enabling condition: the token was there.
    expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
    writeFileSync(officeFile, '{"claudeAiOauth": {"accessTo');
    await sync.syncClaude(iso.userId).catch(() => {});
    expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
  });

  // M: a sign-in the member made in that folder before this change.
  it("moves a sign-in of the member's own to their personal home, with the personal switch on, and never overwrites it", async () => {
    const own = {
      claudeAiOauth: {
        accessToken: "her-access",
        refreshToken: "her-refresh",
        expiresAt: Date.now() + HOUR,
      },
    };
    writeJson(claudeFile(), own);
    expect(isPersonalProviderActive(iso.userId, "claude")).toBe(false);
    const { sync } = makeSync({ claude: officeOauth("office-access-1") });
    await sync.syncClaude(iso.userId);
    const personal = join(
      personalProviderHome(iso.userId, "claude"),
      ".credentials.json",
    );
    const left = existsSync(claudeFile())
      ? readFileSync(claudeFile(), "utf8")
      : "";
    expect({
      moved: existsSync(personal) ? oauthIn(personal) : null,
      switchOn: isPersonalProviderActive(iso.userId, "claude"),
      leftBehind: left.includes("her-refresh"),
    }).toEqual({
      moved: own.claudeAiOauth,
      switchOn: true,
      leftBehind: false,
    });
  });

  it("does not move a file Isomux wrote", async () => {
    const office = { claude: officeOauth("office-access-1") };
    const { sync } = makeSync(office);
    await sync.syncClaude(iso.userId);
    office.claude = officeOauth("office-access-2");
    await sync.syncClaude(iso.userId);
    expect({
      switchOn: isPersonalProviderActive(iso.userId, "claude"),
      personal: existsSync(
        join(personalProviderHome(iso.userId, "claude"), ".credentials.json"),
      ),
    }).toEqual({ switchOn: false, personal: false });
  });
});

// Task 12c796b2: members on one OS user share its default Claude folder, so
// their syncs read and write one file. They run one after another, as one
// member's do, or one could write back what it read before the other wrote.
describe("the Claude file of an OS user that two members run as", () => {
  it("is synced for one member at a time", async () => {
    const pia = memberId("Pia");
    const olga = memberOsUserState(iso.userId);
    if (olga.kind !== "isolated") throw new Error("Olga is not isolated");
    recordMemberOsUser(pia, olga.osUser);
    try {
      expect(await connectMemberHost(pia)).toBe(true);
      // The enabling condition: one folder for both.
      expect(memberOfficeFolder(pia, "claude")).toBe(
        memberOfficeFolder(iso.userId, "claude"),
      );
      let active = 0;
      let most = 0;
      let reads = 0;
      const { sync } = makeSync(
        {},
        {
          readOfficeClaude: async () => {
            reads++;
            most = Math.max(most, ++active);
            await sleep(30);
            active--;
            return officeOauth("office-access-1");
          },
        },
      );
      await Promise.all([sync.syncClaude(iso.userId), sync.syncClaude(pia)]);
      expect(reads).toBe(2);
      expect(most).toBe(1);
      expect(
        (readJson(claudeFile()).claudeAiOauth as ClaudeOauth).accessToken,
      ).toBe("office-access-1");
    } finally {
      forgetMemberOsUser(pia);
      deleteUserById(pia);
    }
  });
});

describe("the office's Claude sign-in while members use it", () => {
  it("reaches a live member's file when the office file changes, with no sync call", async () => {
    const officeDir = join(scratch, "office-claude");
    const officeFile = join(officeDir, ".credentials.json");
    writeJson(officeFile, { claudeAiOauth: officeOauth("office-access-1") });
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeDir });
    const { sync } = makeSync(
      {},
      {
        readOfficeClaude: undefined,
        renewOfficeClaude: async () => {},
        liveClaudeMembers: () => [iso.userId],
      },
    );
    await sync.syncClaude(iso.userId);
    sync.start();
    // Claude renews by write-then-rename.
    writeJson(`${officeFile}.tmp`, {
      claudeAiOauth: officeOauth("office-access-2"),
    });
    Bun.spawnSync(["mv", `${officeFile}.tmp`, officeFile]);
    await waitUntil(
      () => oauthIn(claudeFile())?.accessToken === "office-access-2",
      "the member file follows the office file",
    );
  });

  // S: an owner's sign-out reaches every member file Isomux wrote, also of
  // a member with no live session: the token in it stays valid for hours.
  it("takes the token away from an idle member's file when the office signs out", async () => {
    const officeDir = join(scratch, "office-claude");
    const officeFile = join(officeDir, ".credentials.json");
    writeJson(officeFile, { claudeAiOauth: officeOauth("office-access-1") });
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeDir });
    const { sync } = makeSync(
      {},
      {
        readOfficeClaude: undefined,
        renewOfficeClaude: async () => {},
        liveClaudeMembers: () => [],
      },
    );
    await sync.syncClaude(iso.userId);
    // The enabling condition: the token was there.
    expect(oauthIn(claudeFile())?.accessToken).toBe("office-access-1");
    sync.start();
    rmSync(officeFile);
    await waitUntil(
      () => oauthIn(claudeFile()) === undefined,
      "the idle member's file loses the token",
    );
  });

  // The office renews near its end even when no office agent runs, so a
  // member's session never meets an expired token; only while a member
  // uses it.
  it("makes the office renew near its end while a member uses it, once", async () => {
    const live: string[] = [];
    const ending = officeOauth("office-access-1", Date.now() + 3 * 60 * 1000);
    const idle = makeSync({ claude: ending }, { liveClaudeMembers: () => [] });
    idle.sync.start();
    const used = makeSync(
      { claude: ending },
      { liveClaudeMembers: () => live },
    );
    live.push(iso.userId);
    await used.sync.syncClaude(iso.userId);
    used.sync.start();
    await waitUntil(() => used.renewals.claude > 0, "the office renews");
    await sleep(200);
    expect({ used: used.renewals.claude, idle: idle.renewals.claude }).toEqual({
      used: 1,
      idle: 0,
    });
  });
});

describe("the member's Codex home", () => {
  it("moves an auth.json of the member's own to their personal home, with the personal switch on", async () => {
    const own = {
      tokens: { access_token: "her", refresh_token: "her-refresh" },
    };
    writeJson(join(codexFolder(), "auth.json"), own);
    const { sync } = makeSync({});
    await sync.prepareCodex(iso.userId);
    const personal = join(
      personalProviderHome(iso.userId, "codex"),
      "auth.json",
    );
    expect({
      moved: existsSync(personal) ? readJson(personal) : null,
      switchOn: isPersonalProviderActive(iso.userId, "codex"),
      leftBehind: existsSync(join(codexFolder(), "auth.json")),
    }).toEqual({ moved: own, switchOn: true, leftBehind: false });
  });

  it("with no auth.json, changes nothing", async () => {
    const { sync } = makeSync({});
    await sync.prepareCodex(iso.userId);
    expect(isPersonalProviderActive(iso.userId, "codex")).toBe(false);
  });
});

describe("the office Codex login", () => {
  const tokens = (accessToken: string, accountId = "acct-office") => ({
    accessToken,
    chatgptAccountId: accountId,
    chatgptPlanType: "plus",
  });

  it("answers a refused token with the office's newer one, without a renewal", async () => {
    const office = { codex: tokens("codex-2") };
    const { sync, renewals } = makeSync(office);
    const auth = sync.codexOfficeAuth()!;
    expect([
      await auth.refresh("codex-1", "acct-office"),
      renewals.codex,
    ]).toEqual([tokens("codex-2"), 0]);
  });

  it("renews once for every caller that holds the refused token, and answers them all", async () => {
    const office = { codex: tokens("codex-1") };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let renewals = 0;
    const { sync } = makeSync(office, {
      renewOfficeCodex: async () => {
        renewals++;
        await gate;
        office.codex = tokens("codex-2");
      },
    });
    const auth = sync.codexOfficeAuth()!;
    const answers = Promise.all(
      [1, 2, 3].map(() => auth.refresh("codex-1", "acct-office")),
    );
    await waitUntil(() => renewals === 1, "the renewal started");
    await sleep(50);
    release();
    expect([await answers, renewals]).toEqual([
      [tokens("codex-2"), tokens("codex-2"), tokens("codex-2")],
      1,
    ]);
  });

  it("a failed renewal fails every waiting caller, after one renewal", async () => {
    let renewals = 0;
    const { sync } = makeSync(
      { codex: tokens("codex-1") },
      {
        renewOfficeCodex: async () => {
          renewals++;
          await sleep(20);
          throw new Error("refresh_token_reused");
        },
      },
    );
    const auth = sync.codexOfficeAuth()!;
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => auth.refresh("codex-1", "acct-office")),
    );
    expect([results.map((r) => r.status), renewals]).toEqual([
      ["rejected", "rejected", "rejected"],
      1,
    ]);
  });

  // F8: many sessions on one dead token start one renewal a minute.
  it("holds a failed renewal for a minute, then tries again", async () => {
    let now = 1_000_000;
    let renewals = 0;
    const { sync } = makeSync(
      { codex: tokens("codex-1") },
      {
        now: () => now,
        renewOfficeCodex: async () => {
          renewals++;
          throw new Error("refresh_token_reused");
        },
      },
    );
    const auth = sync.codexOfficeAuth()!;
    const attempt = () =>
      auth.refresh("codex-1", "acct-office").then(
        () => "answered",
        () => "refused",
      );
    const first = await attempt();
    now += 30_000;
    const held = await attempt();
    const heldRenewals = renewals;
    now += 31_000;
    const again = await attempt();
    expect([first, held, heldRenewals, again, renewals]).toEqual([
      "refused",
      "refused",
      1,
      "refused",
      2,
    ]);
  });

  // C5: the office changed ChatGPT accounts. No thread goes on to another
  // account mid-turn.
  it("refuses a token of another account than the session's", async () => {
    const { sync, renewals } = makeSync({
      codex: tokens("codex-9", "acct-other"),
    });
    const auth = sync.codexOfficeAuth()!;
    const result = await auth.refresh("codex-1", "acct-office").then(
      () => "answered",
      () => "refused",
    );
    expect([result, renewals.codex]).toEqual(["refused", 0]);
  });

  it("refuses the login when the office Codex sign-in is not a ChatGPT one", async () => {
    const { sync } = makeSync({ codex: null });
    const auth = sync.codexOfficeAuth();
    const result = auth
      ? await auth.tokens().then(
          () => "answered",
          () => "refused",
        )
      : "no login";
    expect(["refused", "no login"]).toContain(result);
  });

  // With the office's real auth.json: only its access token and account
  // leave the office, never its refresh token.
  it("reads the office auth.json and gives out no refresh token", async () => {
    const officeHome = join(scratch, "office-codex");
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwt = (claims: unknown) =>
      `${b64({ alg: "none" })}.${b64(claims)}.sig`;
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    writeJson(join(officeHome, "auth.json"), {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "plus",
            chatgpt_account_id: "acct-office",
          },
        }),
        access_token: access,
        refresh_token: "codex-office-refresh-SECRET",
        account_id: "acct-office",
      },
      last_refresh: new Date().toISOString(),
    });
    setTestManagedOfficeEnv({ CODEX_HOME: officeHome });
    const { sync } = makeSync(
      {},
      { readOfficeCodex: undefined, renewOfficeCodex: async () => {} },
    );
    const got = await sync.codexOfficeAuth()!.tokens();
    expect({
      got,
      leaked: JSON.stringify(got).includes("codex-office-refresh-SECRET"),
    }).toEqual({
      got: {
        accessToken: access,
        chatgptAccountId: "acct-office",
        chatgptPlanType: "plus",
      },
      leaked: false,
    });
  });
});

// The sign-in card (M): the member office folder is the office's scope, so
// the card offers the office sign-in there (to its owners) and the member's
// own sign-in in their personal home, never in that folder.
describe("the account scope of an isolated member's folders", () => {
  for (const provider of ["claude", "codex"] as const)
    it(`${provider}: the member office folder is the office scope, and her personal home the personal one`, () => {
      const manager = new ProviderAccountManager(() => {});
      const office = manager.effectiveTarget(iso.userId, provider);
      activatePersonalProvider(iso.userId, provider);
      const own = manager.effectiveTarget(iso.userId, provider);
      expect({ office, own }).toEqual({
        office: {
          provider,
          scope: "office",
          dir: provider === "claude" ? claudeFolder() : codexFolder(),
        },
        own: {
          provider,
          scope: "personal",
          dir: personalProviderHome(iso.userId, provider),
        },
      });
    });
});
