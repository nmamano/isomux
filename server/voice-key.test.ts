// voiceKeyForUserId (task 4481e64b): voice spends OPENAI_VOICE_API_KEY, and
// OPENAI_API_KEY only when no voice key is set (Nil, 2026-10-21: an
// OPENAI_API_KEY moves a ChatGPT subscriber's Codex to API billing). Each name
// resolves layer by layer like the agents' env, and never to a secret's
// placeholder.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { dirname } from "path";
import {
  buildEnvForUserId,
  setOfficeEnvFileProvider,
  setSecretEnvironmentProvider,
} from "./env-loader.ts";
import { claimUser } from "./users.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";
import { voiceKeyForUserId } from "./voice-key.ts";

const KEY = "OPENAI_API_KEY";
const VOICE = "OPENAI_VOICE_API_KEY";

const priorProcessKey = process.env[KEY];
const priorProcessVoiceKey = process.env[VOICE];
let restoreSecrets: Parameters<typeof setSecretEnvironmentProvider>[0];
beforeEach(() => {
  restoreSecrets = setSecretEnvironmentProvider(() => null);
  delete process.env[VOICE];
});
afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  setSecretEnvironmentProvider(restoreSecrets);
  if (priorProcessKey === undefined) delete process.env[KEY];
  else process.env[KEY] = priorProcessKey;
  if (priorProcessVoiceKey === undefined) delete process.env[VOICE];
  else process.env[VOICE] = priorProcessVoiceKey;
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath("any")), { recursive: true, force: true });
});

const secrets = (
  office: Record<string, string>,
  member: Record<string, Record<string, string>>,
) =>
  setSecretEnvironmentProvider((userId) => ({
    office,
    member: (userId && member[userId]) || {},
    fixed: {},
    gitCredentials: [],
    revision: "test",
  }));

describe("voiceKeyForUserId", () => {
  it("takes each layer's value in the agents' merge order", () => {
    const user = claimUser("Voice Key User");
    const other = claimUser("Voice Key Other");
    delete process.env[KEY];
    delete process.env[VOICE];
    expect(voiceKeyForUserId(user.id)).toBeNull();

    process.env[KEY] = "sk-server";
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "server",
      key: "sk-server",
    });

    writeManagedOfficeEnv({ [KEY]: "sk-office" });
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "office_variable",
      key: "sk-office",
    });

    writeManagedUserEnv(user.id, { [KEY]: "sk-member" });
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "member_variable",
      key: "sk-member",
    });
    // The member layer is that member's own; another member and an unowned
    // caller get the office layer.
    expect(voiceKeyForUserId(other.id)).toEqual({
      name: KEY,
      source: "office_variable",
      key: "sk-office",
    });
    expect(voiceKeyForUserId(null)).toEqual({
      name: KEY,
      source: "office_variable",
      key: "sk-office",
    });
  });

  // The env holds the secret proxy's placeholder there, which OpenAI would
  // refuse; the source still reaches the Voice tab.
  it("names a secret source but gives no value for it", () => {
    const user = claimUser("Voice Key Secret User");
    writeManagedOfficeEnv({ [KEY]: "sk-office" });
    writeManagedUserEnv(user.id, { [KEY]: "sk-member" });
    secrets({}, { [user.id]: { [KEY]: "placeholder-member" } });
    // Enabling condition: the agents' merge really holds the secret's value.
    expect(buildEnvForUserId(user.id)?.[KEY]).toBe("placeholder-member");
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "member_secret",
      key: null,
    });

    setSecretEnvironmentProvider(() => null);
    writeManagedUserEnv(user.id, {});
    secrets({ [KEY]: "placeholder-office" }, {});
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "office_secret",
      key: null,
    });
  });

  it("says no key when a member variable empties the office one", () => {
    const user = claimUser("Voice Key Empty User");
    process.env[KEY] = "sk-server";
    writeManagedOfficeEnv({ [KEY]: "sk-office" });
    writeManagedUserEnv(user.id, { [KEY]: "" });
    // Enabling condition: the agents get the empty value, not the office one.
    expect(buildEnvForUserId(user.id)?.[KEY]).toBe("");
    expect(voiceKeyForUserId(user.id)).toBeNull();
    expect(voiceKeyForUserId(null)?.key).toBe("sk-office");
  });

  it("prefers OPENAI_VOICE_API_KEY from any layer over an OPENAI_API_KEY", () => {
    const user = claimUser("Voice Key Name User");
    delete process.env[VOICE];
    writeManagedUserEnv(user.id, { [KEY]: "sk-member-codex" });
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "member_variable",
      key: "sk-member-codex",
    });

    // An office voice key beats the member's own OPENAI_API_KEY.
    writeManagedOfficeEnv({ [VOICE]: "sk-office-voice" });
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: VOICE,
      source: "office_variable",
      key: "sk-office-voice",
    });

    // The member's voice key beats the office's.
    writeManagedUserEnv(user.id, {
      [KEY]: "sk-member-codex",
      [VOICE]: "sk-member-voice",
    });
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: VOICE,
      source: "member_variable",
      key: "sk-member-voice",
    });

    // The server's own env counts for the voice name too.
    writeManagedOfficeEnv({});
    writeManagedUserEnv(user.id, {});
    process.env[VOICE] = "sk-server-voice";
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: VOICE,
      source: "server",
      key: "sk-server-voice",
    });
  });

  it("falls back to OPENAI_API_KEY when the member empties the voice key", () => {
    const user = claimUser("Voice Key Fallback User");
    delete process.env[VOICE];
    writeManagedOfficeEnv({ [VOICE]: "sk-office-voice", [KEY]: "sk-office" });
    writeManagedUserEnv(user.id, { [VOICE]: "" });
    // Enabling condition: the agents get the empty voice key.
    expect(buildEnvForUserId(user.id)?.[VOICE]).toBe("");
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: KEY,
      source: "office_variable",
      key: "sk-office",
    });
  });

  // Predictable: the name that is set decides, even when its value is a
  // secret the server cannot use.
  it("a secret voice key gives no value and no fallback", () => {
    const user = claimUser("Voice Key Secret Name User");
    delete process.env[VOICE];
    writeManagedOfficeEnv({ [KEY]: "sk-office" });
    secrets({}, { [user.id]: { [VOICE]: "placeholder-voice" } });
    expect(buildEnvForUserId(user.id)?.[VOICE]).toBe("placeholder-voice");
    expect(voiceKeyForUserId(user.id)).toEqual({
      name: VOICE,
      source: "member_secret",
      key: null,
    });
  });
});
