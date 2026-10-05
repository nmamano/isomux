// Webhook rules: path lookup, value coercion, first-match selection and arg
// templates. See internal-docs/webhooks-design.md section 3.
//
// The payload is parsed JSON from an outside sender. Lookups read only the
// payload's own data keys, so an inherited property (`constructor`, an array's
// `length`) is never a value, and a missing path never throws.

import type { WebhookRule } from "../../shared/types.ts";

export type PathLookup = { found: true; value: unknown } | { found: false };

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

export function lookupPath(payload: unknown, path: string): PathLookup {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

// The string form that a match compares and a template renders.
export function coerceWebhookValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

export interface RuleMatch {
  index: number;
  rule: WebhookRule;
}

// An empty event (a generic hook with no event header) matches only "*".
export function findMatchingRule(
  rules: readonly WebhookRule[],
  event: string,
  payload: unknown,
): RuleMatch | null {
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (rule.event !== "*" && (event === "" || rule.event !== event)) continue;
    const entries = Object.entries(rule.match ?? {});
    const holds = entries.every(([path, expected]) => {
      const found = lookupPath(payload, path);
      return found.found && coerceWebhookValue(found.value) === expected;
    });
    if (holds) return { index, rule };
  }
  return null;
}

export interface TemplateContext {
  payload: unknown;
  event: string;
  delivery: string;
}

// Tokens are exact: {{event}}, {{delivery}} and {{payload.<path>}}. A missing
// path renders as "". An unknown token and an unclosed "{{" stay literal.
const TOKEN = /\{\{(event|delivery|payload\.[^{}]+)\}\}/g;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(TOKEN, (_token, name: string) => {
    if (name === "event") return ctx.event;
    if (name === "delivery") return ctx.delivery;
    const found = lookupPath(ctx.payload, name.slice("payload.".length));
    return found.found ? coerceWebhookValue(found.value) : "";
  });
}

// Built from entries, so an arg named like a prototype property becomes an own
// key and never reaches a setter.
export function renderArgs(
  args: Record<string, string> | undefined,
  ctx: TemplateContext,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([name, template]) => [
      name,
      renderTemplate(template, ctx),
    ]),
  );
}
