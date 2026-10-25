import { OPENCODE_CLI_VERSION } from "./runtime.ts";
import { openCodeAuthHeader } from "./server-startup.ts";

export const OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS = 2_000;

export interface OpenCodeServerEndpoint {
  port: number;
  password: string;
}

// "busy" is a health request that timed out. A busy server is alive: with 8
// sessions on one server, health took up to 3.7 s (measured 2026-10-07), and
// stopping it fails every turn in flight on it.
export type OpenCodeServerHealth = "healthy" | "busy" | "unreachable";

// GET /api/info (T8). Its ServerInfo has no "healthy" field: an answer with
// the pinned version is a healthy server.
export async function openCodeServerHealth(
  record: OpenCodeServerEndpoint,
): Promise<OpenCodeServerHealth> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/info`, {
      headers: { authorization: openCodeAuthHeader(record.password) },
      signal: AbortSignal.timeout(OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS),
    });
    const body = (await response.json()) as { version?: string };
    return response.ok && body.version === OPENCODE_CLI_VERSION
      ? "healthy"
      : "unreachable";
  } catch (error) {
    return (error as { name?: unknown } | null)?.name === "TimeoutError"
      ? "busy"
      : "unreachable";
  }
}
