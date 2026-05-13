// Shared env file resolver. Used by agent spawn/resume AND cronjob fire/
// resume to merge process.env with office and user env files, so the same
// env reaches the model picker (`list_backend_models`), the actual session
// (`createSession`), and any session-file prechecks (Codex `CODEX_HOME`).
//
// Lives in its own module to avoid a `cronjob-manager → agent-manager →
// command-handlers → cronjob-manager` import cycle. agent-manager owns the
// in-memory `officeState` singleton and registers an env-file provider at
// module init via setOfficeEnvFileProvider; callers (agent-manager,
// cronjob-manager, server/index) all import `buildEnvFor` from here.
//
// User overrides office; office overrides process.env. Spawn-time failure
// mode: if a configured env file is missing or fails to parse, throw — the
// caller is responsible for surfacing the error to the agent/run log.

import { readEnvFile } from "./persistence.ts";
import { getUserEnvFile } from "./users.ts";

// Provider lookup for the current office env file path. agent-manager sets
// this once at module init from its `officeState.office.envFile` so we can
// resolve env without coupling this module to OfficeState directly. Until
// the provider is registered, `buildEnvFor` behaves as if no office env
// file is configured — which only matters during the brief window before
// agent-manager's module body has run, and no caller hits buildEnvFor that
// early in practice.
let getOfficeEnvFile: () => string | null = () => null;

export function setOfficeEnvFileProvider(fn: () => string | null): void {
  getOfficeEnvFile = fn;
}

export function buildEnvFor(
  username?: string,
): { [key: string]: string | undefined } | undefined {
  const officeEnvFile = getOfficeEnvFile();
  const userEnvFile = username ? getUserEnvFile(username) : null;
  if (!officeEnvFile && !userEnvFile) return undefined;

  const merged: { [key: string]: string | undefined } = { ...process.env };
  if (officeEnvFile) {
    const officeEnv = readEnvFile(officeEnvFile);
    Object.assign(merged, officeEnv);
  }
  if (userEnvFile) {
    const userEnv = readEnvFile(userEnvFile);
    Object.assign(merged, userEnv);
  }
  return merged;
}
