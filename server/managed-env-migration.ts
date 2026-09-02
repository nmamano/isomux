import type { UserRecord } from "../shared/types.ts";
import { statSync } from "node:fs";

export function legacyEnvFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface LegacyEnvSubject {
  label: string;
  path: string | null;
  legacyExists(path: string): boolean;
  managedExists(): boolean;
  readManaged(): Record<string, string> | null;
  readLegacy(path: string): Record<string, string>;
  writeManaged(values: Record<string, string>): void;
  clearLegacyPath(): void;
}

export interface ManagedEnvMigrationDeps {
  office: LegacyEnvSubject;
  users: UserRecord[];
  userSubject: (user: UserRecord) => LegacyEnvSubject;
  log: (message: string) => void;
}

function migrateSubject(
  subject: LegacyEnvSubject,
  log: (message: string) => void,
): void {
  if (!subject.path) return;
  try {
    if (!subject.legacyExists(subject.path)) {
      subject.clearLegacyPath();
      log(
        `[managed env migration] cleared missing env file for ${subject.label}`,
      );
      return;
    }
    // Never overwrite values a user already saved in the managed editor. Leave
    // the legacy marker intact so an operator can resolve the collision without
    // losing either source.
    const values = subject.readLegacy(subject.path);
    if (subject.managedExists()) {
      const managed = subject.readManaged();
      const sorted = (record: Record<string, string> | null) =>
        JSON.stringify(
          Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        );
      if (sorted(managed) !== sorted(values)) {
        throw new Error("managed env already exists");
      }
      // A prior boot can stop after the atomic write but before persistence.
      // Identical bytes mean the retry can finish by clearing the marker.
      subject.clearLegacyPath();
      return;
    }
    subject.writeManaged(values);
    subject.clearLegacyPath();
  } catch {
    // Do not include the path, key, value, or thrown error. A malformed value
    // can appear in all of them; only the subject identity is safe to log.
    log(
      `[managed env migration] could not import ${subject.label}; retrying on next boot`,
    );
  }
}

export function migrateManagedEnvAtBoot(deps: ManagedEnvMigrationDeps): void {
  migrateSubject(deps.office, deps.log);
  for (const user of deps.users) {
    migrateSubject(deps.userSubject(user), deps.log);
  }
}
