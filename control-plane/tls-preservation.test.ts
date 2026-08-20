import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./ssh.ts";
import type { RunRecord } from "./run-record.ts";
import {
  exportHostedTls,
  stageHostedTlsRestore,
  tlsArchivePath,
} from "./tls-preservation.ts";

let root = "";
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-old",
    state: "revoked",
    host: "office.test",
    instanceId: "instance-1",
    ipv4: "192.0.2.1",
    loginUser: "root",
    privateKeyPath: join(root, "old-key"),
    publicKeyPath: join(root, "old-key.pub"),
    algorithm: "ssh-ed25519",
    blob: "AAAA",
    knownHostsFile: join(root, "old.known_hosts"),
    ...overrides,
  };
}

function execReturning(
  stdout: string,
  code = 0,
): Exec & { calls: string[][]; inputs: string[] } {
  const calls: string[][] = [];
  const inputs: string[] = [];
  return {
    calls,
    inputs,
    async run(argv, opts) {
      calls.push(argv);
      inputs.push(opts?.stdin ?? "");
      return { code, stdout, stderr: "" };
    },
  };
}

describe("hosted TLS carriage", () => {
  test("exports through the prior run's strict identity and pins the manifest", async () => {
    root = mkdtempSync(join(tmpdir(), "isomux-tls-"));
    const old = record();
    writeFileSync(old.privateKeyPath, "ssh key", { mode: 0o600 });
    writeFileSync(old.knownHostsFile, "host pin\n", { mode: 0o600 });
    const fake = execReturning(
      `KEY=${Buffer.from("tls key").toString("base64")}\nCERT=${Buffer.from("tls cert").toString("base64")}\n`,
    );
    const result = await exportHostedTls({
      source: old,
      instanceId: old.instanceId,
      host: old.host,
      runId: "run-new",
      keysDir: root,
      exec: fake,
    });
    expect(result).toEqual({ ok: true });
    expect(fake.calls[0]).toContain("StrictHostKeyChecking=yes");
    expect(fake.calls[0]).toContain(`UserKnownHostsFile=${old.knownHostsFile}`);
    const listed = Bun.spawnSync([
      "tar",
      "-tzf",
      tlsArchivePath(root, "run-new"),
    ]);
    expect(listed.stdout.toString().trim().split("\n").sort()).toEqual([
      "cert.pem",
      "key.pem",
      "manifest.json",
    ]);
    const manifest = Bun.spawnSync([
      "tar",
      "-xOzf",
      tlsArchivePath(root, "run-new"),
      "manifest.json",
    ]).stdout.toString();
    expect(JSON.parse(manifest)).toEqual({
      version: 1,
      instanceId: "instance-1",
      host: "office.test",
    });
  });

  test("a missing source route and a cross-instance source fall back without SSH", async () => {
    root = mkdtempSync(join(tmpdir(), "isomux-tls-"));
    const fake = execReturning(
      `KEY=${Buffer.from("tls key").toString("base64")}\nCERT=${Buffer.from("tls cert").toString("base64")}\n`,
    );
    expect(
      (
        await exportHostedTls({
          source: null,
          instanceId: "instance-1",
          host: "office.test",
          runId: "run-new",
          keysDir: root,
          exec: fake,
        })
      ).ok,
    ).toBe(false);
    const other = record({ instanceId: "other" });
    writeFileSync(other.privateKeyPath, "ssh key", { mode: 0o600 });
    writeFileSync(other.knownHostsFile, "host pin\n", { mode: 0o600 });
    expect(
      (
        await exportHostedTls({
          source: other,
          instanceId: "instance-1",
          host: "office.test",
          runId: "run-new",
          keysDir: root,
          exec: fake,
        })
      ).ok,
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("a strict SSH transport failure cannot block recycle", async () => {
    root = mkdtempSync(join(tmpdir(), "isomux-tls-"));
    const old = record({ loginUser: "ubuntu" });
    writeFileSync(old.privateKeyPath, "ssh key", { mode: 0o600 });
    writeFileSync(old.knownHostsFile, "host pin\n", { mode: 0o600 });
    const calls: string[][] = [];
    const result = await exportHostedTls({
      source: old,
      instanceId: old.instanceId,
      host: old.host,
      runId: "run-new",
      keysDir: root,
      exec: {
        async run(argv) {
          calls.push(argv);
          throw new Error("transport failed");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(calls[0]).toContain("StrictHostKeyChecking=yes");
    expect(calls[0]).toContain("sudo");
  });

  test("stages only the new run archive through its pinned SSH identity", async () => {
    root = mkdtempSync(join(tmpdir(), "isomux-tls-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(tlsArchivePath(root, "run-new"), "archive", { mode: 0o600 });
    const current = record({
      runId: "run-new",
      privateKeyPath: join(root, "new-key"),
      knownHostsFile: join(root, "new.known_hosts"),
    });
    const fake = execReturning("");
    expect(
      await stageHostedTlsRestore({ rec: current, keysDir: root, exec: fake }),
    ).toEqual({ staged: true });
    expect(fake.calls[0]).toContain("StrictHostKeyChecking=yes");
    expect(fake.calls[0]).toContain(
      `UserKnownHostsFile=${current.knownHostsFile}`,
    );
    expect(Buffer.from(fake.inputs[0], "base64").toString()).toBe("archive");
  });
});
