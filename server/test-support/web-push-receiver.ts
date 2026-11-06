// The receiving browser of a Web Push test: a device's key pair and auth
// secret, and the receiver's half of RFC 8291 to read what a push carried.

import { expect } from "bun:test";
import type { PushPayload } from "../web-push-delivery.ts";
import { base64UrlEncode } from "../../shared/web-push.ts";

// A browser's side of a subscription: its key pair and auth secret.
export async function browserDevice(n: number) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw: raw,
    auth,
    input: {
      endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
      p256dh: base64UrlEncode(raw),
      auth: base64UrlEncode(auth),
      label: `Device ${n}`,
    },
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) {
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

// The receiver's half of RFC 8291, as a browser runs it.
export async function decrypt(
  body: Uint8Array<ArrayBuffer>,
  dev: Awaited<ReturnType<typeof browserDevice>>,
): Promise<PushPayload> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      dev.privateKey,
      256,
    ),
  );
  const enc = new TextEncoder();
  const info = new Uint8Array([
    ...enc.encode("WebPush: info\0"),
    ...dev.publicRaw,
    ...asPublic,
  ]);
  const ikm = await hkdf(dev.auth, ecdh, info, 32);
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
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
