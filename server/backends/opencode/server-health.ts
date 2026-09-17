import { OPENCODE_CLI_VERSION } from "./runtime.ts";

export const OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS = 2_000;

export interface OpenCodeServerEndpoint {
  port: number;
  password: string;
}

export async function openCodeServerIsHealthy(
  record: OpenCodeServerEndpoint,
): Promise<boolean> {
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
    return (
      response.ok &&
      body.healthy === true &&
      body.version === OPENCODE_CLI_VERSION
    );
  } catch {
    return false;
  }
}
