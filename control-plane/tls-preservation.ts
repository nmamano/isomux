import * as fs from "node:fs";
import * as path from "node:path";
import { SshClient, type Exec, type SshTarget } from "./ssh.ts";
import type { RunRecord } from "./run-record.ts";

export const TLS_RESTORE_REMOTE_PATH = "/root/isomux-tls-restore.tar.gz";
export const TLS_RESTORE_REMOTE_ENCODED_PATH = `${TLS_RESTORE_REMOTE_PATH}.b64`;

export function tlsArchivePath(keysDir: string, runId: string): string {
  return path.join(keysDir, `${runId}.tls.tar.gz`);
}

function sourceTarget(rec: RunRecord): SshTarget {
  return {
    host: rec.ipv4,
    user: rec.loginUser,
    identityFile: rec.privateKeyPath,
    knownHostsFile: rec.knownHostsFile,
  };
}

function filesExist(rec: RunRecord): boolean {
  return fs.existsSync(rec.privateKeyPath) && fs.existsSync(rec.knownHostsFile);
}

export async function exportHostedTls(opts: {
  source: RunRecord | null;
  instanceId: string;
  host: string;
  runId: string;
  keysDir: string;
  exec: Exec;
}): Promise<{ ok: boolean; warning?: string }> {
  const { source, instanceId, host, runId, keysDir, exec } = opts;
  if (!source)
    return {
      ok: false,
      warning: "no prior run was supplied; the certificate fallback will run",
    };
  if (source.instanceId !== instanceId || source.host !== host)
    return {
      ok: false,
      warning:
        "the prior run does not identify this instance and host; the certificate fallback will run",
    };
  if (!filesExist(source))
    return {
      ok: false,
      warning:
        "the prior run has no usable key or host pin; the certificate fallback will run",
    };

  const ssh = new SshClient(sourceTarget(source), exec, "yes");
  const prefix = source.loginUser === "root" ? [] : ["sudo", "-n"];
  let read;
  try {
    read = await ssh.pipe(
      [...prefix, "bash", "-s"],
      "set -euo pipefail\n" +
        "test -f /etc/isomux/tls/key.pem\n" +
        "test -f /etc/isomux/tls/cert.pem\n" +
        "printf 'KEY='\nbase64 -w0 /etc/isomux/tls/key.pem\nprintf '\\nCERT='\nbase64 -w0 /etc/isomux/tls/cert.pem\nprintf '\\n'\n",
    );
  } catch {
    return {
      ok: false,
      warning:
        "the old box TLS pair could not be read; the certificate fallback will run",
    };
  }
  if (read.code !== 0)
    return {
      ok: false,
      warning:
        "the old box TLS pair was unavailable; the certificate fallback will run",
    };
  const key = /^KEY=([^\n]+)$/m.exec(read.stdout)?.[1];
  const cert = /^CERT=([^\n]+)$/m.exec(read.stdout)?.[1];
  if (!key || !cert)
    return {
      ok: false,
      warning:
        "the old box returned an invalid TLS pair; the certificate fallback will run",
    };

  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const stem = path.join(keysDir, `.${runId}.tls`);
  const staged = [
    `${stem}.manifest.json`,
    `${stem}.key.pem`,
    `${stem}.cert.pem`,
  ];
  const archive = tlsArchivePath(keysDir, runId);
  try {
    fs.writeFileSync(
      staged[0],
      JSON.stringify({ version: 1, instanceId, host }) + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(staged[1], Buffer.from(key, "base64"), { mode: 0o600 });
    fs.writeFileSync(staged[2], Buffer.from(cert, "base64"), { mode: 0o600 });
    const tar = Bun.spawnSync([
      "tar",
      "-czf",
      archive,
      "-C",
      keysDir,
      "--transform",
      `s,^\\.${runId}\\.tls\\.manifest\\.json$,manifest.json,`,
      staged[0].split("/").at(-1)!,
      "--transform",
      `s,^\\.${runId}\\.tls\\.key\\.pem$,key.pem,`,
      staged[1].split("/").at(-1)!,
      "--transform",
      `s,^\\.${runId}\\.tls\\.cert\\.pem$,cert.pem,`,
      staged[2].split("/").at(-1)!,
    ]);
    if (tar.exitCode !== 0) throw new Error("tar failed");
    fs.chmodSync(archive, 0o600);
    return { ok: true };
  } catch {
    fs.rmSync(archive, { force: true });
    return {
      ok: false,
      warning:
        "the TLS recovery archive could not be created; the certificate fallback will run",
    };
  } finally {
    for (const file of staged) fs.rmSync(file, { force: true });
  }
}

export async function stageHostedTlsRestore(opts: {
  rec: RunRecord;
  keysDir: string;
  exec: Exec;
}): Promise<{ staged: boolean; warning?: string }> {
  const archive = tlsArchivePath(opts.keysDir, opts.rec.runId);
  if (!fs.existsSync(archive)) return { staged: false };
  let body: string;
  try {
    body = fs.readFileSync(archive).toString("base64");
  } catch {
    return {
      staged: false,
      warning:
        "the TLS recovery archive could not be read; the certificate fallback will run",
    };
  }
  const ssh = new SshClient(sourceTarget(opts.rec), opts.exec, "yes");
  const prefix = opts.rec.loginUser === "root" ? [] : ["sudo", "-n"];
  let result;
  try {
    result = await ssh.pipe(
      [
        ...prefix,
        "install",
        "-m",
        "0600",
        "/dev/stdin",
        TLS_RESTORE_REMOTE_ENCODED_PATH,
      ],
      body,
    );
  } catch {
    return {
      staged: false,
      warning:
        "the TLS recovery archive could not be staged; the certificate fallback will run",
    };
  }
  if (result.code !== 0)
    return {
      staged: false,
      warning:
        "the TLS recovery archive could not be staged; the certificate fallback will run",
    };
  return { staged: true };
}

export function removeTlsArchive(keysDir: string, runId: string): void {
  fs.rmSync(tlsArchivePath(keysDir, runId), { force: true });
}
