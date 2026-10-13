// The office CA and the leaf certificates of the secret proxy
// (internal-docs/secrets-design.md, section 2.3), written as DER with
// node:crypto. Bun has no X.509 writer, and the openssl CLI is not on every
// self-hosted path, so this module writes the few fixed shapes the proxy needs:
// an ECDSA P-256 CA, and leaves for one DNS name each.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

import { isNeverListed, isValidSecretHost } from "../../shared/secret-hosts.ts";

// --- DER ---

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const octets = (body: Buffer) => tlv(0x04, body);
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const explicit = (n: number, body: Buffer) => tlv(0xa0 + n, body);

function bitString(body: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), body]));
}

function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let body = bytes.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime through 2049, GeneralizedTime after (RFC 5280, 4.1.2.5).
function time(date: Date): Buffer {
  const iso = date.toISOString();
  const digits =
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    "Z";
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), "ascii"))
    : tlv(0x18, Buffer.from(digits, "ascii"));
}

// --- X.509 ---

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function name(commonName: string): Buffer {
  return seq(
    set(seq(oid("2.5.4.10"), utf8("Isomux"))),
    set(seq(oid("2.5.4.3"), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? seq(oid(id), bool(true), octets(value))
    : seq(oid(id), octets(value));
}

function spki(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" });
}

// The key identifier of RFC 5280 4.2.1.2 method 1: SHA-1 of the key bits.
function keyId(publicKey: KeyObject): Buffer {
  const der = spki(publicKey);
  // The subjectPublicKey BIT STRING is the last element of the SPKI.
  const bits = der.subarray(der.length - 65);
  return createHash("sha1").update(bits).digest();
}

function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return integer(bytes);
}

function certificate(input: {
  subject: Buffer;
  issuer: Buffer;
  publicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}): string {
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    serial(),
    ECDSA_WITH_SHA256,
    input.issuer,
    seq(time(input.notBefore), time(input.notAfter)),
    input.subject,
    spki(input.publicKey),
    explicit(3, seq(...input.extensions)),
  );
  const signature = sign("sha256", tbs, {
    key: input.signingKey,
    dsaEncoding: "der",
  });
  const der = seq(tbs, ECDSA_WITH_SHA256, bitString(signature));
  const base64 = der.toString("base64").replace(/.{64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${base64.replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}

// The subject name of every office CA. Root lists drop certificates with it
// (material.ts), so one office's CA never becomes another's trusted root.
export const OFFICE_CA_NAME = "Isomux office secret proxy CA";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface CertificateAuthority {
  certPem: string;
  keyPem: string;
}

// The office CA. Ten years; the key never leaves server state.
export function createCertificateAuthority(
  now: Date = new Date(),
): CertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const subject = name(OFFICE_CA_NAME);
  const certPem = certificate({
    subject,
    issuer: subject,
    publicKey,
    signingKey: privateKey,
    notBefore: new Date(now.getTime() - HOUR),
    notAfter: new Date(now.getTime() + 3650 * DAY),
    extensions: [
      // basicConstraints: CA, pathLen 0.
      extension("2.5.29.19", true, seq(bool(true), integer(Buffer.from([0])))),
      // keyUsage: keyCertSign and cRLSign (bits 5 and 6).
      extension("2.5.29.15", true, bitString(Buffer.from([0x06]), 1)),
      extension("2.5.29.14", false, octets(keyId(publicKey))),
    ],
  });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { certPem, keyPem };
}

export interface LeafIssuer {
  // A PEM certificate and its key, for one DNS name.
  issue(host: string): { certPem: string; keyPem: string };
}

export class LeafRefusedError extends Error {
  constructor() {
    super("the proxy does not issue a certificate for this host");
  }
}

// Leaves share one key per issuer. Each is valid for 30 days, from an hour
// back so a small clock skew does not reject it.
//
// The issuer itself refuses a never-listed host, a name that is not a valid
// secret host, and a name that `isListed` does not accept, so a caller's bug
// cannot make the office CA vouch for a model or registry host.
export function createLeafIssuer(
  ca: CertificateAuthority,
  isListed: (host: string) => boolean,
  now: () => Date = () => new Date(),
): LeafIssuer {
  const caKey = createPrivateKey(ca.keyPem);
  const caPublic = createPublicKey(caKey);
  const caName = name(OFFICE_CA_NAME);
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  return {
    issue(host) {
      if (!isValidSecretHost(host) || isNeverListed(host) || !isListed(host))
        throw new LeafRefusedError();
      const at = now();
      const certPem = certificate({
        subject: name(host),
        issuer: caName,
        publicKey,
        signingKey: caKey,
        notBefore: new Date(at.getTime() - HOUR),
        notAfter: new Date(at.getTime() + 30 * DAY),
        extensions: [
          extension("2.5.29.19", true, seq()),
          // keyUsage: digitalSignature (bit 0).
          extension("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)),
          // extKeyUsage: serverAuth.
          extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
          // subjectAltName: one dNSName.
          extension(
            "2.5.29.17",
            false,
            seq(tlv(0x82, Buffer.from(host, "ascii"))),
          ),
          extension("2.5.29.35", false, seq(tlv(0x80, keyId(caPublic)))),
          extension("2.5.29.14", false, octets(keyId(publicKey))),
        ],
      });
      return { certPem, keyPem };
    },
  };
}
