import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { STATE_ROOT } from "./config.ts";
import { parseDotenv } from "./persistence.ts";
import { nextVariableNotes } from "../shared/connection-notes.ts";

const USER_ENV_DIR = join(STATE_ROOT, "user-env");
const OFFICE_ENV_DIR = join(STATE_ROOT, "office-env");
const OFFICE_ENV_FILE = join(OFFICE_ENV_DIR, "office.env");
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ManagedEnvValues = Record<string, string>;

export class ManagedEnvValidationError extends Error {}

export function managedUserEnvPath(userId: string): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new ManagedEnvValidationError("invalid user id");
  }
  return join(USER_ENV_DIR, `${userId}.env`);
}

export function managedUserEnvExists(userId: string): boolean {
  if (!SAFE_USER_ID.test(userId)) return false;
  return existsSync(managedUserEnvPath(userId));
}

export function removeManagedUserEnv(userId: string): void {
  rmSync(managedUserEnvPath(userId), { force: true });
  rmSync(managedUserEnvNotesPath(userId), { force: true });
}

export function readManagedUserEnv(userId: string): ManagedEnvValues | null {
  const path = managedUserEnvPath(userId);
  if (!existsSync(path)) return null;
  return parseDotenv(readFileSync(path, "utf8"));
}

export function managedOfficeEnvPath(): string {
  return OFFICE_ENV_FILE;
}

export function managedOfficeEnvExists(): boolean {
  return existsSync(OFFICE_ENV_FILE);
}

export function readManagedOfficeEnv(): ManagedEnvValues | null {
  if (!existsSync(OFFICE_ENV_FILE)) return null;
  return parseDotenv(readFileSync(OFFICE_ENV_FILE, "utf8"));
}

// The rule for a variable's name, in a body or in a path.
export function isManagedEnvKey(key: string): boolean {
  return SAFE_KEY.test(key) && key !== "__proto__";
}

function validate(values: ManagedEnvValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (!isManagedEnvKey(key)) {
      throw new ManagedEnvValidationError(`invalid environment key: ${key}`);
    }
    if (typeof value !== "string") {
      throw new ManagedEnvValidationError(`value for ${key} must be a string`);
    }
    const unsupportedControl = [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 10 && code <= 31) || code === 127;
    });
    if (unsupportedControl) {
      throw new ManagedEnvValidationError(
        `value for ${key} contains an unsupported control character`,
      );
    }
  }
}

export function serializeManagedUserEnv(values: ManagedEnvValues): string {
  validate(values);
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n")
    .concat(Object.keys(values).length > 0 ? "\n" : "");
}

export function writeManagedUserEnv(
  userId: string,
  values: ManagedEnvValues,
): void {
  writeManagedEnv(USER_ENV_DIR, managedUserEnvPath(userId), userId, values);
}

export function writeManagedOfficeEnv(values: ManagedEnvValues): void {
  writeManagedEnv(OFFICE_ENV_DIR, OFFICE_ENV_FILE, "office", values);
}

function writeManagedEnv(
  directory: string,
  path: string,
  tempName: string,
  values: ManagedEnvValues,
): void {
  writeAtomic(directory, path, tempName, serializeManagedUserEnv(values));
}

function writeAtomic(
  directory: string,
  path: string,
  tempName: string,
  content: string,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temp = join(
    directory,
    `.${tempName}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

// The variables' usage notes for agents (integrations A4): a sidecar next to
// each .env file, so the .env format stays as it is. It is not part of the
// OpenCode profile key or revision (env-loader.ts reads the .env files only),
// so a note change restarts nothing. Under office-env/ and user-env/, it
// shares their backup exclusion and agent path block.

export type ManagedEnvNotes = Record<string, string>;

interface NotesFile {
  version: 1;
  notes: ManagedEnvNotes;
}

export function managedUserEnvNotesPath(userId: string): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new ManagedEnvValidationError("invalid user id");
  }
  return join(USER_ENV_DIR, `${userId}.notes.json`);
}

const OFFICE_ENV_NOTES_FILE = join(OFFICE_ENV_DIR, "office.notes.json");

// The notes of the names in `values` only: a sidecar left stale by a failed
// write never shows a note on a gone or re-added variable. A sidecar that does
// not parse reads as no notes.
function readNotes(
  path: string,
  values: ManagedEnvValues | null,
): ManagedEnvNotes {
  const notes: ManagedEnvNotes = Object.create(null);
  if (!values || !existsSync(path)) return notes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return notes;
  }
  const file = parsed as Partial<NotesFile> | null;
  if (
    !file ||
    typeof file !== "object" ||
    file.version !== 1 ||
    !file.notes ||
    typeof file.notes !== "object"
  )
    return notes;
  for (const [name, note] of Object.entries(file.notes))
    if (Object.hasOwn(values, name) && typeof note === "string" && note)
      notes[name] = note;
  return notes;
}

export function readManagedUserEnvNotes(userId: string): ManagedEnvNotes {
  return readNotes(managedUserEnvNotesPath(userId), readManagedUserEnv(userId));
}

export function readManagedOfficeEnvNotes(): ManagedEnvNotes {
  return readNotes(OFFICE_ENV_NOTES_FILE, readManagedOfficeEnv());
}

// The notes to save with `values`; a note that breaks the rule throws.
export function nextManagedEnvNotes(
  values: ManagedEnvValues,
  requested: unknown,
  saved: ManagedEnvNotes,
): ManagedEnvNotes {
  const next = nextVariableNotes(values, requested, saved);
  if (next.ok) return next.notes;
  if (next.name === null)
    throw new ManagedEnvValidationError("notes must be a string map");
  throw new ManagedEnvValidationError(
    next.reason === "too_long"
      ? `the note for ${next.name} is too long`
      : `the note for ${next.name} is not valid`,
  );
}

function writeNotes(
  directory: string,
  path: string,
  tempName: string,
  notes: ManagedEnvNotes,
): void {
  // No sidecar until a variable has a note.
  if (Object.keys(notes).length === 0 && !existsSync(path)) return;
  const sorted = Object.fromEntries(
    Object.entries(notes).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeAtomic(
    directory,
    path,
    `${tempName}-notes`,
    `${JSON.stringify({ version: 1, notes: sorted } satisfies NotesFile, null, 2)}\n`,
  );
}

export function writeManagedUserEnvNotes(
  userId: string,
  notes: ManagedEnvNotes,
): void {
  writeNotes(USER_ENV_DIR, managedUserEnvNotesPath(userId), userId, notes);
}

export function writeManagedOfficeEnvNotes(notes: ManagedEnvNotes): void {
  writeNotes(OFFICE_ENV_DIR, OFFICE_ENV_NOTES_FILE, "office", notes);
}
