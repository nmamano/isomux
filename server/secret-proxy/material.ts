// The files behind the secret proxy (internal-docs/secrets-design.md, section
// 2.3). All of them are made with the first secret, so an office without
// secrets has none of them.
//
// STATE_ROOT/secrets/placeholder.key  the HMAC key of the placeholders
// STATE_ROOT/secrets/ca.pem, ca-key.pem  the office CA
// STATE_ROOT/secrets/proxy.json  {"port": N}, the proxy's loopback port
// SHARE_ROOT/secrets/ca-bundle.pem  the office CA and the system roots
//
// A restore without them (backups exclude secrets/) makes new ones. Agents
// read the new bundle when their processes start again.

import { spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rootCertificates } from "node:tls";
import { dirname, join, resolve } from "node:path";

import {
  createCertificateAuthority,
  OFFICE_CA_NAME,
  type CertificateAuthority,
} from "./x509.ts";

const KEY_BYTES = 32;

// Write a file atomically with the given mode, through a temp file in the
// same directory.
function writeAtomic(path: string, content: string | Buffer, mode: number) {
  const temp = join(
    dirname(path),
    `.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function ensureDir(path: string, mode: number) {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function isCertificateAuthority(ca: CertificateAuthority): boolean {
  try {
    const cert = new X509Certificate(ca.certPem);
    return cert.ca && cert.checkPrivateKey(createPrivateKey(ca.keyPem));
  } catch {
    return false;
  }
}

export interface SecretMaterial {
  placeholderKey: Buffer;
  ca: CertificateAuthority;
  bundlePath: string;
}

export function secretMaterialPaths(stateRoot: string, shareRoot: string) {
  const dir = join(stateRoot, "secrets");
  return {
    dir,
    placeholderKey: join(dir, "placeholder.key"),
    caCert: join(dir, "ca.pem"),
    caKey: join(dir, "ca-key.pem"),
    proxy: join(dir, "proxy.json"),
    bundleDir: join(shareRoot, "secrets"),
    bundle: join(shareRoot, "secrets", "ca-bundle.pem"),
  };
}

// Reads the key and the CA, and makes any that is missing or unreadable.
// Then writes the bundle from the CA and `systemRootsPem`, every time, so it
// follows changes of the system roots.
export function ensureSecretMaterial(input: {
  stateRoot: string;
  shareRoot: string;
  systemRootsPem: string;
}): SecretMaterial {
  const paths = secretMaterialPaths(input.stateRoot, input.shareRoot);
  ensureDir(paths.dir, 0o700);

  let placeholderKey: Buffer | null = null;
  if (existsSync(paths.placeholderKey)) {
    const stored = readFileSync(paths.placeholderKey);
    if (stored.length === KEY_BYTES) placeholderKey = stored;
  }
  if (!placeholderKey) {
    placeholderKey = randomBytes(KEY_BYTES);
    writeAtomic(paths.placeholderKey, placeholderKey, 0o600);
  }

  let ca: CertificateAuthority | null = null;
  if (existsSync(paths.caCert) && existsSync(paths.caKey)) {
    const stored = {
      certPem: readFileSync(paths.caCert, "utf8"),
      keyPem: readFileSync(paths.caKey, "utf8"),
    };
    if (isCertificateAuthority(stored)) ca = stored;
  }
  if (!ca) {
    ca = createCertificateAuthority();
    // The key first: a crash between the two leaves a key with no cert,
    // which the next start replaces, never a cert with a stale key.
    writeAtomic(paths.caKey, ca.keyPem, 0o600);
    writeAtomic(paths.caCert, ca.certPem, 0o600);
  }

  // In a single-user office the share root is the state root, so the bundle
  // sits in the 0700 secrets directory, which the agents' OS user can read.
  // A separate share is readable by the agent user.
  const sameDir = resolve(paths.bundleDir) === resolve(paths.dir);
  if (!sameDir) ensureDir(paths.bundleDir, 0o755);
  const roots = withoutOfficeCas(input.systemRootsPem).trim();
  writeAtomic(
    paths.bundle,
    `${ca.certPem.trim()}\n${roots ? `${roots}\n` : ""}`,
    sameDir ? 0o600 : 0o644,
  );

  return { placeholderKey, ca, bundlePath: paths.bundle };
}

export function readProxyPort(stateRoot: string): number | null {
  const path = secretMaterialPaths(stateRoot, stateRoot).proxy;
  if (!existsSync(path)) return null;
  try {
    const port = (JSON.parse(readFileSync(path, "utf8")) as { port?: unknown })
      .port;
    return Number.isInteger(port) &&
      (port as number) > 0 &&
      (port as number) < 65536
      ? (port as number)
      : null;
  } catch {
    return null;
  }
}

export function saveProxyPort(stateRoot: string, port: number): void {
  const paths = secretMaterialPaths(stateRoot, stateRoot);
  ensureDir(paths.dir, 0o700);
  writeAtomic(paths.proxy, `${JSON.stringify({ port })}\n`, 0o600);
}

// The system's trusted roots, as PEM. The bundle replaces the system store
// for tools that read SSL_CERT_FILE, so it must keep roots that an
// administrator added. On Linux the distribution bundle holds them (Debian
// and Ubuntu rebuild it with update-ca-certificates). On macOS they are in
// the System keychain, which /etc/ssl/cert.pem does not include. The last
// fallback is the runtime's own Mozilla list.
const LINUX_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];
const MAC_KEYCHAINS = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
];

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

// The certificates of `pem` that may act as roots: never an office CA (a
// server started from an agent's shell has SSL_CERT_FILE pointing at an
// office bundle, and its CA must not become a trusted upstream root or grow
// the bundle at every start), and, when `selfSignedOnly`, only self-signed
// ones. Unparsable blocks are dropped.
export function withoutOfficeCas(
  pem: string,
  options: { selfSignedOnly?: boolean } = {},
): string {
  const kept: string[] = [];
  for (const block of pem.match(PEM_CERTIFICATE) ?? []) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      continue;
    }
    if (cert.subject.split("\n").includes(`CN=${OFFICE_CA_NAME}`)) continue;
    if (options.selfSignedOnly && cert.issuer !== cert.subject) continue;
    kept.push(block);
  }
  return kept.length ? `${kept.join("\n")}\n` : "";
}

export function readSystemRoots(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const own = env.SSL_CERT_FILE;
  const fromFile = (file: string) =>
    existsSync(file) ? withoutOfficeCas(readFileSync(file, "utf8")) : "";
  if (platform === "darwin") {
    const pem = own ? fromFile(own) : "";
    if (pem) return pem;
    // The keychains also hold intermediates: keep self-signed certificates
    // only. Trust settings (a root an administrator distrusted) are not
    // read: a known limit.
    const result = spawnSync(
      "/usr/bin/security",
      ["find-certificate", "-a", "-p", ...MAC_KEYCHAINS],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status === 0) {
      const roots = withoutOfficeCas(result.stdout, { selfSignedOnly: true });
      if (roots) return roots;
    }
  } else {
    for (const file of own ? [own, ...LINUX_BUNDLES] : LINUX_BUNDLES) {
      const pem = fromFile(file);
      if (pem) return pem;
    }
  }
  return withoutOfficeCas(`${rootCertificates.join("\n")}\n`);
}
