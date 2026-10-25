// Placeholders (internal-docs/secrets-design.md, section 2.1). An agent with a
// secret in scope gets NAME=<placeholder>, never the value. The placeholder is
// an HMAC of the scope, the name and the generation under the office's
// placeholder key, so it is the same across restarts and value rotations, and
// different in each scope. It keeps the value's well-known prefix, so the
// format checks of clients (gh, stripe) pass.

import { createHmac } from "node:crypto";

import type { SecretScope } from "../secret-store.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Longest first, so github_pat_ wins over a shorter match. The body length is
// the provider's own where it is fixed (GitHub classic tokens are prefix plus
// 36 characters, fine-grained ones prefix plus 82).
const KNOWN_PREFIXES: readonly { prefix: string; body: number }[] = [
  { prefix: "github_pat_", body: 82 },
  { prefix: "FlyV1 fm2_", body: 64 },
  { prefix: "sk_live_", body: 99 },
  { prefix: "sk_test_", body: 99 },
  { prefix: "rk_live_", body: 99 },
  { prefix: "rk_test_", body: 99 },
  { prefix: "ghp_", body: 36 },
  { prefix: "gho_", body: 36 },
  { prefix: "ghu_", body: 36 },
  { prefix: "ghs_", body: 36 },
  { prefix: "ghr_", body: 36 },
];
const PLAIN_BODY = 40;

export function scopeId(scope: SecretScope): string {
  return scope.kind === "office" ? "office" : `user:${scope.userId}`;
}

function shapeOf(value: string): { prefix: string; body: number } {
  return (
    KNOWN_PREFIXES.find(({ prefix }) => value.startsWith(prefix)) ?? {
      prefix: "",
      body: PLAIN_BODY,
    }
  );
}

// `body` base62 characters from HMAC-SHA256 in counter mode. Bytes of 248 and
// above are skipped, so each character is uniform.
function base62(key: Buffer, input: string, body: number): string {
  let out = "";
  for (let counter = 0; out.length < body; counter++) {
    const block = createHmac("sha256", key)
      .update(`${input}\0${counter}`)
      .digest();
    for (const byte of block) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === body) break;
    }
  }
  return out;
}

// The prefix comes from the current value. A rotation to a value with another
// well-known prefix therefore changes the placeholder; the caller compares the
// two and treats that rotation as a change of the scope's set.
export function placeholderFor(
  key: Buffer,
  scope: SecretScope,
  name: string,
  generation: number,
  value: string,
): string {
  const { prefix, body } = shapeOf(value);
  const input = `${scopeId(scope)}\0${name}\0${generation}`;
  return prefix + base62(key, input, body);
}

// The proxy password that agents send in HTTPS_PROXY. The proxy refuses a
// CONNECT without it, so another OS user on the box cannot use its tunnels or
// the company proxy behind them. Derived from the placeholder key, so it is the
// same across restarts and changes with the key.
export function proxyClientToken(key: Buffer): string {
  return createHmac("sha256", key).update("secret-proxy-client").digest("hex");
}
