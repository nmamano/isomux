import { describe, expect, it } from "bun:test";
import { demoAppMockContent } from "./demo-app.ts";

describe("demoAppMockContent", () => {
  it("carries each fixture's value size with its content", () => {
    expect(demoAppMockContent("cost-tracker").valueSize).toBe(24);
    expect(demoAppMockContent("standup-board").valueSize).toBe(13);
  });

  it("does not reflect an unknown name", () => {
    expect(demoAppMockContent("<script>alert(1)</script>")).toEqual({
      heading: "Demo app",
      valueSize: 13,
      tiles: [
        ["Preview", "Demo app"],
        ["Workspace", "Sample content"],
        ["Status", "Ready"],
      ],
    });
  });
});
