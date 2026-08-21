// Durable preparation of the key a newly ordered box will carry.

import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPair } from "./keys.ts";
import { parseKeyLine } from "./key-lines.ts";
import type { CreateRequest, LoginUser } from "./provider.ts";
import { loadAnyRun, saveRun } from "./run-record.ts";
import type { Exec } from "./ssh.ts";
import type { InstanceRow } from "./store.ts";

export interface SecretFinder {
  findSshSecret(name: string): Promise<number | null>;
  createSshSecret(name: string, publicKeyLine: string): Promise<number>;
}

export interface RunPreparerDeps {
  runsDir: string;
  keysDir: string;
  exec: Exec;
  secrets: SecretFinder;
  loginUser: LoginUser;
}

export async function prepareCreateRun(
  deps: RunPreparerDeps,
  instance: InstanceRow,
): Promise<CreateRequest> {
  const runId = instance.run_id;
  if (!runId) throw new Error(`instance ${instance.id} has no run id`);
  let rec = loadAnyRun(deps.runsDir, runId);
  if (!rec) {
    const privateKeyPath = path.join(deps.keysDir, runId);
    const publicKeyPath = `${privateKeyPath}.pub`;
    const privateExists = fs.existsSync(privateKeyPath);
    const publicExists = fs.existsSync(publicKeyPath);
    if (privateExists !== publicExists) {
      throw new Error(`run ${runId} has an incomplete local keypair`);
    }
    const pair = privateExists
      ? (() => {
          const publicKeyLine = fs.readFileSync(publicKeyPath, "utf8").trim();
          const parsed = parseKeyLine(publicKeyLine);
          if (!parsed) {
            throw new Error(`run ${runId} has an unreadable local public key`);
          }
          return {
            privateKeyPath,
            publicKeyPath,
            publicKeyLine,
            ...parsed,
          };
        })()
      : await generateKeyPair(deps.keysDir, runId, deps.exec);
    rec = {
      runId,
      state: "prepared",
      host: instance.name,
      instanceId: null,
      ipv4: null,
      loginUser: deps.loginUser,
      privateKeyPath: pair.privateKeyPath,
      publicKeyPath: pair.publicKeyPath,
      algorithm: pair.algorithm,
      blob: pair.blob,
      knownHostsFile: path.join(deps.keysDir, `${runId}.known_hosts`),
    };
    saveRun(deps.runsDir, rec);
  } else {
    // The prepared record is authoritative. Existing key bytes must match it;
    // no recovery branch may generate a replacement key for this run id.
    if (rec.host !== instance.name || rec.state !== "prepared") {
      throw new Error(
        `run ${runId} is not the prepared record for ${instance.id}`,
      );
    }
    if (
      !fs.existsSync(rec.privateKeyPath) ||
      !fs.existsSync(rec.publicKeyPath)
    ) {
      throw new Error(
        `prepared run ${runId} is missing its authoritative key material`,
      );
    }
    const parsed = parseKeyLine(
      fs.readFileSync(rec.publicKeyPath, "utf8").trim(),
    );
    if (
      !parsed ||
      parsed.algorithm !== rec.algorithm ||
      parsed.blob !== rec.blob
    ) {
      throw new Error(
        `prepared run ${runId} key bytes disagree with its authoritative record`,
      );
    }
  }
  if (rec.secretId === undefined) {
    const publicKeyLine = fs.readFileSync(rec.publicKeyPath, "utf8").trim();
    const name = `isomux-cp-${runId}`;
    rec.secretId =
      (await deps.secrets.findSshSecret(name)) ??
      (await deps.secrets.createSshSecret(name, publicKeyLine));
    saveRun(deps.runsDir, rec);
  }
  return {
    intentId: `intent-${instance.id.replace(/^inst-/, "")}`,
    plan: instance.plan,
    region: instance.region,
    publicKeys: [rec.secretId],
  };
}
