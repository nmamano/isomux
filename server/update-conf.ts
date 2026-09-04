// Reader for the updater root-of-trust config
// (internal-docs/release-design.md). deploy/install.sh writes it at
// /etc/isomux/update.conf; scripts/update.sh is its OWNER and strict consumer.
// The server is a secondary READER with two uses:
//   - presence of the file is the "this box is updater-managed" signal that
//     switches the update checker into release mode (server/update-checker.ts);
//   - SERVICE_KIND / UPDATER_PATH / REPO_URL parameterize the in-UI update
//     trigger (server/update-trigger.ts).
//
// PRESENCE and PARSE SUCCESS are separate signals: a managed VPS with a
// damaged conf must stay "managed" (release mode, trigger refusing with a
// config error) - falling back to commit mode would tell an updater-managed
// box about main drift, exactly what presence-based mode detection exists to
// prevent. Hence the discriminated result: absent | invalid | parsed.
//
// Same parse contract as update.sh: literal key=value lines, never sourced or
// evaluated - a hostile value is data. One deliberate divergence: unknown keys
// are TOLERATED here (update.sh fails closed on them). The shell script is the
// privileged consumer and must refuse a config it doesn't fully understand; a
// server that predates a newly added key must keep reading the keys it knows,
// or every conf addition would break the banner on not-yet-updated boxes.
//
// ISOMUX_UPDATE_CONF overrides the path - the same env var update.sh honors,
// used by sandbox tests. Values are only ever used as spawn argv elements or
// compared as strings, never interpolated into a shell.

import { existsSync, readFileSync } from "fs";

export const DEFAULT_UPDATE_CONF = "/etc/isomux/update.conf";

export function updateConfPath(): string {
  return process.env.ISOMUX_UPDATE_CONF || DEFAULT_UPDATE_CONF;
}

export type UpdateConfRead =
  // No file - the box is not updater-managed (commit mode, no trigger).
  | { state: "absent" }
  // The file exists but can't be read or has a non-key=value line: still an
  // updater-managed box, but the trigger must refuse with a config error and
  // the checker stays quiet (it can't know REPO_URL).
  | { state: "invalid" }
  | { state: "parsed"; values: Record<string, string> };

export function readUpdateConf(path = updateConfPath()): UpdateConfRead {
  if (!existsSync(path)) return { state: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "invalid" };
  }
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) return { state: "invalid" };
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { state: "parsed", values };
}
