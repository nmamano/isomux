// Every request and handshake has its own deadline, so a stalled office fails
// the step that waited on it instead of the whole job's timeout.
export const REQUEST_TIMEOUT_MS = 30_000;

// fetch with a deadline that names what timed out.
export async function request(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(`${what} did not answer within ${timeoutMs / 1000}s`, { cause: error });
    throw error;
  }
}
