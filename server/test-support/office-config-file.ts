// Writes to the office config file of the test state root. It lives apart from
// app-host-test-kit.ts, which loads the whole server, so a test child that only
// needs this helper starts fast (task 78a55448).

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { assertTestStatePath } from "./temp-state.ts";

export function patchOfficeConfig(patch: Record<string, unknown>): void {
  const file = join(STATE_ROOT, "office-config.json");
  assertTestStatePath(file);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    current = {};
  }
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
}
