// Stage only the certificate service's three Fly values. This importer is
// separate from the database bootstrap and Contabo importer, so using it cannot
// rotate either credential family as a side effect.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP, FLY_TOKEN_FILE, readSecretFile, realSpawn } from "./fly-cli.ts";
import { namesPresent, pushSecrets } from "./secrets.ts";

export const CERTIFICATE_SECRET_NAMES = [
  "ISOMUX_CF_ZONE_ID",
  "ISOMUX_CF_TOKEN",
  "ISOMUX_ACME_EMAIL",
] as const;

function readCertificateFile(file: string): Map<string, string> {
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(
      "the certificate credential file must be a regular 0600 file",
    );
  }
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([A-Z0-9_]+)='([^'\r\n]+)'$/.exec(line);
    if (!match || !CERTIFICATE_SECRET_NAMES.includes(match[1] as never)) {
      throw new Error(
        "the certificate credential file has an unknown or malformed line",
      );
    }
    if (values.has(match[1]))
      throw new Error("the certificate credential file repeats a name");
    values.set(match[1], match[2]);
  }
  if (!/^[0-9a-f]{32}$/.test(values.get("ISOMUX_CF_ZONE_ID") ?? "")) {
    throw new Error("the Cloudflare zone id has the wrong shape");
  }
  if (!/^[A-Za-z0-9._-]{20,}$/.test(values.get("ISOMUX_CF_TOKEN") ?? "")) {
    throw new Error("the Cloudflare token has the wrong shape");
  }
  if (
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.get("ISOMUX_ACME_EMAIL") ?? "")
  ) {
    throw new Error("the ACME contact has the wrong shape");
  }
  return values;
}

async function main(): Promise<void> {
  const verify = process.argv.length === 3 && process.argv[2] === "--verify";
  if (process.argv.length > (verify ? 3 : 2))
    throw new Error("usage: certificate-secrets.ts [--verify]");
  const flyToken = readSecretFile(FLY_TOKEN_FILE);
  if (verify) {
    const answer = await namesPresent({
      required: CERTIFICATE_SECRET_NAMES,
      flyToken,
      spawn: realSpawn,
    });
    console.log(`listing_readable: ${answer.readable}`);
    console.log(`required_secret_names_present: ${answer.present}`);
    process.exitCode = answer.present ? 0 : 1;
    return;
  }
  const values = readCertificateFile(
    path.join(
      os.homedir(),
      ".config",
      "isomux",
      "control-plane-certificate.env",
    ),
  );
  const outcome = await pushSecrets({
    pairs: CERTIFICATE_SECRET_NAMES.map((name) => ({
      name,
      value: values.get(name)!,
    })),
    allowed: CERTIFICATE_SECRET_NAMES,
    flyToken,
    spawn: realSpawn,
    app: APP,
  });
  console.log(`validated: ${outcome.problems.length === 0}`);
  console.log(`spawned: ${outcome.spawned}`);
  console.log(`flyctl_exit: ${outcome.exitCode}`);
  console.log(`value_in_child_output: ${outcome.valueInChildOutput}`);
  process.exitCode =
    outcome.spawned && outcome.exitCode === 0 && !outcome.valueInChildOutput
      ? 0
      : 1;
}

if (import.meta.main) await main();
