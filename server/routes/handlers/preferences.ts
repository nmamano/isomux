// Personal-preference handlers (opIds prefs.update, memberVoice.get,
// memberVoice.update). The write path for the settings that follow a member
// across devices: the reply language and the voice settings (what the mic and
// read aloud use).
//
// prefs.update is SELF-only by construction: the route table gates it with
// user:self + authenticated and the handler acts on the CALLER's own userId,
// never on a :username param. user:self is absent from both agent capability
// sets, so an agent token gets 403 there. The language stays the member's own.
//
// memberVoice.* is the voice part on the member's path (task 7a3b4114, Nil
// 2026-11-01: "make owners able to set Integrations for other users, including
// the voice selector"): the secrets gate, so the member or an office owner (and
// their API token or privileged agent) reads and sets it. Both writes go
// through one parser, so a bad body gets the same answer on either route.
//
// PATCH, not PUT: the body is a partial update whose absent fields are
// PRESERVED, which is exactly what PATCH means and what the neighbouring
// partial-update routes (users.update, agents.update) already use. The PUT
// routes in this table - view.setOrder, view.setNotifRooms - send a complete
// replacement list instead.
//
// Unlike view.*, an unrecognized value IS rejected (422) rather than silently
// clamped: the NO-ORACLE rule that shapes view.* is about not turning a write
// into a room-existence probe, and a language code reveals nothing about the
// office. A caller that mistypes a code - or a key - should hear about it
// rather than get a 204 that did nothing.
//
// LEAF over the executor + the injected PreferencesDeps. The handler never
// emits; the seam fans out the SCOPED full-record events (user_admin_updated +
// user_self_updated, via emitPrivateUserRecord) - not the public pair, since
// the preference does not appear in UserPublicWire.

import { noContent, fail, ok, type RouteHandler } from "../executor.ts";
import {
  PREFERENCE_KEYS,
  VOICE_PREFERENCE_KEYS,
  type MemberVoiceRes,
  type PreferencesReq,
} from "../../../shared/contract-shapes.ts";
import type { UserRecord } from "../../../shared/types.ts";
import { isSupportedLanguage } from "../../../shared/languages.ts";
import {
  DEFAULT_VOICE_NAME,
  isVoiceInput,
  isVoiceName,
  isVoiceOutput,
  type VoiceStatusRes,
} from "../../../shared/voice.ts";
import { memberSubject } from "./member-subject.ts";
import type { GuardDeps } from "../../identity/guards.ts";

export interface PreferencesDeps {
  // Persists + fans out. Returns false only if the user record vanished
  // (rendered as 404 here).
  applyPreferences(userId: string, change: PreferencesReq): boolean;
  userIdForUsername: GuardDeps["userIdForUsername"];
  userById(
    userId: string,
  ): Pick<UserRecord, "voiceInput" | "voiceOutput" | "voiceName"> | null;
  // Where the member's OpenAI voice key comes from (server/voice-key.ts).
  keyStatus(userId: string): VoiceStatusRes;
}

// A preferences change, checked, or why it is refused.
export type ParsedPreferences =
  | { ok: true; change: PreferencesReq }
  | { ok: false; code: string; message: string };

// The one parser for both writes and the member-preferences ask
// (server/step-asks.ts): `keys` is what the caller accepts.
export function parsePreferenceChange(
  raw: unknown,
  keys: readonly string[],
): ParsedPreferences {
  const refuse = (code: string, message: string): ParsedPreferences => ({
    ok: false,
    code,
    message,
  });
  // Shape check FIRST. `7`, `"x"` and `true` are all legal JSON bodies, and
  // the `in` operator throws on a primitive right-hand side - a 500 where a
  // 422 belongs. An array is an object but never a valid update.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("invalid_request", "body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const present = Object.keys(body);
  // An unknown key is almost always a typo (`langauge`), and silently
  // 204-ing a write that changed nothing is the worst possible answer.
  const unknown = present.filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    return refuse(
      "invalid_request",
      `unknown preference: ${unknown.join(", ")}`,
    );
  }
  if (present.length === 0) {
    return refuse("invalid_request", "no preferences to update");
  }
  const change: PreferencesReq = {};
  if ("language" in body) {
    const value = body.language;
    if (value !== null && !isSupportedLanguage(value)) {
      return refuse(
        "invalid_language",
        "language must be a supported language code or null",
      );
    }
    change.language = value;
  }
  if ("voiceInput" in body) {
    if (!isVoiceInput(body.voiceInput)) {
      return refuse(
        "invalid_voice_input",
        "voiceInput must be browser or openai",
      );
    }
    change.voiceInput = body.voiceInput;
  }
  if ("voiceOutput" in body) {
    if (!isVoiceOutput(body.voiceOutput)) {
      return refuse(
        "invalid_voice_output",
        "voiceOutput must be browser or openai",
      );
    }
    change.voiceOutput = body.voiceOutput;
  }
  if ("voiceName" in body) {
    if (!isVoiceName(body.voiceName)) {
      return refuse("invalid_voice_name", "voiceName must be an OpenAI voice");
    }
    change.voiceName = body.voiceName;
  }
  return { ok: true, change };
}

export function preferencesHandlers(
  deps: PreferencesDeps,
): Record<string, RouteHandler> {
  const subject = memberSubject(deps.userIdForUsername);
  return {
    "prefs.update": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "preferences are per-user");
      const parsed = parsePreferenceChange(ctx.body ?? {}, PREFERENCE_KEYS);
      if (!parsed.ok) return fail(422, parsed.code, parsed.message);
      if (!deps.applyPreferences(userId, parsed.change)) {
        return fail(404, "user_not_found");
      }
      return noContent();
    },

    "memberVoice.get": (ctx) => {
      const member = subject(ctx);
      const user = member && deps.userById(member.userId);
      if (!member || !user) return fail(404, "not_found");
      const res: MemberVoiceRes = {
        voiceInput: user.voiceInput ?? "browser",
        voiceOutput: user.voiceOutput ?? "browser",
        voiceName: user.voiceName ?? DEFAULT_VOICE_NAME,
        ...deps.keyStatus(member.userId),
      };
      return ok(res);
    },

    "memberVoice.update": (ctx) => {
      const member = subject(ctx);
      if (!member) return fail(404, "not_found");
      const parsed = parsePreferenceChange(
        ctx.body ?? {},
        VOICE_PREFERENCE_KEYS,
      );
      if (!parsed.ok) return fail(422, parsed.code, parsed.message);
      if (!deps.applyPreferences(member.userId, parsed.change)) {
        return fail(404, "not_found");
      }
      return noContent();
    },
  };
}
