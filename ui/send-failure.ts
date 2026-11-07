// The text a send failure shows (an Ask reply, a chat message, a run or app
// message): the catalog line for the Enterprise Contract lock (409
// enterprise_secret_needed), else the server's message.
import type { Translator } from "../shared/i18n/translate.ts";

// Where an office's IT asks about the Enterprise Contract.
export const ENTERPRISE_HELP_EMAIL = "llc@isomux.com";

export function isEnterpriseLocked(err: { code?: string }): boolean {
  return err.code === "enterprise_secret_needed";
}

export function sendFailureText(
  t: Translator["t"],
  err: { code?: string; message: string },
): string {
  return isEnterpriseLocked(err)
    ? t("enterprise.locked", { email: ENTERPRISE_HELP_EMAIL })
    : err.message;
}
