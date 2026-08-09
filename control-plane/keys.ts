// Per-run keypairs: generated for one box, destroyed once revocation is proven.
//
// Private key material lives only under the runtime state directory, never in
// the repo tree - not even gitignored. Keys are matched on the exact base64
// blob rather than on a comment or a line number, because a comment is
// attacker-controllable text and a line number is whatever the last writer
// left behind.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec } from "./ssh.ts";

export interface KeyPair {
  privateKeyPath: string;
  publicKeyPath: string;
  /** The full authorized_keys line as ssh-keygen wrote it. */
  publicKeyLine: string;
  /** Field 2 of that line: the identity we match on, and nothing else. */
  blob: string;
  /** Field 1: the algorithm, e.g. ssh-ed25519. */
  algorithm: string;
}

/**
 * Split an authorized_keys entry into the parts we are allowed to reason about.
 *
 * Tolerates leading options (`expiry-time="..." ssh-ed25519 AAAA...`), because
 * once we have rewritten a line it has them, and a re-read has to find the same
 * key it just wrote.
 */
export function parseKeyLine(
  line: string,
): { algorithm: string; blob: string } | null {
  const fields = line.trim().split(/\s+/);
  for (let i = 0; i < fields.length - 1; i++) {
    const algorithm = fields[i];
    const blob = fields[i + 1];
    if (
      /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-\S+)$/.test(algorithm) &&
      /^AAAA[A-Za-z0-9+/=]+$/.test(blob)
    ) {
      return { algorithm, blob };
    }
  }
  return null;
}

export async function generateKeyPair(
  dir: string,
  name: string,
  exec: Exec,
): Promise<KeyPair> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateKeyPath = path.join(dir, name);
  const publicKeyPath = `${privateKeyPath}.pub`;
  // ssh-keygen refuses to overwrite, and an existing key here would mean we are
  // about to reuse material from another run.
  if (fs.existsSync(privateKeyPath)) {
    throw new Error(
      `key already exists at ${privateKeyPath}; refusing to reuse it`,
    );
  }
  const res = await exec.run([
    "ssh-keygen",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    privateKeyPath,
    "-C",
    `isomux-cp-${name}`,
  ]);
  if (res.code !== 0) {
    throw new Error(`ssh-keygen failed (exit ${res.code})`);
  }
  const publicKeyLine = fs.readFileSync(publicKeyPath, "utf8").trim();
  const parsed = parseKeyLine(publicKeyLine);
  if (!parsed) {
    throw new Error("ssh-keygen produced a public key we cannot parse");
  }
  return { privateKeyPath, publicKeyPath, publicKeyLine, ...parsed };
}

/**
 * Destroy our half of the pair.
 *
 * Overwrites before unlinking. On a copy-on-write or log-structured filesystem
 * that does not guarantee the old blocks are gone, which is worth saying out
 * loud rather than implying a shredding guarantee we cannot make: the security
 * property we actually rely on is that the key no longer authenticates
 * anywhere, proven before this runs.
 */
export function destroyPrivateKey(pair: KeyPair): void {
  for (const p of [pair.privateKeyPath, pair.publicKeyPath]) {
    try {
      const size = fs.statSync(p).size;
      fs.writeFileSync(p, Buffer.alloc(size, 0));
    } catch {
      // Already gone is the outcome we wanted.
    }
    try {
      fs.unlinkSync(p);
    } catch {
      // Same.
    }
  }
}
