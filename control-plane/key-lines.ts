export const MAX_CUSTOMER_SSH_KEY_LENGTH = 16_384;
const CUSTOMER_KEY_ALGORITHMS = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

export type CustomerSshKeyValidation =
  | { ok: true; normalized: string; algorithm: string; blob: string }
  | { ok: false; reason: string };

/** Customer keys forbid options; parseKeyLine below accepts our rewritten one. */
export function validateCustomerSshKey(raw: string): CustomerSshKeyValidation {
  if (raw.length > MAX_CUSTOMER_SSH_KEY_LENGTH)
    return { ok: false, reason: "the SSH public key is too long" };
  if (raw.includes("\r") || raw.includes("\n"))
    return {
      ok: false,
      reason: "enter exactly one SSH public key on one line",
    };
  const fields = raw.trim().split(/\s+/);
  if (fields.length < 2 || !CUSTOMER_KEY_ALGORITHMS.has(fields[0])) {
    return {
      ok: false,
      reason: "enter a supported SSH public key without options",
    };
  }
  const [algorithm, blob] = fields as [string, string];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob))
    return { ok: false, reason: "the SSH public key is not valid base64" };
  const decoded = Buffer.from(blob, "base64");
  if (
    decoded.toString("base64").replace(/=+$/, "") !== blob.replace(/=+$/, "")
  ) {
    return { ok: false, reason: "the SSH public key is not valid base64" };
  }
  if (decoded.length < 4)
    return { ok: false, reason: "the SSH public key data is incomplete" };
  const algorithmLength = decoded.readUInt32BE(0);
  if (algorithmLength < 1 || 4 + algorithmLength > decoded.length)
    return { ok: false, reason: "the SSH public key data is incomplete" };
  const encodedAlgorithm = decoded.subarray(4, 4 + algorithmLength).toString();
  if (encodedAlgorithm !== algorithm) {
    return {
      ok: false,
      reason: "the SSH public key type does not match its encoded data",
    };
  }
  return { ok: true, normalized: `${algorithm} ${blob}`, algorithm, blob };
}

/** Accept options because this parser reads our own expiry-rewritten line. */
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
