// One variable of a card set or removed, one request each (PUT/DELETE
// .../env/<name>), so no save can drop a value the page never read. The
// Variables tab and the OpenCode key on the Model providers tab write here.

import { apiFetch, ApiError } from "../api.ts";
import { basePath, type Target } from "./target.ts";

function envPath(target: Target, name: string): string {
  return `${basePath(target)}/env/${encodeURIComponent(name)}`;
}

// `note` undefined keeps the saved note; null clears it.
export async function putEnvVariable(
  target: Target,
  name: string,
  body: { value: string; note?: string | null },
): Promise<void> {
  await apiFetch("PUT", envPath(target, name), body);
}

export async function deleteEnvVariable(
  target: Target,
  name: string,
): Promise<void> {
  await apiFetch("DELETE", envPath(target, name));
}

// A variable route's refusal: the server's own sentence, else `fallback`.
export function envErrorText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError && caught.message
    ? caught.message
    : fallback;
}
