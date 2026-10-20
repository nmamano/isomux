// An Error whose text is Isomux's own words (task c37a7365). `message` is the
// English, for logs, agents and code that reads a string; `logMessage` is the
// same text as a message, so a catch that writes it to a chat log stores
// what each reader words in their language. A catch that logs String(err) or
// err.message alone would show English to every reader: use errorText.

import { errMessage } from "../shared/errors.ts";
import { renderLogText, type LogMessage } from "../shared/i18n/log-message.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

export class LocalizedError extends Error {
  readonly logMessage: LogMessage;
  constructor(message: LogMessage, options?: ErrorOptions) {
    super(renderLogText(translatorFor("en"), message), options);
    this.name = "LocalizedError";
    this.logMessage = message;
  }
}

/** What a log line shows for `err`: its message when it has one, else its text. */
export function errorText(err: unknown): LogMessage | string {
  return err instanceof LocalizedError ? err.logMessage : errMessage(err);
}
