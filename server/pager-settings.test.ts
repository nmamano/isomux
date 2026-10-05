// Pager settings: the Discord-only URL check, the mask, PATCH validation, and
// the file store (mode 0600, defaults, load posture).

import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createPagerSettingsFilePersistence,
  createPagerSettingsStore,
  maskWebhookUrl,
  parseDiscordWebhookUrl,
  parsePagerSettingsPatch,
  PagerSettingsUnavailableError,
  PAGER_DEFAULT_REPEAT_MINUTES,
  PAGER_REPEAT_MINUTES_MAX,
  toPagerSettingsRes,
} from "./pager-settings.ts";

const TOKEN = "AbC-dEf_ghIJ1234";
const GOOD = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

describe("parseDiscordWebhookUrl", () => {
  it("accepts Discord webhook URLs on both hosts", () => {
    expect(parseDiscordWebhookUrl(GOOD)).toBe(GOOD);
    expect(parseDiscordWebhookUrl(`  ${GOOD}  `)).toBe(GOOD);
    const legacy = GOOD.replace("discord.com", "discordapp.com");
    expect(parseDiscordWebhookUrl(legacy)).toBe(legacy);
  });

  for (const bad of [
    GOOD.replace("https:", "http:"),
    GOOD.replace("discord.com", "evil.com"),
    GOOD.replace("discord.com", "discord.com.evil.com"),
    GOOD.replace("discord.com", "ptb.discord.com"),
    GOOD.replace("discord.com", "discord.com:8443"),
    GOOD.replace("https://", "https://user:pw@"),
    `${GOOD}?wait=true`,
    `${GOOD}#x`,
    "https://discord.com/api/webhooks/abc/token",
    "https://discord.com/api/webhooks/123",
    "https://discord.com/api/webhooks/123/tok/extra",
    "https://discord.com/channels/123/456",
    "https://discord.com/api/webhooks/123/../../users/@me",
    "not a url",
    "",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(parseDiscordWebhookUrl(bad)).toBeNull();
    });
  }
});

describe("maskWebhookUrl", () => {
  it("keeps the host and the last four characters of the token only", () => {
    const masked = maskWebhookUrl(GOOD);
    expect(masked.startsWith("https://discord.com/")).toBe(true);
    expect(masked.endsWith(TOKEN.slice(-4))).toBe(true);
    expect(masked).not.toContain(TOKEN.slice(0, -4));
    expect(masked).not.toContain("123456789012345678");
  });
});

describe("parsePagerSettingsPatch", () => {
  it("accepts each field, null clears, and an empty string clears", () => {
    expect(
      parsePagerSettingsPatch({
        webhookUrl: GOOD,
        discordUserId: " 112233445566778899 ",
        repeatMinutes: 15,
      }),
    ).toEqual({
      ok: true,
      patch: {
        webhookUrl: GOOD,
        discordUserId: "112233445566778899",
        repeatMinutes: 15,
      },
    });
    expect(
      parsePagerSettingsPatch({
        webhookUrl: null,
        discordUserId: "",
        repeatMinutes: null,
      }),
    ).toEqual({
      ok: true,
      patch: { webhookUrl: null, discordUserId: null, repeatMinutes: null },
    });
  });

  for (const [label, body] of [
    ["an array", []],
    ["a primitive", 7],
    ["an empty object", {}],
    ["an unknown key", { webhook: GOOD }],
    ["a non-Discord URL", { webhookUrl: "https://example.com/hook" }],
    ["a non-string URL", { webhookUrl: 5 }],
    ["a user ID with letters", { discordUserId: "abc123456789012345" }],
    ["a short user ID", { discordUserId: "1234" }],
    ["a zero interval", { repeatMinutes: 0 }],
    ["a fractional interval", { repeatMinutes: 1.5 }],
    [
      "an interval over the bound",
      { repeatMinutes: PAGER_REPEAT_MINUTES_MAX + 1 },
    ],
    ["a string interval", { repeatMinutes: "5" }],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(parsePagerSettingsPatch(body).ok).toBe(false);
    });
  }
});

describe("pager settings store", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = null;
  });
  const tmp = () => (dir = mkdtempSync(join(tmpdir(), "pager-settings-")));

  it("defaults to no webhook and the default interval", () => {
    const path = join(tmp(), "pager-settings.json");
    const store = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    expect(store.get("u1")).toEqual({
      repeatMinutes: PAGER_DEFAULT_REPEAT_MINUTES,
    });
    expect(toPagerSettingsRes(store.get("u1"))).toEqual({
      webhookUrlMasked: null,
      discordUserId: null,
      repeatMinutes: PAGER_DEFAULT_REPEAT_MINUTES,
    });
    expect(existsSync(path)).toBe(false);
  });

  it("saves to a 0600 file, keeps absent fields, and reloads", () => {
    const path = join(tmp(), "pager-settings.json");
    const p = createPagerSettingsFilePersistence(path);
    const store = createPagerSettingsStore(p);
    store.update("u1", {
      webhookUrl: GOOD,
      discordUserId: "112233445566778899",
    });
    store.update("u1", { repeatMinutes: null });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    expect(again.get("u1")).toEqual({
      webhookUrl: GOOD,
      discordUserId: "112233445566778899",
      repeatMinutes: null,
    });
    again.update("u1", { webhookUrl: null });
    expect(again.get("u1").webhookUrl).toBeUndefined();
    expect(again.get("u2").webhookUrl).toBeUndefined();
  });

  it("keeps the 429 hold across a member's save and a reload, and off the wire", () => {
    const path = join(tmp(), "pager-settings.json");
    const store = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    store.update("u1", { webhookUrl: GOOD });
    store.setHoldUntil("u1", 12345);
    store.update("u1", { repeatMinutes: 15 });
    const again = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    expect(again.get("u1").holdUntil).toBe(12345);
    expect(Object.keys(toPagerSettingsRes(again.get("u1"))).sort()).toEqual([
      "discordUserId",
      "repeatMinutes",
      "webhookUrlMasked",
    ]);
    expect(parsePagerSettingsPatch({ holdUntil: 0 }).ok).toBe(false);
  });

  it("moves a corrupt file aside and starts empty", () => {
    const d = tmp();
    const path = join(d, "pager-settings.json");
    writeFileSync(path, "{nope");
    const store = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    expect(store.get("u1").webhookUrl).toBeUndefined();
    expect(readdirSync(d).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("an unreadable file makes the store refuse, never read as empty", () => {
    const d = tmp();
    const path = join(d, "pager-settings.json");
    writeFileSync(path, JSON.stringify({ u1: { repeatMinutes: 5 } }));
    chmodSync(path, 0o000);
    if (process.getuid?.() === 0) return; // root reads anything
    const store = createPagerSettingsStore(
      createPagerSettingsFilePersistence(path),
    );
    expect(() => store.get("u1")).toThrow(PagerSettingsUnavailableError);
    expect(() => store.update("u1", { repeatMinutes: 1 })).toThrow(
      PagerSettingsUnavailableError,
    );
    chmodSync(path, 0o600);
  });
});
