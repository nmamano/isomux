import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareCreateRun } from "./run-preparation.ts";
import { loadAnyRun, saveRun } from "./run-record.ts";
import { parseKeyLine } from "./key-lines.ts";
import { SpawnExec } from "./ssh.ts";
import { generateKeyPair } from "./keys.ts";
import type { InstanceRow } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test("a prepared record strictly wins and recovery never generates key B", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-prepare-"));
  roots.push(root);
  const deps = {
    runsDir: path.join(root, "runs"),
    keysDir: path.join(root, "keys"),
    exec: new SpawnExec(),
    loginUser: "root" as const,
  };
  const instance = {
    id: "inst-one",
    run_id: "run-one",
    name: "one.test.isomux.app",
    plan: "V153",
    region: "EU",
  } as InstanceRow;
  const first = await prepareCreateRun(deps, instance);
  const rec = loadAnyRun(deps.runsDir, "run-one")!;
  const privateBytes = fs.readFileSync(rec.privateKeyPath);
  const second = await prepareCreateRun(deps, instance);
  expect(second).toEqual(first);
  expect(fs.readFileSync(rec.privateKeyPath)).toEqual(privateBytes);
  // The request carries the run's own key, straight from the record, and the
  // record agrees with the key file on disk.
  expect(first.publicKeys).toEqual([
    { algorithm: rec.algorithm, blob: rec.blob },
  ]);
  expect(
    parseKeyLine(fs.readFileSync(rec.publicKeyPath, "utf8").trim()),
  ).toEqual({ algorithm: rec.algorithm, blob: rec.blob });
});

test("a complete keypair from a crash before record save is adopted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-prepare-crash-"));
  roots.push(root);
  const keysDir = path.join(root, "keys");
  const pair = await generateKeyPair(keysDir, "run-one", new SpawnExec());
  const request = await prepareCreateRun(
    {
      runsDir: path.join(root, "runs"),
      keysDir,
      exec: new SpawnExec(),
      loginUser: "root",
    },
    {
      id: "inst-one",
      run_id: "run-one",
      name: "one.test.isomux.app",
      plan: "V153",
      region: "EU",
    } as InstanceRow,
  );
  expect(request.publicKeys).toEqual([
    { algorithm: pair.algorithm, blob: pair.blob },
  ]);
  expect(loadAnyRun(path.join(root, "runs"), "run-one")).toMatchObject({
    privateKeyPath: pair.privateKeyPath,
    blob: pair.blob,
  });
});

test("a record prepared before this change, with or without a key-store secret, carries its own key", async () => {
  // The waiting customer's run was prepared and never got a secret; other
  // records may hold a secretId. Both retry into the user-data path, and the
  // secretId is never sent anywhere.
  for (const secretId of [undefined, 77]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-prepare-old-"));
    roots.push(root);
    const deps = {
      runsDir: path.join(root, "runs"),
      keysDir: path.join(root, "keys"),
      exec: new SpawnExec(),
      loginUser: "root" as const,
    };
    const instance = {
      id: "inst-one",
      run_id: "run-one",
      name: "one.test.isomux.app",
      plan: "V153",
      region: "EU",
    } as InstanceRow;
    await prepareCreateRun(deps, instance);
    const rec = loadAnyRun(deps.runsDir, "run-one")!;
    expect(rec.state).toBe("prepared");
    if (secretId === undefined) delete rec.secretId;
    else rec.secretId = secretId;
    saveRun(deps.runsDir, rec);
    expect(loadAnyRun(deps.runsDir, "run-one")!.secretId).toBe(secretId);
    const request = await prepareCreateRun(deps, instance);
    expect([secretId, request.publicKeys]).toEqual([
      secretId,
      [{ algorithm: rec.algorithm, blob: rec.blob }],
    ]);
    expect(Object.keys(request).sort()).toEqual([
      "intentId",
      "plan",
      "publicKeys",
      "region",
    ]);
  }
});
