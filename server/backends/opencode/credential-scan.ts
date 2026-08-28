export type CredentialCanary = {
  className: string;
  value: string;
};

export type CredentialCanaryHit = {
  className: string;
  path: string;
};

export const OC1_CREDENTIAL_CANARIES: CredentialCanary[] = [
  { className: "provider credential", value: "GATE_PROVIDER_SENTINEL" },
  { className: "V1 server password", value: "GATE_SERVER_PASSWORD_V1_SENTINEL" },
  { className: "V2 server password", value: "GATE_SERVER_PASSWORD_V2_SENTINEL" },
  { className: "provider response header", value: "GATE_HEADER_SECRET_SENTINEL" },
];

export function scanCredentialCanaries(
  files: ReadonlyArray<{ path: string; text: string }>,
  canaries: ReadonlyArray<CredentialCanary> = OC1_CREDENTIAL_CANARIES,
): CredentialCanaryHit[] {
  const hits: CredentialCanaryHit[] = [];
  for (const file of files) {
    for (const canary of canaries) {
      if (file.text.includes(canary.value)) {
        hits.push({ className: canary.className, path: file.path });
      }
    }
  }
  return hits;
}
