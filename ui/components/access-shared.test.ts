// Pure coverage for session expiry copy and formatting. The UI has no DOM
// harness, so SessionsTable delegates the two secondary lines to this helper.

import { describe, expect, it } from "bun:test";
import { sessionExpiryLines } from "./access-shared.tsx";

describe("sessionExpiryLines", () => {
  it("shows both session deadlines with the approved provisional labels", () => {
    expect(
      sessionExpiryLines({
        expiresAt: new Date(2026, 0, 2, 15, 4).getTime(),
        absoluteExpiresAt: new Date(2027, 10, 12, 8, 9).getTime(),
      }),
    ).toEqual([
      {
        label: "Expires after inactivity",
        value: "2026-01-02 15:04 local",
      },
      {
        label: "Expires at the latest",
        value: "2027-11-12 08:09 local",
      },
    ]);
  });
});
