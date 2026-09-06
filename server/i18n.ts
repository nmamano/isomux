// The server's one answer to "which language do I write this in?"
// (internal-docs/i18n-loop.md, ruling 8: the server resolves from the
// requesting user's stored preference and falls back to English; no second
// resolver).
//
// The UI's own resolution lives in ui/preference-form.ts and additionally
// consults the browser language. For a reader the server can name it
// deliberately does NOT: a browser language is not something a request carries
// once the UI has committed it at first sign-in, so a user with no stored
// preference reads English here. The exception is a request that names nobody
// - the pre-sign-in pages of S9 - where Accept-Language is the only thing the
// visitor has said about what they read.
//
// One policy function, `translatorForLanguage`, and three adapters for the
// shapes an actor actually arrives in on this server:
//
//   - `translatorForUsername` - the chat path. A slash command typed in an
//     agent's chat carries its sender as a display NAME (agent-manager's
//     sendMessage -> handleSlashCommand), not a user id.
//   - `translatorForUserId` - the actorless fallback. A choice interaction
//     opened by a backend event, or a lifecycle entry written from a route,
//     has no actor in scope; the reader we do know is the agent's owner.
//   - `translatorForRequest` - the pre-sign-in pages (S9). The visitor may have
//     no identity at all, so a resolved identity (or null) and the request's
//     Accept-Language header decide together: a known reader's stored
//     preference first, the header only for a stranger.
//
// S7 had no identity-shaped adapter because no route handler writes
// human-facing log prose (checked across server/isomux-office.ts and
// server/routes/handlers/). S9's pre-sign-in pages are the first surface that
// serves a caller rather than logging about one, so translatorForRequest takes
// the Identity the gating layer already resolved.
//
// Agents read English wherever they do reach it. An agent's inter-agent message
// goes through enqueueMessage and is drained by flushQueue straight into the
// model, which has no slash-command interception - so no server-produced
// response text exists for an agent to receive in any language; and an agent
// bearer that fetches an invite page is a machine reader, which
// translatorForRequest answers in English by scope.

import {
  DEFAULT_LANGUAGE,
  languageFromAcceptLanguage,
  type SupportedLanguageCode,
} from "../shared/languages.ts";
import type { Identity } from "./identity/index.ts";
import { translatorFor, type Translator } from "../shared/i18n/translate.ts";
import { getUserById, getUserByName } from "./users.ts";

/**
 * The translator for a stored preference. `null` is "never chosen", which is
 * English - the same fallback an unknown user gets, so a caller never has to
 * distinguish the two.
 */
export function translatorForLanguage(
  language: SupportedLanguageCode | null | undefined,
): Translator {
  return translatorFor(language ?? DEFAULT_LANGUAGE);
}

/** English, for text no reader has been identified for. */
export const english: Translator = translatorForLanguage(DEFAULT_LANGUAGE);

/**
 * The translator for the human who typed a slash command. `username` is the
 * display name the chat path carries; an absent or unrecognized one is
 * English.
 */
export function translatorForUsername(username?: string | null): Translator {
  return translatorForLanguage(getUserByName(username)?.language);
}

/**
 * The translator for a user id - in practice an agent's owner, used where the
 * server writes human-facing text with no actor in scope. Only a USER record
 * resolves: an id that names anything else falls through to English.
 */
export function translatorForUserId(userId?: string | null): Translator {
  return translatorForLanguage(getUserById(userId)?.language);
}

/**
 * The translator for a request that may carry no identity at all - the
 * pre-sign-in pages (S9). The caller resolves the identity with the auth
 * helpers it already uses and passes it in, so authorization is interpreted in
 * exactly one place (server/auth-middleware.ts) and this stays policy over a
 * resolved actor.
 *
 * Precedence is ruling 8's: a reader we know reads their stored preference,
 * and only a request with no identity falls back to what the browser asked
 * for. A human whose preference is null therefore reads English even behind a
 * Spanish header - the preference is the answer, and "never chosen" is
 * English everywhere else on this server.
 */
export function translatorForRequest(
  identity: Identity | null,
  acceptLanguage: string | null | undefined,
): Translator {
  if (!identity) {
    return translatorForLanguage(languageFromAcceptLanguage(acceptLanguage));
  }
  // A human's two shapes: a browser session and that human's own API token.
  // Every other scope (agent, cron run, app) is a machine reader, and machines
  // read English (ruling 2), so an agent must never pick up its owner's
  // preference through the userId it carries.
  if (identity.scope === "user" || identity.scope === "api") {
    return translatorForUserId(identity.userId);
  }
  return english;
}
