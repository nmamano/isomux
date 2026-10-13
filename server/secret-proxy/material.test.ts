import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import { join } from "node:path";

import { STATE_ROOT } from "../config.ts";
import { isCredentialStorePath } from "../credential-store-paths.ts";
import {
  ensureSecretMaterial,
  readProxyPort,
  readSystemRoots,
  saveProxyPort,
  secretMaterialPaths,
  withoutOfficeCas,
} from "./material.ts";
import { createCertificateAuthority, createLeafIssuer } from "./x509.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-material-test-"));
  roots.push(root);
  return root;
}

// Stand-ins for the system roots: real roots from the runtime's list. An
// office CA cannot stand in: the roots never hold one.
const SYSTEM_ROOT = `${rootCertificates[0].trim()}\n`;
const OTHER_ROOT = `${rootCertificates[1].trim()}\n`;
const certCount = (pem: string) =>
  (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
const mode = (path: string) => statSync(path).mode & 0o777;

describe("ensureSecretMaterial", () => {
  test("makes the key, the CA and the bundle, owner-only", () => {
    const root = tempRoot();
    const paths = secretMaterialPaths(root, root);
    expect(existsSync(paths.dir)).toBe(false);
    const material = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    expect(material.placeholderKey.length).toBe(32);
    expect(mode(paths.dir)).toBe(0o700);
    for (const file of [
      paths.placeholderKey,
      paths.caCert,
      paths.caKey,
      paths.bundle,
    ])
      expect(mode(file)).toBe(0o600);
    expect(new X509Certificate(readFileSync(paths.caCert)).ca).toBe(true);
    // The bundle holds the office CA and then the system roots.
    const bundle = readFileSync(paths.bundle, "utf8");
    expect(bundle.startsWith(material.ca.certPem.trim())).toBe(true);
    expect(bundle).toContain(SYSTEM_ROOT.trim());
    expect(material.bundlePath).toBe(paths.bundle);
  });

  test("reuses the key and the CA, and rewrites the bundle from new roots", () => {
    const root = tempRoot();
    const first = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    const newRoot = OTHER_ROOT;
    const second = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: newRoot,
    });
    expect(second.placeholderKey.equals(first.placeholderKey)).toBe(true);
    expect(second.ca.certPem).toBe(first.ca.certPem);
    const bundle = readFileSync(second.bundlePath, "utf8");
    expect(bundle).toContain(newRoot.trim());
    expect(bundle).not.toContain(SYSTEM_ROOT.trim());
  });

  test("a restore without the key or the CA makes new ones", () => {
    const root = tempRoot();
    const paths = secretMaterialPaths(root, root);
    const first = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    rmSync(paths.placeholderKey);
    rmSync(paths.caKey);
    rmSync(paths.bundle);
    const second = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    expect(second.placeholderKey.equals(first.placeholderKey)).toBe(false);
    expect(second.ca.certPem).not.toBe(first.ca.certPem);
    expect(readFileSync(paths.bundle, "utf8")).toContain(
      second.ca.certPem.trim(),
    );
  });

  test("an unreadable CA or a short key is replaced", () => {
    const root = tempRoot();
    const paths = secretMaterialPaths(root, root);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.placeholderKey, "short");
    writeFileSync(paths.caCert, "not a certificate");
    writeFileSync(paths.caKey, "not a key");
    const material = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    expect(material.placeholderKey.length).toBe(32);
    expect(new X509Certificate(readFileSync(paths.caCert)).ca).toBe(true);
  });

  test("a separate share gets a bundle the agent user can read", () => {
    const state = tempRoot();
    const share = tempRoot();
    const material = ensureSecretMaterial({
      stateRoot: state,
      shareRoot: share,
      systemRootsPem: SYSTEM_ROOT,
    });
    expect(material.bundlePath).toBe(join(share, "secrets", "ca-bundle.pem"));
    expect(mode(join(share, "secrets"))).toBe(0o755);
    expect(mode(material.bundlePath)).toBe(0o644);
    expect(existsSync(join(share, "secrets", "ca-key.pem"))).toBe(false);
  });
});

describe("office CAs never become roots", () => {
  test("withoutOfficeCas drops this office's CA and another office's, and keeps real roots", () => {
    const mine = createCertificateAuthority().certPem;
    const theirs = createCertificateAuthority().certPem;
    const out = withoutOfficeCas(`${mine}${SYSTEM_ROOT}${theirs}${OTHER_ROOT}`);
    expect(certCount(out)).toBe(2);
    expect(out).toContain(SYSTEM_ROOT.trim());
    expect(out).toContain(OTHER_ROOT.trim());
    expect(out).not.toContain(mine.trim());
    expect(out).not.toContain(theirs.trim());
  });

  test("roots read from an SSL_CERT_FILE that holds office CAs leave them out", () => {
    const root = tempRoot();
    const file = join(root, "mixed.pem");
    const officeCa = createCertificateAuthority().certPem;
    writeFileSync(file, `${officeCa}${SYSTEM_ROOT}`);
    const roots = readSystemRoots({ SSL_CERT_FILE: file }, "linux");
    expect(roots).toContain(SYSTEM_ROOT.trim());
    expect(roots).not.toContain(officeCa.trim());
  });

  test("a server whose SSL_CERT_FILE is an office bundle keeps a stable bundle", () => {
    // A test office started from an agent's shell: SSL_CERT_FILE is the
    // office bundle that the last start wrote.
    const root = tempRoot();
    const first = ensureSecretMaterial({
      stateRoot: root,
      shareRoot: root,
      systemRootsPem: SYSTEM_ROOT,
    });
    const sizes: number[] = [];
    for (let start = 0; start < 3; start++) {
      ensureSecretMaterial({
        stateRoot: root,
        shareRoot: root,
        systemRootsPem: readSystemRoots(
          { SSL_CERT_FILE: first.bundlePath },
          "linux",
        ),
      });
      sizes.push(certCount(readFileSync(first.bundlePath, "utf8")));
    }
    expect(sizes).toEqual([2, 2, 2]);
  });

  test("selfSignedOnly drops a certificate that a CA issued", () => {
    const ca = createCertificateAuthority();
    const leaf = createLeafIssuer(ca, () => true).issue(
      "api.example-stub.test",
    );
    expect(
      withoutOfficeCas(`${leaf.certPem}${SYSTEM_ROOT}`, {
        selfSignedOnly: true,
      }),
    ).toBe(SYSTEM_ROOT);
    expect(certCount(withoutOfficeCas(leaf.certPem))).toBe(1);
  });
});

describe("the proxy port file", () => {
  test("round-trips, and a bad file reads as no port", () => {
    const root = tempRoot();
    expect(readProxyPort(root)).toBeNull();
    saveProxyPort(root, 41234);
    expect(readProxyPort(root)).toBe(41234);
    expect(mode(secretMaterialPaths(root, root).proxy)).toBe(0o600);
    writeFileSync(secretMaterialPaths(root, root).proxy, '{"port":0}');
    expect(readProxyPort(root)).toBeNull();
    writeFileSync(secretMaterialPaths(root, root).proxy, "{");
    expect(readProxyPort(root)).toBeNull();
  });
});

describe("readSystemRoots", () => {
  test("on Linux, the server's own SSL_CERT_FILE wins", () => {
    const root = tempRoot();
    const file = join(root, "roots.pem");
    writeFileSync(file, SYSTEM_ROOT);
    expect(readSystemRoots({ SSL_CERT_FILE: file }, "linux")).toBe(SYSTEM_ROOT);
  });

  test("on Linux with no usable SSL_CERT_FILE, a bundle or the runtime list", () => {
    const pem = readSystemRoots(
      { SSL_CERT_FILE: "/nonexistent/roots.pem" },
      "linux",
    );
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
  });
});

test("the path check refuses every proxy file in the state root", () => {
  const paths = secretMaterialPaths(STATE_ROOT, STATE_ROOT);
  for (const path of [
    paths.placeholderKey,
    paths.caCert,
    paths.caKey,
    paths.proxy,
    paths.bundle,
  ])
    expect(isCredentialStorePath(path)).toBe(true);
});
