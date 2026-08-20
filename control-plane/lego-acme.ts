import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import {
  assertCertificateTarget,
  type CertificateTarget,
} from "./certificate-target.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  argv: string[],
  env: Record<string, string>,
) => Promise<CommandResult>;

export interface LegoRequest {
  instanceId: string;
  names: readonly [string, string];
  csrPem: string;
}

export interface LegoAdapterOptions {
  root: string;
  target: CertificateTarget;
  email: string;
  legoPath?: string;
  dnsHookPath: string;
  run: CommandRunner;
  cloudflareToken: string;
}

function exactNames(
  found: readonly string[],
  wanted: readonly string[],
): boolean {
  return (
    found.length === wanted.length &&
    [...found].sort().every((name, i) => name === [...wanted].sort()[i])
  );
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value))
    throw new Error("invalid office identity");
  return value;
}

interface DerNode {
  tag: number;
  bytes: Uint8Array;
}

function derNodes(bytes: Uint8Array): DerNode[] {
  const nodes: DerNode[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const tag = bytes[offset++];
    if (tag === undefined || offset >= bytes.length)
      throw new Error("invalid DER");
    let length = bytes[offset++];
    if (length === undefined) throw new Error("invalid DER");
    if ((length & 0x80) !== 0) {
      const count = length & 0x7f;
      if (count === 0 || count > 4 || offset + count > bytes.length)
        throw new Error("invalid DER");
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    }
    if (offset + length > bytes.length) throw new Error("invalid DER");
    nodes.push({ tag, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return nodes;
}

function oid(node: DerNode): string {
  if (node.tag !== 0x06 || node.bytes.length === 0)
    throw new Error("invalid DER OID");
  const parts = [Math.floor(node.bytes[0] / 40), node.bytes[0] % 40];
  let value = 0;
  for (const byte of node.bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  if (value !== 0) throw new Error("invalid DER OID");
  return parts.join(".");
}

function csrNamesFromDer(pem: string): {
  commonName: string | null;
  sans: string[];
} {
  const encoded = pem.replace(/-----[^-]+-----|\s/g, "");
  const root = derNodes(Buffer.from(encoded, "base64"));
  if (root.length !== 1 || root[0].tag !== 0x30)
    throw new Error("invalid CSR DER");
  const request = derNodes(root[0].bytes);
  const info = request[0]?.tag === 0x30 ? derNodes(request[0].bytes) : [];
  if (info.length < 4 || info[1].tag !== 0x30)
    throw new Error("invalid CSR structure");

  let commonName: string | null = null;
  for (const rdn of derNodes(info[1].bytes)) {
    for (const pair of derNodes(rdn.bytes)) {
      const fields = derNodes(pair.bytes);
      if (
        fields[0]?.tag === 0x06 &&
        oid(fields[0]) === "2.5.4.3" &&
        fields[1]
      ) {
        if (commonName !== null)
          throw new Error("the CSR has more than one common name");
        commonName = Buffer.from(fields[1].bytes).toString("utf8");
      }
    }
  }

  const attributes = info.find((node) => node.tag === 0xa0);
  if (!attributes) throw new Error("the CSR has no extension request");
  const extensionRequests = derNodes(attributes.bytes).filter((attribute) => {
    const fields = attribute.tag === 0x30 ? derNodes(attribute.bytes) : [];
    return (
      fields[0]?.tag === 0x06 && oid(fields[0]) === "1.2.840.113549.1.9.14"
    );
  });
  if (extensionRequests.length !== 1)
    throw new Error("the CSR must contain one extension request");
  const attributeFields = derNodes(extensionRequests[0].bytes);
  const values =
    attributeFields[1]?.tag === 0x31 ? derNodes(attributeFields[1].bytes) : [];
  const extensions = values[0]?.tag === 0x30 ? derNodes(values[0].bytes) : [];
  const sanExtensions = extensions.filter((extension) => {
    const fields = extension.tag === 0x30 ? derNodes(extension.bytes) : [];
    return fields[0]?.tag === 0x06 && oid(fields[0]) === "2.5.29.17";
  });
  if (sanExtensions.length !== 1)
    throw new Error("the CSR must contain one subjectAltName extension");
  const sanFields = derNodes(sanExtensions[0].bytes);
  const value = sanFields.find((field) => field.tag === 0x04);
  if (!value) throw new Error("invalid subjectAltName extension");
  const sans = derNodes(value.bytes).flatMap((sequence) =>
    sequence.tag === 0x30
      ? derNodes(sequence.bytes)
          .filter((name) => name.tag === 0x82)
          .map((name) => Buffer.from(name.bytes).toString("latin1"))
      : [],
  );
  return { commonName, sans };
}

async function namesInCsr(
  run: CommandRunner,
  path: string,
): Promise<{ commonName: string | null; sans: string[] }> {
  const result = await run(
    ["openssl", "req", "-in", path, "-noout", "-verify"],
    {},
  );
  if (result.code !== 0) throw new Error("the CSR is not valid");
  try {
    return csrNamesFromDer(readFileSync(path, "utf8"));
  } catch {
    throw new Error("the CSR is not valid");
  }
}

function namesInCertificate(pem: string): string[] {
  const names = new X509Certificate(pem).subjectAltName ?? "";
  return [...names.matchAll(/DNS:([^,\s]+)/g)].map((match) => match[1]);
}

/** Normalize either a certificate or a public-key PEM to complete SPKI DER. */
function publicKeyHash(pem: string): string {
  return createHash("sha256")
    .update(createPublicKey(pem).export({ type: "spki", format: "der" }))
    .digest("hex");
}

async function csrPublicKeyHash(
  run: CommandRunner,
  csrPath: string,
): Promise<string> {
  const result = await run(
    ["openssl", "req", "-in", csrPath, "-pubkey", "-noout"],
    {},
  );
  if (result.code !== 0) throw new Error("the CSR public key is not readable");
  return publicKeyHash(result.stdout);
}

/**
 * The only ACME adapter. It accepts a public CSR and returns a public chain.
 * lego owns ARI scheduling. Its default fallback uses the certificate's actual
 * validity (one third remaining), so this code has no fixed-day renewal rule.
 */
export async function obtainCertificateWithLego(
  opts: LegoAdapterOptions,
  request: LegoRequest,
): Promise<{ certificatePem: string }> {
  assertCertificateTarget(opts.target);
  const dir = join(opts.root, "requests", safeId(request.instanceId));
  mkdirSync(opts.root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const csrPath = join(dir, "request.csr");
  const csrTmp = `${csrPath}.tmp`;
  writeFileSync(csrTmp, request.csrPem, { mode: 0o600 });
  renameSync(csrTmp, csrPath);
  const csrNames = await namesInCsr(opts.run, csrPath);
  if (
    !exactNames(csrNames.sans, request.names) ||
    (csrNames.commonName !== null &&
      !request.names.includes(csrNames.commonName))
  ) {
    throw new Error("the CSR names do not match this office");
  }
  const csrKeyHash = await csrPublicKeyHash(opts.run, csrPath);

  const legoArgv = [
    opts.legoPath ?? "/usr/local/bin/lego",
    "run",
    "--path",
    opts.root,
    "--server",
    opts.target.caDirectory,
    "--email",
    opts.email,
    "--accept-tos",
    "--dns",
    "exec",
    "--csr",
    csrPath,
  ];
  const legoEnv = {
    EXEC_PATH: opts.dnsHookPath,
    ISOMUX_CF_API: opts.target.cloudflareBaseUrl,
    ISOMUX_CF_ZONE_ID: opts.target.zoneId,
    ISOMUX_CF_PRODUCTION_ZONE_ID: opts.target.productionZoneId,
    ISOMUX_CF_TOKEN: opts.cloudflareToken,
    ISOMUX_DNS_ALLOWED_FQDN: `_acme-challenge.${request.names[0]}`,
    LEGO_DISABLE_CNAME_SUPPORT: "true",
    ISOMUX_CERT_TARGET: opts.target.kind,
    ISOMUX_ACME_DIRECTORY: opts.target.caDirectory,
    ...(opts.target.kind === "production"
      ? { ISOMUX_CERTIFICATE_LIVE: "1" }
      : {}),
  };
  const runLego = async (force: boolean) => {
    const argv = force
      ? [...legoArgv.slice(0, 2), "--renew-force", ...legoArgv.slice(2)]
      : legoArgv;
    const result = await opts.run(argv, legoEnv);
    if (result.code !== 0)
      throw new Error(`lego failed: ${result.stderr.split("\n", 1)[0]}`);
  };
  await runLego(false);
  const certificateDir = join(opts.root, "certificates");
  const matchingCertificate = () => {
    const candidates = readdirSync(certificateDir).filter(
      (name) => name.endsWith(".crt") && !name.endsWith(".issuer.crt"),
    );
    const matching = candidates
      .map((name) => readFileSync(join(certificateDir, name), "utf8"))
      .filter((pem) => exactNames(namesInCertificate(pem), request.names));
    if (matching.length !== 1)
      throw new Error("lego did not produce one matching certificate chain");
    return matching[0];
  };

  let certificatePem = matchingCertificate();
  if (publicKeyHash(certificatePem) !== csrKeyHash) {
    await runLego(true);
    certificatePem = matchingCertificate();
    if (publicKeyHash(certificatePem) !== csrKeyHash) {
      throw new Error(
        "lego returned a certificate for a different private key",
      );
    }
  }
  return { certificatePem };
}
