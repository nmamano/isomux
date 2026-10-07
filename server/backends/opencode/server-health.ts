import { OPENCODE_CLI_VERSION } from "./runtime.ts";

export const OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS = 2_000;

export interface OpenCodeServerEndpoint {
  port: number;
  password: string;
}

// "busy" is a health request that timed out. A busy server is alive: with 8
// sessions on one server, health took up to 3.7 s (measured 2026-10-07), and
// stopping it fails every turn in flight on it.
export type OpenCodeServerHealth = "healthy" | "busy" | "unreachable";

export async function openCodeServerHealth(
  record: OpenCodeServerEndpoint,
): Promise<OpenCodeServerHealth> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/global/health`,
      {
        headers: {
          authorization: `Basic ${btoa(`isomux:${record.password}`)}`,
        },
        signal: AbortSignal.timeout(OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as {
      healthy?: boolean;
      version?: string;
    };
    return response.ok &&
      body.healthy === true &&
      body.version === OPENCODE_CLI_VERSION
      ? "healthy"
      : "unreachable";
  } catch (error) {
    return (error as { name?: unknown } | null)?.name === "TimeoutError"
      ? "busy"
      : "unreachable";
  }
}
