import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateServerAdministratorKey,
  privateMatchesPublic,
} from "./web/components/server-administrator-key.ts";

function decodeBase64Url(value: string): Uint8Array {
  return Buffer.from(value, "base64url");
}

describe("the browser-generated server administrator key", () => {
  test("OpenSSH accepts the empty-comment private key and derives the submitted public key", async () => {
    const generated = await generateServerAdministratorKey(crypto);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-admin-key-"));
    const file = path.join(dir, "id_ed25519");
    try {
      fs.writeFileSync(file, generated.privateKey, { mode: 0o600 });
      const derived = Bun.spawnSync(["ssh-keygen", "-y", "-f", file]);
      expect(derived.exitCode).toBe(0);
      expect(derived.stdout.toString().trim()).toBe(generated.publicKey);
      expect(generated.privateKey).toEndWith(
        "-----END OPENSSH PRIVATE KEY-----\n",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupted seed does not match the public half", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    if (!jwk.d || !jwk.x) throw new Error("missing test key bytes");
    const seed = decodeBase64Url(jwk.d);
    const publicBytes = decodeBase64Url(jwk.x);
    expect(await privateMatchesPublic(crypto, seed, publicBytes)).toBe(true);
    seed[0] ^= 1;
    expect(await privateMatchesPublic(crypto, seed, publicBytes)).toBe(false);
  });

  test("each generation creates a different public line", async () => {
    const first = await generateServerAdministratorKey(crypto);
    const second = await generateServerAdministratorKey(crypto);
    expect(second.publicKey).not.toBe(first.publicKey);
  });
});
