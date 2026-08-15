"use client";

const KEY_TYPE = "ssh-ed25519";

function bytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function sshString(value: Uint8Array | string): Uint8Array {
  const body =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytes(uint32(body.length), body);
}

function base64Url(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(
    standard.padEnd(Math.ceil(standard.length / 4) * 4, "="),
  );
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface ServerAdministratorKey {
  privateKey: string;
  publicKey: string;
}

export function serializeOpenSshPrivateKey(
  seed: Uint8Array,
  publicBytes: Uint8Array,
  checkint: number,
): string {
  if (seed.length !== 32 || publicBytes.length !== 32)
    throw new Error("unexpected Ed25519 key shape");
  const publicBlob = bytes(sshString(KEY_TYPE), sshString(publicBytes));
  let privateSection = bytes(
    uint32(checkint),
    uint32(checkint),
    sshString(KEY_TYPE),
    sshString(publicBytes),
    sshString(bytes(seed, publicBytes)),
    sshString(""),
  );
  const paddingLength = 8 - (privateSection.length % 8 || 8);
  if (paddingLength > 0) {
    privateSection = bytes(
      privateSection,
      Uint8Array.from({ length: paddingLength }, (_, i) => i + 1),
    );
  }
  const container = bytes(
    new TextEncoder().encode("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(new Uint8Array()),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  );
  const encoded = base64(container);
  const lines = encoded.match(/.{1,70}/g) ?? [];
  return (
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    lines.join("\n") +
    "\n-----END OPENSSH PRIVATE KEY-----\n"
  );
}

export async function privateMatchesPublic(
  cryptoApi: Crypto,
  seed: Uint8Array,
  publicBytes: Uint8Array,
): Promise<boolean> {
  try {
    const privateKey = await cryptoApi.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        d: base64(seed)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
        x: base64(publicBytes)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      },
      "Ed25519",
      false,
      ["sign"],
    );
    const publicKey = await cryptoApi.subtle.importKey(
      "raw",
      new Uint8Array(publicBytes),
      "Ed25519",
      false,
      ["verify"],
    );
    const challenge = cryptoApi.getRandomValues(new Uint8Array(32));
    const signature = await cryptoApi.subtle.sign(
      "Ed25519",
      privateKey,
      challenge,
    );
    return await cryptoApi.subtle.verify(
      "Ed25519",
      publicKey,
      signature,
      challenge,
    );
  } catch {
    return false;
  }
}

export async function generateServerAdministratorKey(
  cryptoApi: Crypto = crypto,
): Promise<ServerAdministratorKey> {
  const pair = await cryptoApi.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const [privateJwk, rawPublic] = await Promise.all([
    cryptoApi.subtle.exportKey("jwk", pair.privateKey),
    cryptoApi.subtle.exportKey("raw", pair.publicKey),
  ]);
  if (!privateJwk.d || !privateJwk.x) throw new Error("incomplete Ed25519 key");
  const seed = base64Url(privateJwk.d);
  const jwkPublic = base64Url(privateJwk.x);
  const publicBytes = new Uint8Array(rawPublic);
  if (
    seed.length !== 32 ||
    jwkPublic.length !== 32 ||
    publicBytes.length !== 32 ||
    !jwkPublic.every((byte, i) => byte === publicBytes[i])
  ) {
    throw new Error("unexpected Ed25519 key shape");
  }

  const check = new Uint32Array(1);
  cryptoApi.getRandomValues(check);
  const privateKey = serializeOpenSshPrivateKey(seed, publicBytes, check[0]);
  if (!(await privateMatchesPublic(cryptoApi, seed, publicBytes))) {
    throw new Error("Ed25519 private and public keys do not match");
  }

  const publicBlob = bytes(sshString(KEY_TYPE), sshString(publicBytes));
  return {
    privateKey,
    publicKey: `${KEY_TYPE} ${base64(publicBlob)}`,
  };
}
