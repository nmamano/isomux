// Webhook rules through the two calls ingress makes: findMatchingRule picks the
// rule, renderArgs fills its templates. The payload is parsed JSON from an
// outside sender.
//
// Pure T0: no server, no disk.

import { describe, it, expect } from "bun:test";
import type { WebhookRule } from "../../shared/types.ts";
import { findMatchingRule, renderArgs } from "./match.ts";

const payload = JSON.parse(`{
  "action": "opened",
  "number": 1347,
  "draft": false,
  "merged_at": null,
  "title": "{{event}} $& $1 $$",
  "pull_request": {
    "base": { "ref": "main" },
    "user": { "login": "octocat" },
    "labels": [{ "name": "bug" }, { "name": "ui" }]
  },
  "repository": { "full_name": "nmamano/isomux" },
  "__proto__": "own proto",
  "constructor": "own constructor"
}`) as unknown;

const ctx = { payload, event: "pull_request", delivery: "abc-123" };

const render = (template: string, context = ctx) =>
  renderArgs({ v: template }, context).v;

const matches = (match: Record<string, string>, p: unknown = payload) =>
  findMatchingRule([{ event: "*", match }], "pull_request", p) !== null;

describe("renderArgs: templates", () => {
  const cases: [string, string, string][] = [
    ["a nested key", "{{payload.pull_request.base.ref}}", "main"],
    ["an array index", "{{payload.pull_request.labels.1.name}}", "ui"],
    ["an object, as JSON", "{{payload.pull_request.base}}", '{"ref":"main"}'],
    [
      "an array, as JSON",
      "{{payload.pull_request.labels}}",
      '[{"name":"bug"},{"name":"ui"}]',
    ],
    [
      "a number, a boolean and null",
      "{{payload.number}}/{{payload.draft}}/{{payload.merged_at}}",
      "1347/false/",
    ],
    [
      "literal text around tokens",
      "PR #{{payload.number}} in {{payload.repository.full_name}}",
      "PR #1347 in nmamano/isomux",
    ],
    [
      "the event and delivery tokens",
      "{{event}}/{{delivery}}",
      "pull_request/abc-123",
    ],
    [
      "own keys named like prototype properties",
      "{{payload.__proto__}}|{{payload.constructor}}",
      "own proto|own constructor",
    ],
    [
      "a value that holds a token and $ patterns, unexpanded",
      "{{payload.title}}",
      "{{event}} $& $1 $$",
    ],
    [
      "an unclosed token, literally",
      "a {{payload.number {{event} {{event}}",
      "a {{payload.number {{event} pull_request",
    ],
    [
      "an unknown token, literally",
      "{{secret}} {{ event }} {{payload}}",
      "{{secret}} {{ event }} {{payload}}",
    ],
  ];
  for (const [label, template, expected] of cases) {
    it(`renders ${label}`, () => {
      expect(render(template)).toBe(expected);
    });
  }

  it("renders each arg in order", () => {
    const rendered = renderArgs(
      { repo: "{{payload.repository.full_name}}", pr: "{{payload.number}}" },
      ctx,
    );
    expect(rendered).toEqual({ repo: "nmamano/isomux", pr: "1347" });
    expect(Object.keys(rendered)).toEqual(["repo", "pr"]);
  });

  it("renders no args as an empty object", () => {
    expect(renderArgs(undefined, ctx)).toEqual({});
  });

  it("keeps an arg named like a prototype property as an own key", () => {
    const args = JSON.parse(
      '{"__proto__":"{{event}}","constructor":"x"}',
    ) as Record<string, string>;
    const rendered = renderArgs(args, ctx);
    expect(Object.getPrototypeOf(rendered)).toBe(Object.prototype);
    expect(Object.hasOwn(rendered, "__proto__")).toBe(true);
    expect(JSON.stringify(rendered)).toBe(
      '{"__proto__":"pull_request","constructor":"x"}',
    );
  });
});

// A path that does not resolve renders as "" and never matches, not even "".
// The pair is needed: an index such as -1 reads undefined, which also renders
// as "", so only the match tells a found path from a missing one.
describe("a path that does not resolve", () => {
  const paths = [
    "pull_request.head.ref",
    "pull_request.labels.2",
    "pull_request.labels.length",
    "pull_request.labels.-1",
    "pull_request.labels.01",
    "pull_request.labels.x",
    "action.length",
    "number.0",
    "merged_at.x",
    "repository.constructor",
    "repository.toString",
    "repository.__proto__",
    "repository.hasOwnProperty",
  ];
  for (const path of paths) {
    it(`renders empty and never matches: ${path}`, () => {
      expect(render(`{{payload.${path}}}`)).toBe("");
      expect(matches({ [path]: "" })).toBe(false);
    });
  }

  it("a scalar or null payload resolves no path and does not throw", () => {
    for (const p of [null, "text", 7]) {
      expect(render("{{payload.length}}", { ...ctx, payload: p })).toBe("");
      expect(matches({ length: "" }, p)).toBe(false);
    }
  });
});

describe("findMatchingRule", () => {
  it("matches the event and every match entry", () => {
    const rules: WebhookRule[] = [
      {
        event: "pull_request",
        match: { action: "opened", "pull_request.base.ref": "main" },
      },
    ];
    expect(findMatchingRule(rules, "pull_request", payload)?.index).toBe(0);
  });

  it("does not match when one entry differs", () => {
    const rules: WebhookRule[] = [
      {
        event: "pull_request",
        match: { action: "opened", "pull_request.base.ref": "dev" },
      },
    ];
    expect(findMatchingRule(rules, "pull_request", payload)).toBeNull();
  });

  it("does not match another event", () => {
    const rules: WebhookRule[] = [{ event: "push" }];
    expect(findMatchingRule(rules, "pull_request", payload)).toBeNull();
  });

  it("compares coerced values", () => {
    expect(matches({ number: "1347", draft: "false", merged_at: "" })).toBe(
      true,
    );
  });

  it("picks the first rule that matches", () => {
    const rules: WebhookRule[] = [
      { event: "pull_request", match: { action: "closed" } },
      { event: "pull_request", match: { action: "opened" } },
      { event: "*" },
    ];
    const found = findMatchingRule(rules, "pull_request", payload);
    expect(found?.index).toBe(1);
    expect(found?.rule).toBe(rules[1]);
  });

  it("matches any event with *", () => {
    const rules: WebhookRule[] = [{ event: "*", match: { action: "opened" } }];
    expect(findMatchingRule(rules, "issues", payload)?.index).toBe(0);
  });

  it("matches an empty event only with *", () => {
    const rules: WebhookRule[] = [{ event: "" }, { event: "*" }];
    expect(findMatchingRule(rules, "", payload)?.index).toBe(1);
    expect(findMatchingRule([{ event: "" }], "", payload)).toBeNull();
  });
});
