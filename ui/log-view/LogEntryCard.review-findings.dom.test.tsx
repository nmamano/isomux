import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { CODE_REVIEW_ENTRY_CONTENT } from "../../shared/review-findings.fixture.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

function renderSystem(content: string) {
  return render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "review",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content,
        }}
      />,
    ),
  );
}

it("renders the real /code-review output as one row per finding", () => {
  const view = renderSystem(CODE_REVIEW_ENTRY_CONTENT);
  const rows = view.container.querySelectorAll("[data-review-finding]");
  expect(rows.length).toBe(2);
  const locations = [
    ...view.container.querySelectorAll("[data-finding-location]"),
  ].map((node) => node.textContent);
  expect(locations).toEqual(["stats.py:4", "stats.py:4"]);
  expect(rows[0].textContent).toContain("average([10, 20, 30])");
  // The JSON is not shown as a code block.
  expect(view.container.querySelectorAll("pre").length).toBe(0);
  expect(view.container.textContent?.includes('"failure_scenario"')).toBe(
    false,
  );
  view.unmount();
});

it("shows verdict and unknown fields as text", () => {
  const content =
    "```json\n" +
    JSON.stringify([
      {
        file: "a.ts",
        line: 3,
        summary: "s",
        verdict: "CONFIRMED",
        severity: "high",
      },
    ]) +
    "\n```";
  const view = renderSystem(content);
  expect(
    view.container
      .querySelector("[data-finding-badge]")
      ?.getAttribute("data-finding-badge"),
  ).toBe("CONFIRMED");
  const extra = view.container.querySelector('[data-finding-extra="severity"]');
  expect(extra?.textContent?.includes("high")).toBe(true);
  view.unmount();
});

it("keeps other system entries on the plain path", () => {
  const view = renderSystem('```json\n{"not": "findings"}\n```');
  expect(view.container.querySelectorAll("[data-review-finding]").length).toBe(
    0,
  );
  expect(view.container.querySelectorAll("pre").length).toBe(1);
  view.unmount();
});

it("renders an empty findings array as a line, not as JSON", () => {
  const view = renderSystem("```json\n[]\n```");
  expect(view.container.querySelectorAll("pre").length).toBe(0);
  expect(view.container.textContent?.includes("[]")).toBe(false);
  expect((view.container.textContent ?? "").trim().length > 0).toBe(true);
  view.unmount();
});

it("shows short_summary as the headline and summary under it", () => {
  const content =
    "```json\n" +
    JSON.stringify([
      {
        file: "a.ts",
        summary: "the long summary",
        short_summary: "short label",
        verdict: "PLAUSIBLE",
        category: "PLAUSIBLE",
      },
    ]) +
    "\n```";
  const view = renderSystem(content);
  const text = (selector: string) =>
    view.container.querySelector(selector)?.textContent?.trim();
  expect(text("[data-finding-headline]")).toBe("short label");
  expect(text("[data-finding-detail]")).toBe("the long summary");
  expect(view.container.querySelectorAll("[data-finding-badge]").length).toBe(
    2,
  );
  view.unmount();
});
