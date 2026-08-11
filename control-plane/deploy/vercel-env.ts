// Putting values into a Vercel project without letting one out.
//
// THE VALUE IS WRITE-ONLY BY THE PLATFORM, and this file is built so that our
// side is too. A `sensitive` entry cannot be read back by anyone holding the
// token (Vercel's documentation, read 2026-08-11), which is the property the
// whole coordinator design rests on: a secret exists in one process and in
// Vercel, and nowhere else, ever.
//
// Three rules, and each closes a different way a value escapes:
//
//   - values travel in a JSON BODY, never in argv, never through a shell, and
//     never through a file;
//   - `value` is STRIPPED from every response before the data reaches any code
//     that could report it - not trusted to be absent, and not trusted to be a
//     placeholder, because a field nobody reads cannot be printed by mistake;
//   - a failure carries the STATUS and nothing else, like every other seam
//     here. A Vercel error body quotes back what it was sent.
//
// What may be printed: names, types, targets, counts and booleans.

import { vercelApi } from "./vercel-api.ts";

/** Vercel's two relevant types. `sensitive` is write-only; `encrypted` can be
 * read back, which is why it is used only for values that are public anyway. */
export type EnvType = "sensitive" | "encrypted";

/** The environments this deployment uses. `development` is never targeted -
 * Vercel does not allow `sensitive` there, and we have no use for it. */
export type EnvTarget = "production" | "preview";

export interface EnvWrite {
  key: string;
  /** Held only in the caller's memory. Never logged, never returned. */
  value: string;
  type: EnvType;
  target: EnvTarget[];
}

/** What a caller may see about an entry: never a value, not even a masked one. */
export interface EnvFact {
  key: string;
  type: string;
  target: string[];
}

/**
 * Keep only the three fields that are safe, and drop everything else.
 *
 * An ALLOWLIST rather than `delete row.value`: Vercel may add a field, may
 * return a placeholder, may name the same thing differently in a later API
 * version, and none of those should be able to reach a transcript. What is not
 * named here does not survive this function.
 */
export function factOf(row: Record<string, unknown>): EnvFact {
  const target = row.target;
  return {
    key: typeof row.key === "string" ? row.key : "",
    type: typeof row.type === "string" ? row.type : "",
    target: Array.isArray(target)
      ? target.filter((t): t is string => typeof t === "string").sort()
      : typeof target === "string"
        ? [target]
        : [],
  };
}

/** Create one entry. The response is reduced to a fact before it is returned,
 * so the value cannot survive the call even in a variable. */
export async function createEnv(
  projectId: string,
  token: string,
  write: EnvWrite,
): Promise<EnvFact> {
  const answer = await vercelApi<Record<string, unknown>>(
    `/v10/projects/${projectId}/env`,
    token,
    {
      method: "POST",
      body: {
        key: write.key,
        value: write.value,
        type: write.type,
        target: write.target,
      },
    },
  );
  // Vercel answers either the entry or `{created: {...}}` depending on shape.
  const created =
    typeof answer.created === "object" && answer.created !== null
      ? (answer.created as Record<string, unknown>)
      : answer;
  return factOf(created);
}

/** Every entry the project carries, as facts. Never a decrypted read: there is
 * no call here that asks for a value, and there never should be. */
export async function inventory(
  projectId: string,
  token: string,
): Promise<EnvFact[]> {
  const answer = await vercelApi<{ envs?: Record<string, unknown>[] }>(
    `/v10/projects/${projectId}/env`,
    token,
  );
  return (answer.envs ?? []).map(factOf);
}

export interface InventoryVerdict {
  exact: boolean;
  missing: string[];
  unexpected: string[];
  wrongType: string[];
  wrongTarget: string[];
  forbiddenPresent: string[];
}

/**
 * Is the project carrying exactly what was intended, and nothing else?
 *
 * All four failure kinds are reported separately rather than as one boolean,
 * because "an extra name" and "the right name with the wrong type" are
 * different incidents and a caller deciding whether to deploy needs to know
 * which one it is looking at.
 */
export function judgeInventory(
  facts: EnvFact[],
  expected: EnvWrite[],
  forbidden: readonly string[],
): InventoryVerdict {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const missing: string[] = [];
  const wrongType: string[] = [];
  const wrongTarget: string[] = [];
  for (const want of expected) {
    const got = byKey.get(want.key);
    if (!got) {
      missing.push(want.key);
      continue;
    }
    if (got.type !== want.type) wrongType.push(want.key);
    const wantTarget = [...want.target].sort().join(",");
    if (got.target.join(",") !== wantTarget) wrongTarget.push(want.key);
  }
  const intended = new Set(expected.map((e) => e.key));
  return {
    exact:
      missing.length === 0 &&
      wrongType.length === 0 &&
      wrongTarget.length === 0 &&
      facts.every((f) => intended.has(f.key)),
    missing,
    unexpected: facts.filter((f) => !intended.has(f.key)).map((f) => f.key),
    wrongType,
    wrongTarget,
    forbiddenPresent: facts
      .map((f) => f.key)
      .filter((k) => forbidden.includes(k)),
  };
}
