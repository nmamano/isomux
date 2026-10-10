import { stripVTControlCharacters } from "node:util";
import { credentialValues, redactCredentialShapes, redactForTranscript, redactValues } from "./report.ts";

export interface FailureEvidence {
  step: string;
  exit: number | null;
  logTail: string;
}

/** Redact before any cut: truncation can turn a credential into an unknown shape. */
export function diagnosticText(text: string, secrets: readonly string[] = []): string {
  return redactCredentialShapes(redactForTranscript(redactValues(
    stripVTControlCharacters(text), [...credentialValues(process.env), ...secrets],
  )))
    // A tail can begin inside a PEM block. Also cover generated base64url tokens
    // without relying on a random token containing all three character classes.
    .replace(/[A-Za-z0-9_+/=-]{43,}/g, "<redacted>")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => c === "\n" ? c : "");
}

function bytes(text: string, limit: number): string {
  let out = "";
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > limit) break;
    out += char;
  }
  return out;
}

export function failureEvidence(step: string, exit: number | null, text: string, secrets: readonly string[] = []): FailureEvidence {
  const lines = diagnosticText(text, secrets).trimEnd().split("\n").slice(-40)
    .map((line) => bytes(line, 512));
  while (Buffer.byteLength(lines.join("\n")) > 8192) lines.shift();
  return { step: bytes(diagnosticText(step, secrets), 512), exit, logTail: lines.join("\n") };
}

/** Only completed, distinct generations count; a crash has no known exit. */
export function repeatedInstallerFailure(evidence: unknown): boolean {
  const attempts = (evidence as { attempts?: unknown[] } | null)?.attempts;
  if (!Array.isArray(attempts) || attempts.length < 3) return false;
  const last = attempts.slice(-3) as { runId?: unknown; verdict?: unknown; step?: unknown }[];
  if (!last.every((a) => a && typeof a.runId === "string" && a.runId.length > 0 &&
    typeof a.step === "string" && typeof a.verdict === "string" && /^exit [1-9]\d*$/.test(a.verdict))) return false;
  return new Set(last.map((a) => a.runId)).size === 3 &&
    last.every((a) => a.step === last[0].step && a.verdict === last[0].verdict);
}

export const REPEATED_INSTALLER_FAILURE_REASON = "run_installer failed at the same step with the same exit in three consecutive runs";
