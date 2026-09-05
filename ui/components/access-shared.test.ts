// Pure coverage for session expiry copy and formatting. The UI has no DOM
// harness, so SessionsTable delegates the two secondary lines to this helper.
//
// The labels and the "local" word come from the catalog and the stamp from
// Intl (shared/i18n/time.ts), so the expectations are written out literally
// rather than read back through the translator - an oracle that repeats the
// implementation approves any wrong answer (internal-docs/i18n-loop.md,
// ruling 14). The dates are built from local components and read back in the
// local zone, so this holds wherever the machine is.

import { describe, expect, it } from "bun:test";
import { sessionExpiryLines } from "./access-shared.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";

const SESSION = {
  expiresAt: new Date(2026, 0, 2, 15, 4).getTime(),
  absoluteExpiresAt: new Date(2027, 10, 12, 8, 9).getTime(),
};

describe("sessionExpiryLines", () => {
  it("shows both session deadlines with the approved provisional labels", () => {
    expect(sessionExpiryLines(translatorFor("en"), SESSION)).toEqual([
      {
        label: "Expires after inactivity",
        value: "1/2/26, 3:04 PM local",
      },
      {
        label: "Expires at the latest",
        value: "11/12/27, 8:09 AM local",
      },
    ]);
  });

  it("reads the labels and the stamp in the reader's language", () => {
    expect(sessionExpiryLines(translatorFor("ca"), SESSION)).toEqual([
      { label: "Caduca per inactivitat", value: "2/1/26 15:04 local" },
      { label: "Caduca com a molt tard", value: "12/11/27 8:09 local" },
    ]);
  });
});
