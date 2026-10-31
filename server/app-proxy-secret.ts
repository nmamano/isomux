// The per-app proxy secret (task 4b3adf60). The office sends it on every
// request it relays to an app, as X-Isomux-Proxy-Secret, and the app gets the
// same value in its environment as ISOMUX_APP_PROXY_SECRET. An app trusts the
// member headers only when the two match: a direct call to the app's loopback
// port from another process on the box does not know the value.
//
// The secret is derived, not stored: HMAC-SHA256 under one office key
// (STATE_ROOT/secrets/app-proxy.key) of the app's name and creation time, so
// it changes only when the app is registered again, and nothing is left to
// clean up at delete. Accident protection at the level of the safety hook, not
// a boundary: apps and agents run as the same OS user.

import { createHmac, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

import type { AppRecord } from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

export const APP_PROXY_SECRET_ENV = "ISOMUX_APP_PROXY_SECRET";
export const APP_PROXY_SECRET_HEADER = "X-Isomux-Proxy-Secret";

export const appProxyKeyPath = (stateRoot: string): string =>
  join(stateRoot, "secrets", "app-proxy.key");

const KEY_BYTES = 32;

// The key: 32 random bytes in a 0600 file in a 0700 directory, made when it
// is missing or has the wrong length. Throws when it can be neither read nor
// made.
export function loadOrCreateAppProxyKey(path: string): Buffer {
  if (existsSync(path)) {
    const stored = readFileSync(path);
    if (stored.length === KEY_BYTES) return stored;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const key = randomBytes(KEY_BYTES);
  atomicWriteFileSync(path, key, 0o600);
  return key;
}

// The app's secret, as hex. A line break keeps the name and the time apart
// ("a1" at 23 is not "a" at 123); a name never holds one.
export function appProxySecret(
  key: Buffer,
  app: Pick<AppRecord, "name" | "createdAt">,
): string {
  return createHmac("sha256", key)
    .update(`${app.name}\n${app.createdAt}`)
    .digest("hex");
}

let productionKey: Buffer | null = null;

// The production secret of `app`, under the key of this office's state root.
// Only a successful key load is cached: a failure is tried again at the next
// call. Throws when the key cannot be read or made.
export function productionAppProxySecret(
  app: Pick<AppRecord, "name" | "createdAt">,
): string {
  productionKey ??= loadOrCreateAppProxyKey(appProxyKeyPath(STATE_ROOT));
  return appProxySecret(productionKey, app);
}

// The secrets of `apps`, for the app log scrub. An app whose secret cannot be
// computed adds nothing.
export function appProxySecretsOf(
  apps: readonly AppRecord[],
  secretFor: (app: AppRecord) => string,
): string[] {
  const secrets: string[] = [];
  for (const app of apps) {
    try {
      secrets.push(secretFor(app));
    } catch {
      // Nothing to scrub for it.
    }
  }
  return secrets;
}
