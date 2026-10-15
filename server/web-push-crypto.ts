// Web Push message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// on WebCrypto. No npm dependency: web-push-crypto.test.ts checks the encryption
// against the RFC 8291 Appendix A vector and verifies a JWT signature.
//
// LEAF: imports only shared helpers.

import { base64UrlDecode, base64UrlEncode } from "../shared/web-push.ts";

export interface VapidKeys {
  // Uncompressed P-256 point (65 bytes), base64url.
  publicKey: string;
  // The private scalar d (32 bytes), base64url.
  privateKey: string;
}

// A record holds one message: the payload must stay under this size.
const RECORD_SIZE = 4096;
// RFC 8292: a JWT lives at most 24 hours.
const JWT_LIFETIME_S = 12 * 60 * 60;

const enc = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function mustDecode(text: string): Bytes {
  const bytes = base64UrlDecode(text);
  if (!bytes) throw new Error("not base64url");
  return bytes;
}

// A JWK for a P-256 key from its raw public point and, optionally, d.
function p256Jwk(publicKey: Bytes, d?: string): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error("not an uncompressed P-256 point");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    ...(d ? { d } : {}),
    ext: true,
  };
}

// A device key the encryption can use: a point on the P-256 curve. The
// length and prefix checks at save time do not prove that.
export async function isP256PublicKey(text: string): Promise<boolean> {
  const raw = base64UrlDecode(text);
  if (!raw) return false;
  try {
    await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return true;
  } catch {
    return false;
  }
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64UrlEncode(raw), privateKey: jwk.d! };
}

// The Authorization header value for one push service.
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
): Promise<string> {
  const header = base64UrlEncode(
    enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = base64UrlEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S,
        sub: subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(mustDecode(keys.publicKey), keys.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto returns r || s, which is the JWS ES256 form.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(`${header}.${claims}`),
    ),
  );
  return `vapid t=${header}.${claims}.${base64UrlEncode(sig)}, k=${keys.publicKey}`;
}

async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
}

// Tests pass the RFC's sender key pair and salt; a send makes fresh ones.
export interface EncryptFixed {
  salt: Bytes;
  // Raw public point and private d, base64url.
  senderPublic: string;
  senderPrivate: string;
}

// The aes128gcm body for one subscription: header || ciphertext, in one
// record. Throws when the keys are malformed or the payload is too large.
export async function encryptPushPayload(
  payload: Bytes,
  subscription: { p256dh: string; auth: string },
  fixed?: EncryptFixed,
): Promise<Bytes> {
  // 86-byte header, 16-byte tag, 1 delimiter byte.
  if (payload.length > RECORD_SIZE - 86 - 16 - 1) {
    throw new Error("payload too large");
  }
  const uaPublic = mustDecode(subscription.p256dh);
  const authSecret = mustDecode(subscription.auth);
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  let asPublic: Bytes;
  let asPrivate: CryptoKey;
  if (fixed) {
    asPublic = mustDecode(fixed.senderPublic);
    asPrivate = await crypto.subtle.importKey(
      "jwk",
      p256Jwk(asPublic, fixed.senderPrivate),
      ecdh,
      false,
      ["deriveBits"],
    );
  } else {
    const pair = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
    asPublic = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    asPrivate = pair.privateKey;
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(uaPublic),
    ecdh,
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      asPrivate,
      256,
    ),
  );
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      concat(payload, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}
