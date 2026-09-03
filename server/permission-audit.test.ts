import { describe, expect, it } from "bun:test";

import { permissionInputSummary } from "./permission-audit.ts";

describe("permission audit input summaries", () => {
  it("keeps only supported fields and redacts common credential shapes", () => {
    expect(
      permissionInputSummary("Bash", {
        command:
          "API_TOKEN=top-secret curl -H 'Authorization: Bearer bearer-secret' 'https://example.com/?api_key=query-secret'",
        description: "must not persist",
      }),
    ).toEqual({
      command:
        "API_TOKEN=[REDACTED] curl -H 'Authorization: Bearer [REDACTED]' 'https://example.com/?api_key=[REDACTED]'",
    });
    expect(
      permissionInputSummary("Write", {
        file_path: "/tmp/out.txt",
        content: "secret file body",
      }),
    ).toEqual({ file_path: "/tmp/out.txt" });
    expect(
      permissionInputSummary("future_tool", { token: "do-not-store" }),
    ).toEqual({});
  });

  it("caps persisted values", () => {
    const summary = permissionInputSummary("Bash", {
      command: "x".repeat(500),
    });
    expect(summary.command).toHaveLength(240);
    expect(summary.command?.endsWith("…")).toBe(true);
  });
});
