// The setup key: the secret that claims an unclaimed office for its first
// owner (POST /auth/claim, and the container setup page in
// deploy/container/bootstrap.ts).
//
// A key configured in ISOMUX_SETUP_KEY (env or a deployment secret) wins.
// Without one, the first unclaimed boot makes a key and keeps it in
// <state root>/setup-key (0600), so a restart does not void a printed setup
// link. Each unclaimed boot prints http://localhost:<port>/setup#key=<key>:
// the key rides in the URL fragment, so no request line or proxy log carries
// it. The claim deletes the file; a claimed boot deletes a leftover one.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

export const SETUP_KEY_ENV = "ISOMUX_SETUP_KEY";
export const SETUP_KEY_MIN_LENGTH = 32;

export function setupKeyFile(): string {
  return join(STATE_ROOT, "setup-key");
}

export type SetupKeySource = "configured" | "file";

// The configured key is read once per process and removed from the
// environment, so agents and apps the office starts later do not inherit it.
let configured: string | null | undefined;
let active: { key: string; source: SetupKeySource } | null = null;

function configuredKey(): string | null {
  if (configured === undefined) {
    configured = process.env[SETUP_KEY_ENV] || null;
    delete process.env[SETUP_KEY_ENV];
  }
  return configured;
}

// Called at each boot. An unclaimed office gets its key (the configured one,
// else the saved file, else a new file); a claimed office deletes a leftover
// file.
export function setupKeyAtBoot(preClaim: boolean): void {
  const key = configuredKey();
  if (!preClaim) {
    discardSetupKey();
    return;
  }
  if (key !== null) {
    if (key.length < SETUP_KEY_MIN_LENGTH)
      throw new Error(
        `${SETUP_KEY_ENV} must contain at least ${SETUP_KEY_MIN_LENGTH} characters`,
      );
    active = { key, source: "configured" };
    return;
  }
  const path = setupKeyFile();
  if (existsSync(path)) {
    const saved = readFileSync(path, "utf8").trim();
    if (saved.length >= SETUP_KEY_MIN_LENGTH) {
      active = { key: saved, source: "file" };
      return;
    }
  }
  const made = randomBytes(32).toString("base64url");
  // No trailing newline, so `curl --data-urlencode key@<file>` sends it as is.
  atomicWriteFileSync(path, made, 0o600);
  active = { key: made, source: "file" };
}

export function activeSetupKey(): {
  key: string;
  source: SetupKeySource;
} | null {
  return active;
}

export function activeSetupKeySource(): SetupKeySource | null {
  return active?.source ?? null;
}

// After the claim the key has no use: forget it and delete its file.
export function discardSetupKey(): void {
  active = null;
  rmSync(setupKeyFile(), { force: true });
}

export function setupKeyMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function activeSetupKeyMatches(candidate: string): boolean {
  return active !== null && setupKeyMatches(candidate, active.key);
}

// Wrong-key attempts per client per minute. A counter per client, so one
// caller cannot keep the claim blocked for everyone. The table is bounded like
// server/ready-limiter.ts and fails open when it is full of live windows: the
// key has at least 32 characters, so the limit bounds noise, not what stops
// guessing.
const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 20;
const MAX_TRACKED_CLIENTS = 1024;
const failures = new Map<string, { start: number; count: number }>();

export function setupClaimBlocked(client: string, now: number): boolean {
  const w = failures.get(client);
  return (
    w !== undefined &&
    now - w.start < WINDOW_MS &&
    w.count >= MAX_FAILURES_PER_WINDOW
  );
}

export function recordSetupKeyFailure(client: string, now: number): void {
  const w = failures.get(client);
  if (w && now - w.start < WINDOW_MS) {
    w.count++;
    return;
  }
  if (!w && failures.size >= MAX_TRACKED_CLIENTS) {
    for (const [key, win] of failures)
      if (now - win.start >= WINDOW_MS) failures.delete(key);
    if (failures.size >= MAX_TRACKED_CLIENTS) return;
  }
  failures.set(client, { start: now, count: 1 });
}

export function _resetSetupKeyForTests(): void {
  configured = undefined;
  active = null;
  failures.clear();
}
