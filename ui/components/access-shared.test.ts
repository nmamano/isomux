// Pure coverage for session expiry copy and formatting. The UI has no DOM
// harness, so SessionsTable delegates the two secondary lines to this helper.
//
// The labels and the "local" word come from the catalog and the stamp from
// Intl (shared/i18n/time.ts). The dates are built from local components and
// read back in the local zone, so this holds wherever the machine is.

import { describe, expect, it } from "bun:test";
import { sessionExpiryLines } from "./access-shared.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { absoluteTime } from "../../shared/i18n/time.ts";

const SESSION = {
  expiresAt: new Date(2026, 0, 2, 15, 4).getTime(),
  absoluteExpiresAt: new Date(2027, 10, 12, 8, 9).getTime(),
};

describe("sessionExpiryLines", () => {
  it("shows both session deadlines with the approved provisional labels", () => {
    const en = translatorFor("en");
    expect(sessionExpiryLines(en, SESSION)).toEqual([
      {
        label: en.t("settings.sessions.expiryInactivity"),
        value: en.t("settings.access.localTime", {
          time: absoluteTime("en", SESSION.expiresAt),
        }),
      },
      {
        label: en.t("settings.sessions.expiryLatest"),
        value: en.t("settings.access.localTime", {
          time: absoluteTime("en", SESSION.absoluteExpiresAt),
        }),
      },
    ]);
  });

  it("reads the labels and the stamp in the reader's language", () => {
    const ca = translatorFor("ca");
    expect(sessionExpiryLines(ca, SESSION)).toEqual([
      {
        label: ca.t("settings.sessions.expiryInactivity"),
        value: ca.t("settings.access.localTime", {
          time: absoluteTime("ca", SESSION.expiresAt),
        }),
      },
      {
        label: ca.t("settings.sessions.expiryLatest"),
        value: ca.t("settings.access.localTime", {
          time: absoluteTime("ca", SESSION.absoluteExpiresAt),
        }),
      },
    ]);
  });
});
