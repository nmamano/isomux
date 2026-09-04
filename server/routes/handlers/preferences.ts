// Personal-preference handler (opId prefs.update). The
// self-scoped write path for the settings that follow a boss across devices:
// reply language.
//
// SELF-only by construction: the route table gates it with user:self +
// authenticated and the handler acts on the CALLER's own userId, never on a
// :username param. That mirrors the view.* surface and respects the
// split in users.ts - an owner sets a member's ACCESS, never their personal
// settings. user:self is absent from both agent capability sets, so an agent
// token gets 403 here, matching what the agent system prompt already promises.
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
// neither preference appears in UserPublicWire.

import { noContent, fail, type RouteHandler } from "../executor.ts";
import {
  PREFERENCE_KEYS,
  type PreferencesReq,
} from "../../../shared/contract-shapes.ts";
import { isSupportedLanguage } from "../../../shared/languages.ts";

export interface PreferencesDeps {
  // Persists + fans out. Returns false only if the user record vanished
  // (rendered as 404 here).
  applyPreferences(userId: string, change: PreferencesReq): boolean;
}

export function preferencesHandlers(
  deps: PreferencesDeps,
): Record<string, RouteHandler> {
  return {
    "prefs.update": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "preferences are per-user");
      // Shape check FIRST. `7`, `"x"` and `true` are all legal JSON bodies, and
      // the `in` operator throws on a primitive right-hand side - a 500 where a
      // 422 belongs. An array is an object but never a valid update.
      const raw = ctx.body ?? {};
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return fail(422, "invalid_request", "body must be an object");
      }
      const body = raw as Record<string, unknown>;
      const keys = Object.keys(body);
      // An unknown key is almost always a typo (`langauge`), and silently
      // 204-ing a write that changed nothing is the worst possible answer.
      const unknown = keys.filter(
        (k) => !(PREFERENCE_KEYS as readonly string[]).includes(k),
      );
      if (unknown.length > 0) {
        return fail(
          422,
          "invalid_request",
          `unknown preference: ${unknown.join(", ")}`,
        );
      }
      if (keys.length === 0) {
        return fail(422, "invalid_request", "no preferences to update");
      }
      const change: PreferencesReq = {};
      if ("language" in body) {
        const value = body.language;
        if (value !== null && !isSupportedLanguage(value)) {
          return fail(
            422,
            "invalid_language",
            "language must be a supported language code or null",
          );
        }
        change.language = value;
      }
      if (!deps.applyPreferences(userId, change)) {
        return fail(404, "user_not_found");
      }
      return noContent();
    },
  };
}
