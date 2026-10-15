// Web Push encryption and VAPID (server/web-push-crypto.ts).
//
// Pins: the aes128gcm body for the RFC 8291 Appendix A inputs is the RFC's
// result byte for byte; a VAPID JWT verifies with the public key in its
// header and carries the push service's origin, a future expiry and the
// subject; a payload too large for one record is refused.

import { describe, it, expect } from "bun:test";
import {
  encryptPushPayload,
  generateVapidKeys,
  isP256PublicKey,
  vapidAuthorization,
} from "./web-push-crypto.ts";
import { base64UrlDecode, base64UrlEncode } from "../shared/web-push.ts";

// RFC 8291, section 5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const ENDPOINT = "https://web.push.apple.com/QGuQyavXutnMH8Ac8ZyO1M3d";

describe("encryptPushPayload", () => {
  it("matches the RFC 8291 Appendix A result", async () => {
    const body = await encryptPushPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      {
        salt: base64UrlDecode(RFC.salt)!,
        senderPublic: RFC.asPublic,
        senderPrivate: RFC.asPrivate,
      },
    );
    expect(
      Buffer.from(body).equals(Buffer.from(base64UrlDecode(RFC.result)!)),
    ).toBe(true);
  });

  it("uses a fresh salt and sender key for each message", async () => {
    const sub = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const payload = new TextEncoder().encode(RFC.plaintext);
    const a = await encryptPushPayload(payload, sub);
    const b = await encryptPushPayload(payload, sub);
    // salt (16) and the sender key (65 after 5 header bytes) differ.
    expect(
      Buffer.from(a.slice(0, 16)).equals(Buffer.from(b.slice(0, 16))),
    ).toBe(false);
    expect(
      Buffer.from(a.slice(21, 86)).equals(Buffer.from(b.slice(21, 86))),
    ).toBe(false);
  });

  it("refuses a payload that does not fit one record", async () => {
    let err: unknown = null;
    try {
      await encryptPushPayload(new Uint8Array(4000), {
        p256dh: RFC.uaPublic,
        auth: RFC.auth,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

describe("isP256PublicKey", () => {
  it("accepts a curve point and refuses a 65-byte value off the curve", async () => {
    expect(await isP256PublicKey(RFC.uaPublic)).toBe(true);
    const off = base64UrlDecode(RFC.uaPublic)!;
    off[64] ^= 1;
    expect(await isP256PublicKey(base64UrlEncode(off))).toBe(false);
  });
});

describe("vapidAuthorization", () => {
  it("signs a JWT that verifies with the public key it names", async () => {
    const keys = await generateVapidKeys();
    const now = Date.UTC(2026, 9, 15, 12, 0, 0);
    const header = await vapidAuthorization(
      ENDPOINT,
      keys,
      "https://office.example.com",
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, sig, k] = match!;
    expect(k).toBe(keys.publicKey);

    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(k)!,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(`${h}.${c}`);
    const verify = (data: Uint8Array<ArrayBuffer>) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        base64UrlDecode(sig)!,
        data,
      );
    expect(await verify(signed)).toBe(true);
    // The same signature over other claims fails: the check is real.
    const tampered = new TextEncoder().encode(`${h}.${c}x`);
    expect(await verify(tampered)).toBe(false);

    const decode = (part: string) =>
      JSON.parse(new TextDecoder().decode(base64UrlDecode(part)!));
    expect(decode(h)).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = decode(c);
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe("https://office.example.com");
    // RFC 8292: in the future, at most 24 hours ahead.
    expect(claims.exp).toBeGreaterThan(now / 1000);
    expect(claims.exp).toBeLessThanOrEqual(now / 1000 + 24 * 60 * 60);
  });

  it("does not verify with another key pair", async () => {
    const keys = await generateVapidKeys();
    const other = await generateVapidKeys();
    const header = await vapidAuthorization(ENDPOINT, keys, "mailto:a@b.c", 0);
    const [, h, c, sig] = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=/.exec(
      header,
    )!;
    const wrong = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(other.publicKey)!,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        wrong,
        base64UrlDecode(sig)!,
        new TextEncoder().encode(`${h}.${c}`),
      ),
    ).toBe(false);
  });
});
