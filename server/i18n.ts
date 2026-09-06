// The server's one answer to "which language do I write this in?"
// (internal-docs/i18n-loop.md, ruling 8: the server resolves from the
// requesting user's stored preference and falls back to English; no second
// resolver).
//
// The UI's own resolution lives in ui/preference-form.ts and additionally
// consults the browser language. The server deliberately does NOT: a browser
// language is not something a request carries once the UI has committed it
// once at first sign-in, so a user with no stored preference reads English
// here.
//
// One policy function, `translatorForLanguage`, and two adapters for the two
// shapes an actor actually arrives in on this server:
//
//   - `translatorForUsername` - the chat path. A slash command typed in an
//     agent's chat carries its sender as a display NAME (agent-manager's
//     sendMessage -> handleSlashCommand), not a user id.
//   - `translatorForUserId` - the actorless fallback. A choice interaction
//     opened by a backend event, or a lifecycle entry written from a route,
//     has no actor in scope; the reader we do know is the agent's owner.
//
// There is no identity-shaped adapter because no S7 surface consumes an
// Identity: no route handler writes human-facing log prose (checked across
// server/isomux-office.ts and server/routes/handlers/). Adding one would be
// policy code with no caller.
//
// Agents never reach any of this. An agent's inter-agent message goes through
// enqueueMessage and is drained by flushQueue straight into the model, which
// has no slash-command interception - so no server-produced response text
// exists for an agent to receive in any language.

import {
  DEFAULT_LANGUAGE,
  type SupportedLanguageCode,
} from "../shared/languages.ts";
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
