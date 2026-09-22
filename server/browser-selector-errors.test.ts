import { expect, test } from "bun:test";
import { selectorSyntaxFailure } from "./browser-selector-errors";

test("known selector parse failures return fixed guidance without private input", () => {
  const privateText = "private-draft-sentinel";
  const role = selectorSyntaxFailure(
    new Error(
      `click: Error: Unknown attribute "${privateText}", must be one of "name".\nDOM: ${privateText}`,
    ),
  );
  const css = selectorSyntaxFailure(
    new Error(
      `locator.ariaSnapshot: Unexpected token "${privateText}" while parsing css selector "[".\nDOM: ${privateText}`,
    ),
  );
  for (const result of [role, css]) {
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_request",
    });
    expect(result?.error).toContain("role=button");
    expect(JSON.stringify(result)).not.toContain(privateText);
  }
  expect(role?.error).toContain("[exact=true]");
  expect(css?.error).toContain("CSS");
});

test("non-parser failures keep their existing classification", () => {
  const timeout = new Error(
    'page.click: Unexpected token "x" while parsing css selector "["',
  );
  timeout.name = "TimeoutError";
  for (const error of [
    timeout,
    new Error(
      'page.click: strict mode violation: Unknown attribute "exact", must be one of "name"',
    ),
    new Error(
      'page.evaluate: Error: Unknown attribute "exact", must be one of "name"',
    ),
    new Error("framePath is no longer available; read snapshot or text again"),
    new Error("Target page, context or browser has been closed"),
    new Error(
      'private text\nUnexpected token "x" while parsing css selector "["',
    ),
    new Error("Some unknown error"),
    "Unexpected token x while parsing selector y",
  ])
    expect(selectorSyntaxFailure(error)).toBeUndefined();
});
