import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareCreateRun } from "./run-preparation.ts";
import { loadAnyRun } from "./run-record.ts";
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
  const calls: string[] = [];
  const deps = {
    runsDir: path.join(root, "runs"),
    keysDir: path.join(root, "keys"),
    exec: new SpawnExec(),
    loginUser: "root" as const,
    secrets: {
      findSshSecret: async (name: string) => {
        calls.push(`find:${name}`);
        return calls.length === 1 ? null : 77;
      },
      createSshSecret: async () => {
        calls.push("create");
        return 77;
      },
    },
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
  expect(calls).toEqual(["find:isomux-cp-run-one", "create"]);
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
      secrets: {
        findSshSecret: async () => 81,
        createSshSecret: async () => {
          throw new Error("the existing secret should win");
        },
      },
    },
    {
      id: "inst-one",
      run_id: "run-one",
      name: "one.test.isomux.app",
      plan: "V153",
      region: "EU",
    } as InstanceRow,
  );
  expect(request.publicKeys).toEqual([81]);
  expect(loadAnyRun(path.join(root, "runs"), "run-one")).toMatchObject({
    privateKeyPath: pair.privateKeyPath,
    blob: pair.blob,
  });
});
