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
  openCodeCliTmpDir,
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
    TMPDIR: openCodeCliTmpDir(profileDir),
    OPENCODE_DB: OPENCODE_V2_DATABASE,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

// The directory the session ran in. The import files a session under the
// directory it is given, else under its own working directory.
function exportedDirectory(exported: string): string | null {
  const info = (JSON.parse(exported) as { info?: unknown }).info as
    { location?: { directory?: unknown } } | undefined;
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
    await host.fs.mkdir(openCodeCliTmpDir(profileDir), 0o700);
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
      const tmp = openCodeCliTmpDir(target.profileDir);
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

// What a move across the standard line needs from each side's server.
export interface OpenCodeSessionSides {
  // The message ids of the session on `side`, oldest first; null when the
  // side does not hold it.
  messageIds(
    side: OpenCodeSupervisor,
    sessionId: string,
  ): Promise<string[] | null>;
  deleteSession(side: OpenCodeSupervisor, sessionId: string): Promise<void>;
}

// One request to a side's server, with a lease for its length.
async function sideRequest(
  side: OpenCodeSupervisor,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const lease = await side.acquire();
  try {
    return await fetch(new URL(path, lease.baseUrl), {
      ...init,
      headers: { authorization: lease.authHeader },
      signal: AbortSignal.timeout(STEP_LIMIT_MS),
    });
  } finally {
    lease.settle();
    lease.release();
  }
}

const serverSides: OpenCodeSessionSides = {
  async messageIds(side, sessionId) {
    const path = `/api/session/${encodeURIComponent(sessionId)}/message`;
    const ids: string[] = [];
    // T7: 2.1.4 refuses a cursor together with an order.
    let query = "?limit=200&order=asc";
    for (;;) {
      const response = await sideRequest(side, `${path}${query}`);
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`the message list answered ${response.status}`);
      const body = (await response.json()) as {
        data?: unknown;
        cursor?: { next?: unknown };
      };
      if (!Array.isArray(body.data))
        throw new Error("OpenCode returned an invalid message list.");
      for (const item of body.data as unknown[]) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "string")
          throw new Error("OpenCode returned a message without an id.");
        ids.push(id);
      }
      const next = body.cursor?.next;
      if (typeof next !== "string" || !next || body.data.length === 0)
        return ids;
      query = `?cursor=${encodeURIComponent(next)}&limit=200`;
    }
  },
  async deleteSession(side, sessionId) {
    const response = await sideRequest(
      side,
      `/api/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`the session delete answered ${response.status}`);
  },
};

// Moves the session to `to` when `from` holds it, at a start or resume on
// `to` (task e77304b1). `from` is the other side of the standard line, the
// side the agent ran on last: a start on a side succeeds only when the other
// side holds no copy. Any copy `to` holds is a leftover, deleted first; then
// export from `from`, import into `to`, check that `to` lists the same
// message ids, and delete the session in `from`. 2.1.4 answers an import of
// a session the target holds with exit 0 and keeps its copy (probe 1c), so
// only the id check shows a failed import. "absent": `from` does not hold
// it. Throws when any step fails; the caller refuses the start.
export async function moveOpenCodeSessionAcross(input: {
  sessionId: string;
  from: OpenCodeSupervisor;
  to: OpenCodeSupervisor;
  sides?: OpenCodeSessionSides;
}): Promise<"moved" | "absent"> {
  const { sessionId, from, to } = input;
  const sides = input.sides ?? serverSides;
  const cli = cliOverride ?? openCodeCli;
  const source = await sides.messageIds(from, sessionId);
  if (source === null) return "absent";
  if ((await sides.messageIds(to, sessionId)) !== null)
    await sides.deleteSession(to, sessionId);
  const exported = await withinStepLimit(
    cli.exportSession(from.profileDir, sessionId),
    "the export",
  );
  await withinStepLimit(cli.importSession(to, exported), "the import");
  const copied = await sides.messageIds(to, sessionId);
  if (JSON.stringify(copied) !== JSON.stringify(source))
    throw new Error(
      `the copy of session ${sessionId} does not match its source`,
    );
  await sides.deleteSession(from, sessionId);
  console.log(
    `[opencode] moved session ${sessionId} from ${from.profileDir} to ${to.profileDir}`,
  );
  return "moved";
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
