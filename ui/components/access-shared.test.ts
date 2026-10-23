// The two secondary lines SessionsTable shows under a session: each label
// with its own deadline, read in the reader's language. No DOM test seeds a
// session, so this helper is where that pairing is checked.
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
