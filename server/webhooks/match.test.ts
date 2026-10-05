// Webhook rules: the path walk, value coercion, first-match selection and the
// arg templates.
//
// Pure T0: no server, no disk.

import { describe, it, expect } from "bun:test";
import type { WebhookRule } from "../../shared/types.ts";
import {
  coerceWebhookValue,
  findMatchingRule,
  lookupPath,
  renderArgs,
  renderTemplate,
} from "./match.ts";

const payload = JSON.parse(`{
  "action": "opened",
  "number": 1347,
  "draft": false,
  "merged_at": null,
  "pull_request": {
    "base": { "ref": "main" },
    "user": { "login": "octocat" },
    "labels": [{ "name": "bug" }, { "name": "ui" }]
  },
  "repository": { "full_name": "nmamano/isomux" },
  "__proto__": "own proto",
  "constructor": "own constructor"
}`) as unknown;

describe("lookupPath", () => {
  it("walks nested objects", () => {
    expect(lookupPath(payload, "pull_request.base.ref")).toEqual({
      found: true,
      value: "main",
    });
  });

  it("indexes arrays with integer segments", () => {
    expect(lookupPath(payload, "pull_request.labels.1.name")).toEqual({
      found: true,
      value: "ui",
    });
  });

  it("returns a whole object or array as the value", () => {
    expect(lookupPath(payload, "pull_request.base")).toEqual({
      found: true,
      value: { ref: "main" },
    });
  });

  it("reports a missing key as not found", () => {
    expect(lookupPath(payload, "pull_request.head.ref")).toEqual({
      found: false,
    });
  });

  it("reports an array index past the end as not found", () => {
    expect(lookupPath(payload, "pull_request.labels.2.name")).toEqual({
      found: false,
    });
  });

  it("reports a non-integer segment on an array as not found", () => {
    for (const segment of ["length", "-1", "01", "1.5", "x"]) {
      expect(lookupPath(payload, `pull_request.labels.${segment}`)).toEqual({
        found: false,
      });
    }
  });

  it("reports a path through a scalar as not found", () => {
    expect(lookupPath(payload, "action.length")).toEqual({ found: false });
    expect(lookupPath(payload, "number.0")).toEqual({ found: false });
    expect(lookupPath(payload, "merged_at.x")).toEqual({ found: false });
  });

  it("never reads an inherited property", () => {
    const plain = JSON.parse('{"a":{}}') as unknown;
    for (const path of [
      "a.constructor",
      "a.toString",
      "a.__proto__",
      "a.hasOwnProperty",
    ]) {
      expect(lookupPath(plain, path)).toEqual({ found: false });
    }
  });

  it("reads own data keys whatever their name", () => {
    expect(lookupPath(payload, "__proto__")).toEqual({
      found: true,
      value: "own proto",
    });
    expect(lookupPath(payload, "constructor")).toEqual({
      found: true,
      value: "own constructor",
    });
  });

  it("does not throw on a scalar or null payload", () => {
    expect(lookupPath(null, "a")).toEqual({ found: false });
    expect(lookupPath("text", "length")).toEqual({ found: false });
    expect(lookupPath(7, "a.b")).toEqual({ found: false });
  });
});

describe("coerceWebhookValue", () => {
  it("coerces each JSON type", () => {
    expect(coerceWebhookValue("opened")).toBe("opened");
    expect(coerceWebhookValue("")).toBe("");
    expect(coerceWebhookValue(1347)).toBe("1347");
    expect(coerceWebhookValue(1.5)).toBe("1.5");
    expect(coerceWebhookValue(-0)).toBe("0");
    expect(coerceWebhookValue(true)).toBe("true");
    expect(coerceWebhookValue(false)).toBe("false");
    expect(coerceWebhookValue(null)).toBe("");
    expect(coerceWebhookValue({ a: 1, b: [true, null] })).toBe(
      '{"a":1,"b":[true,null]}',
    );
    expect(coerceWebhookValue([1, "x"])).toBe('[1,"x"]');
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

  it("does not match a missing path, not even against an empty string", () => {
    const rules: WebhookRule[] = [
      { event: "pull_request", match: { "pull_request.head.ref": "" } },
    ];
    expect(findMatchingRule(rules, "pull_request", payload)).toBeNull();
  });

  it("compares coerced values", () => {
    const rules: WebhookRule[] = [
      {
        event: "pull_request",
        match: { number: "1347", draft: "false", merged_at: "" },
      },
    ];
    expect(findMatchingRule(rules, "pull_request", payload)?.index).toBe(0);
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

  it("returns null for no rules", () => {
    expect(findMatchingRule([], "pull_request", payload)).toBeNull();
  });
});

describe("renderTemplate", () => {
  const ctx = { payload, event: "pull_request", delivery: "abc-123" };

  it("keeps literal text around tokens", () => {
    expect(
      renderTemplate(
        "PR #{{payload.number}} in {{payload.repository.full_name}}",
        ctx,
      ),
    ).toBe("PR #1347 in nmamano/isomux");
  });

  it("renders the event and delivery tokens", () => {
    expect(renderTemplate("{{event}}/{{delivery}}", ctx)).toBe(
      "pull_request/abc-123",
    );
  });

  it("renders a missing path as an empty string", () => {
    expect(renderTemplate("[{{payload.pull_request.head.ref}}]", ctx)).toBe(
      "[]",
    );
  });

  it("renders a coerced value", () => {
    expect(renderTemplate("{{payload.pull_request.base}}", ctx)).toBe(
      '{"ref":"main"}',
    );
    expect(renderTemplate("{{payload.merged_at}}", ctx)).toBe("");
  });

  it("keeps an unclosed token literal", () => {
    expect(renderTemplate("a {{payload.number", ctx)).toBe(
      "a {{payload.number",
    );
    expect(renderTemplate("{{event} {{event}}", ctx)).toBe(
      "{{event} pull_request",
    );
  });

  it("keeps an unknown token literal", () => {
    expect(renderTemplate("{{secret}} {{ event }} {{payload}}", ctx)).toBe(
      "{{secret}} {{ event }} {{payload}}",
    );
  });

  it("does not expand a template inside a rendered value", () => {
    const tricky = { payload: { t: "{{event}}" }, event: "e", delivery: "" };
    expect(renderTemplate("{{payload.t}}", tricky)).toBe("{{event}}");
  });

  it("does not treat $ patterns in a value as replacement syntax", () => {
    const dollars = { payload: { t: "$& $1 $$" }, event: "e", delivery: "" };
    expect(renderTemplate("{{payload.t}}", dollars)).toBe("$& $1 $$");
  });
});

describe("renderArgs", () => {
  const ctx = { payload, event: "pull_request", delivery: "abc-123" };

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
