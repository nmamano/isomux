import * as fs from "node:fs";

/** Read one importer's strict 0600 env file without shell evaluation. */
export function readAllowlistedEnvFile(
  file: string,
  // Each narrow importer requires every name that it allows.
  allowedNames: readonly string[],
  label: string,
): Map<string, string> {
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(
      `${label} credential file must be a regular file that only its owner can read (chmod 600)`,
    );
  }
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([A-Z0-9_]+)='([^'\r\n]+)'$/.exec(line);
    if (!match || !allowedNames.includes(match[1])) {
      throw new Error(
        `${label} credential file has an unknown or malformed line`,
      );
    }
    if (values.has(match[1])) {
      throw new Error(`${label} credential file repeats a name`);
    }
    values.set(match[1], match[2]);
  }
  if (allowedNames.some((name) => !values.has(name))) {
    throw new Error(`${label} credential file is missing a required name`);
  }
  return values;
}
