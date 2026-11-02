import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AGENT_REFERENCE_SUBPAGES,
  AGENT_REFERENCE_TOPICS,
  type AgentReferenceTopic,
  agentReferenceContent,
  compactReferenceTables,
} from "./agent-reference.ts";
import {
  AGENT_CAPABILITIES,
  API_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  type Identity,
} from "./identity/index.ts";

const agent = (capabilities: Identity["capabilities"]): Identity => ({
  scope: "agent",
  agentId: "a1",
  userId: "u1",
  role: "member",
  capabilities,
});
const ordinary = agent(AGENT_CAPABILITIES);
const privileged = agent(PRIVILEGED_AGENT_CAPABILITIES);
const api: Identity = {
  scope: "api",
  userId: "u1",
  role: "member",
  apiTokenId: "t1",
  capabilities: API_CAPABILITIES,
};
const topics = Object.keys(AGENT_REFERENCE_TOPICS) as AgentReferenceTopic[];

// Task 215ae677 (Nil, 2026-11-02): an agent pays for every byte of a page it
// fetches. Prettier pads route tables to align their columns; the server
// serves them without that padding, and leaves every cell's text as written.
describe("compactReferenceTables", () => {
  it("drops column padding and separator dash runs", () => {
    const padded = [
      "| Route            | Body   | Returns |",
      "| ---------------- | :----- | ------: |",
      "| `GET /api/x`     | none   | `200`   |",
      "",
    ].join("\n");
    expect(compactReferenceTables(padded)).toBe(
      [
        "| Route | Body | Returns |",
        "| --- | :--- | ---: |",
        "| `GET /api/x` | none | `200` |",
        "",
      ].join("\n"),
    );
  });

  it("keeps cell text, escaped pipes, prose and fenced blocks byte for byte", () => {
    const md = [
      "Prose  with   runs | and a pipe ---- here.",
      "",
      "| Route         | Body                 |",
      "| ------------- | -------------------- |",
      "| `POST  /x`    | `{text\\|prompt}`     |",
      "| a  \\| b       | x ---- y             |",
      "",
      "```text",
      "| kept     | as   |",
      "| -------- | ---- |",
      "```",
    ].join("\n");
    expect(compactReferenceTables(md)).toBe(
      [
        "Prose  with   runs | and a pipe ---- here.",
        "",
        "| Route | Body |",
        "| --- | --- |",
        "| `POST  /x` | `{text\\|prompt}` |",
        "| a  \\| b | x ---- y |",
        "",
        "```text",
        "| kept     | as   |",
        "| -------- | ---- |",
        "```",
      ].join("\n"),
    );
  });
});

describe("served reference pages", () => {
  it("serves each page as its file with compact tables", () => {
    const mismatched = topics.filter(
      (topic) =>
        agentReferenceContent(privileged, topic) !==
        compactReferenceTables(
          readFileSync(
            join(import.meta.dir, "agent-reference", `${topic}.md`),
            "utf8",
          ),
        ),
    );
    expect(mismatched).toEqual([]);
  });

  // Task 215ae677: a page that grows past the cap is cut first, then split
  // into a sub-page. Raising the cap needs Nil.
  it("keeps every page at most 8 KB as an agent receives it", () => {
    const over = topics
      .map((topic) => ({
        topic,
        bytes: Buffer.byteLength(
          agentReferenceContent(privileged, topic) ?? "",
        ),
      }))
      .filter((page) => page.bytes > 8_192);
    expect(over).toEqual([]);
  });
});

// A sub-page holds part of a parent page. The index lists it, the parent names
// it, and every reader of the parent can read it.
describe("reference sub-pages", () => {
  const subpages = Object.entries(AGENT_REFERENCE_SUBPAGES) as [
    AgentReferenceTopic,
    AgentReferenceTopic,
  ][];

  it("has sub-pages", () => {
    expect(subpages.length).toBeGreaterThan(0);
  });

  it("names each sub-page in a top-level parent that every reader shares", () => {
    const rows = subpages.map(([subpage, parent]) => ({
      subpage,
      parent,
      topics:
        subpage in AGENT_REFERENCE_TOPICS && parent in AGENT_REFERENCE_TOPICS,
      topLevelParent: !(parent in AGENT_REFERENCE_SUBPAGES),
      named: (agentReferenceContent(privileged, parent) ?? "").includes(
        `\`${subpage}\``,
      ),
      visibility: [ordinary, privileged, api].map(
        (identity) =>
          typeof agentReferenceContent(identity, subpage) ===
          typeof agentReferenceContent(identity, parent),
      ),
    }));
    expect(rows).toEqual(
      subpages.map(([subpage, parent]) => ({
        subpage,
        parent,
        topics: true,
        topLevelParent: true,
        named: true,
        visibility: [true, true, true],
      })),
    );
  });
});
