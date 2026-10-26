// Moves a stored OpenCode session from one profile into another, through
// OpenCode's own export and import (task df0e7b51).
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentHost } from "../../agent-host.ts";
import { errMessage } from "../../../shared/errors.ts";
import {
  OPENCODE_V2_DATABASE,
  openCodeProfileHome,
  openCodeTmpDir,
} from "./config-layers.ts";
import { openCodeDatabasePath, openCodeProfilePaths } from "./profile-paths.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";
import { absent, inspectOpenCodeProfileSession } from "./storage.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";

export interface OpenCodeSessionCli {
  // The export JSON of a session, from a standalone OpenCode on the profile.
  exportSession(profileDir: string, sessionId: string): Promise<string>;
  // Imports an export into the target profile, through its server.
  importSession(target: OpenCodeSupervisor, exported: string): Promise<void>;
}

// Each CLI step; a hung OpenCode must not hold an explicit resume forever.
const STEP_LIMIT_MS = 120_000;

// The CLI's environment on a profile: the profile's own folders and
// database, as the server has them (config-layers.ts), and no member
// variables: an export or an import calls no model.
function profileCliEnvironment(
  profileDir: string,
): Record<string, string | undefined> {
  return {
    PATH: getAgentHost().baseEnv().PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: openCodeProfileHome(profileDir),
    XDG_CONFIG_HOME: join(profileDir, "config"),
    XDG_DATA_HOME: join(profileDir, "data"),
    XDG_STATE_HOME: join(profileDir, "state"),
    XDG_CACHE_HOME: join(profileDir, "cache"),
    TMPDIR: openCodeTmpDir(profileDir),
    OPENCODE_DB: OPENCODE_V2_DATABASE,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

// The directory the session ran in. The import files a session under the
// directory it is given, else under its own working directory.
function exportedDirectory(exported: string): string | null {
  const info = (JSON.parse(exported) as { info?: unknown }).info as
    | { location?: { directory?: unknown } }
    | undefined;
  const directory = info?.location?.directory;
  return typeof directory === "string" && directory ? directory : null;
}

// The lease carries the server password only inside its Basic header.
function leasePassword(authHeader: string): string {
  const decoded = atob(authHeader.replace(/^Basic /, ""));
  return decoded.slice(decoded.indexOf(":") + 1);
}

const openCodeCli: OpenCodeSessionCli = {
  async exportSession(profileDir, sessionId) {
    const host = getAgentHost();
    await host.fs.mkdir(openCodeTmpDir(profileDir), 0o700);
    const result = await host.run(
      [resolveOpenCodeBinary(), "session", "export", sessionId, "--standalone"],
      { cwd: profileDir, env: profileCliEnvironment(profileDir) },
    );
    if (result.exitCode !== 0)
      throw new Error(`opencode session export exited ${result.exitCode}`);
    JSON.parse(result.stdout);
    return result.stdout;
  },
  async importSession(target, exported) {
    const directory = exportedDirectory(exported);
    const host = getAgentHost();
    const lease = await target.acquire();
    try {
      const tmp = openCodeTmpDir(target.profileDir);
      await host.fs.mkdir(tmp, 0o700);
      const file = join(tmp, `isomux-import-${randomUUID()}.json`);
      await host.fs.writeText(file, exported, { mode: 0o600 });
      try {
        const result = await host.run(
          [
            resolveOpenCodeBinary(),
            "session",
            "import",
            file,
            "--server",
            lease.baseUrl,
            ...(directory ? ["--directory", directory] : []),
          ],
          {
            cwd: target.profileDir,
            env: {
              ...profileCliEnvironment(target.profileDir),
              OPENCODE_SERVER_PASSWORD: leasePassword(lease.authHeader),
            },
          },
        );
        if (result.exitCode !== 0)
          throw new Error(`opencode session import exited ${result.exitCode}`);
      } finally {
        await host.fs.rm(file);
      }
    } finally {
      lease.release();
    }
  },
};

let cliOverride: OpenCodeSessionCli | null = null;

export function setOpenCodeSessionCliForTests(
  cli: OpenCodeSessionCli | null,
): void {
  cliOverride = cli;
}

function withinStepLimit<T>(step: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took over ${STEP_LIMIT_MS / 1000} s`)),
      STEP_LIMIT_MS,
    );
  });
  return Promise.race([step, limit]).finally(() => clearTimeout(timer));
}

export type OpenCodeSessionMoveResult = "moved" | "source-not-v2" | "failed";

// Moves one session into the target profile. Never throws. A source that
// 2.1.4 has not imported yet is not read: its v2 database is empty or partial.
export async function moveOpenCodeSession(input: {
  sessionId: string;
  fromProfileDir: string;
  target: OpenCodeSupervisor;
  targetEnvironmentKey: string;
}): Promise<OpenCodeSessionMoveResult> {
  const { sessionId, fromProfileDir, target } = input;
  try {
    if (absent(`${openCodeDatabasePath(fromProfileDir, "v2")}.ready`))
      return "source-not-v2";
    const cli = cliOverride ?? openCodeCli;
    const exported = await withinStepLimit(
      cli.exportSession(fromProfileDir, sessionId),
      "the export",
    );
    await withinStepLimit(cli.importSession(target, exported), "the import");
    console.log(
      `[opencode] moved session ${sessionId} from ${fromProfileDir} to the profile of ${input.targetEnvironmentKey}`,
    );
    return "moved";
  } catch (error) {
    console.error(
      `[opencode] could not move session ${sessionId} from ${fromProfileDir}: ${errMessage(error)}`,
    );
    return "failed";
  }
}

// The other profile dir (not `exceptKey`'s) that stores the session durable,
// or null.
export function findOpenCodeSessionProfile(
  sessionId: string,
  exceptKey: string,
): string | null {
  const own = openCodeProfilePaths(exceptKey).profileDir;
  const root = dirname(own);
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const profileDir = join(root, name);
    if (profileDir === own) continue;
    try {
      if (inspectOpenCodeProfileSession(profileDir, sessionId) === "durable")
        return profileDir;
    } catch {
      // An unreadable profile is no source.
    }
  }
  return null;
}
