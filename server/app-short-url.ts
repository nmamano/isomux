import type { AppRecord } from "../shared/types.ts";
import { RESERVED_APP_NAMES } from "./app-registry.ts";

// Both the response field and the redirect use this rule. The caller supplies
// a live registry record and the configured origin, never a request Host.
export function appShortUrl(
  app: Pick<AppRecord, "name"> | null,
  publicUrl: string | null,
  officeOrigin: string,
): string | null {
  if (!app || publicUrl === null || RESERVED_APP_NAMES.has(app.name))
    return null;
  return `${officeOrigin}/${app.name}`;
}
