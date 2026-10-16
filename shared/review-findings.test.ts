import { describe, expect, it } from "bun:test";
import { parseReviewFindings } from "./review-findings.ts";
import { CODE_REVIEW_ENTRY_CONTENT } from "./review-findings.fixture.ts";

const fence = (value: unknown) =>
  "```json\n" + JSON.stringify(value, null, 2) + "\n```";

describe("parseReviewFindings", () => {
  it("reads the real /code-review output", () => {
    const findings = parseReviewFindings(CODE_REVIEW_ENTRY_CONTENT);
    expect(findings?.length).toBe(2);
    const [first] = findings!;
    expect(first.file).toBe("stats.py");
    expect(first.line).toBe(4);
    expect(first.summary).toContain("index 1");
    expect(first.failureScenario).toContain("average([10, 20, 30])");
    expect(first.extras).toEqual([]);
  });

  it("reads verdict, category and outcome", () => {
    const [finding] = parseReviewFindings(
      fence([
        {
          file: "a.ts",
          line: 3,
          summary: "s",
          failure_scenario: "f",
          verdict: "CONFIRMED",
          category: "correctness",
          outcome: "fixed",
        },
      ]),
    )!;
    expect(finding.verdict).toBe("CONFIRMED");
    expect(finding.category).toBe("correctness");
    expect(finding.outcome).toBe("fixed");
    expect(finding.extras).toEqual([]);
  });

  it("keeps an unknown field, and a known one of another type, as text", () => {
    const [finding] = parseReviewFindings(
      fence([
        {
          file: "a.ts",
          summary: "s",
          severity: "high",
          refs: [1, 2],
          verdict: { level: 1 },
        },
      ]),
    )!;
    expect(finding.extras).toEqual([
      ["severity", "high"],
      ["refs", "[1,2]"],
      ["verdict", '{"level":1}'],
    ]);
    expect(finding.verdict).toBeUndefined();
  });

  it("keeps a line with no file as a field", () => {
    const [finding] = parseReviewFindings(fence([{ line: 7, summary: "s" }]))!;
    expect(finding.line).toBeUndefined();
    expect(finding.extras).toEqual([["line", "7"]]);
  });

  it("keeps both short_summary and summary", () => {
    const [withBoth, onlyShort] = parseReviewFindings(
      fence([
        { summary: "long", short_summary: "short" },
        { short_summary: "short" },
      ]),
    )!;
    expect(withBoth.summary).toBe("long");
    expect(withBoth.shortSummary).toBe("short");
    expect(withBoth.extras).toEqual([]);
    expect(onlyShort.shortSummary).toBe("short");
    expect(onlyShort.summary).toBeUndefined();
  });

  it("reads an empty array as zero findings", () => {
    expect(parseReviewFindings(fence([]))).toEqual([]);
  });

  it("returns null for content that is not a findings fence", () => {
    for (const content of [
      "Review done.",
      fence({ summary: "an object, not an array" }),
      fence([{ file: "a.ts" }]),
      fence(["text"]),
      fence([{ summary: "s" }, { file: "a.ts" }]),
      fence([{ summary: "s" }, "text"]),
      fence([{ summary: "s" }, null]),
      fence([{ summary: "s" }]) + "\nDone.",
      '```json\n[{"summary": \n```',
      "Findings:\n" + fence([{ summary: "s" }]),
      "```ts\n[]\n```",
    ]) {
      expect(parseReviewFindings(content)).toBeNull();
    }
  });
});
