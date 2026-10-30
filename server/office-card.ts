// The public office card (shared/floors.ts OFFICE_CARD_PATH) and the probe
// another office runs against it before it adds a floor.
//
// The card is answered before the auth wall: it reads and sets no cookie, and
// its body is the office name the sign-in page title already shows. The probe
// sends no credentials, follows no redirect and reads a few KB at most; every
// failure is the same null, so a member learns one bit about one fixed path.

import {
  MAX_FLOOR_NAME_CHARS,
  OFFICE_CARD_PATH,
  type OfficeCard,
} from "../shared/floors.ts";

export const OFFICE_PROBE_TIMEOUT_MS = 8_000;
export const OFFICE_CARD_MAX_BYTES = 4096;

export function officeCardResponse(name: string | null): Response {
  const card: OfficeCard = { isomux: 1, name: name?.trim() || null };
  return new Response(JSON.stringify(card), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export interface OfficeProbeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// The office card at `origin`, or null when the address does not answer as an
// Isomux office. The timeout covers the whole read, body included. The name
// is trimmed, a blank one is null, and a long one is cut to
// MAX_FLOOR_NAME_CHARS.
export async function probeOffice(
  origin: string,
  opts: OfficeProbeOptions = {},
): Promise<OfficeCard | null> {
  const doFetch = opts.fetch ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, opts.timeoutMs ?? OFFICE_PROBE_TIMEOUT_MS);
  });
  const read = async (): Promise<OfficeCard | null> => {
    const res = await doFetch(origin + OFFICE_CARD_PATH, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status !== 200 || !res.body) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res.body, OFFICE_CARD_MAX_BYTES);
    return text === null ? null : parseCard(text);
  };
  try {
    return await Promise.race([read().catch(() => null), timedOut]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// The body as text, or null when it passes `max` bytes.
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseCard(text: string): OfficeCard | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { isomux, name } = raw as Record<string, unknown>;
  if (isomux !== 1) return null;
  if (name === null) return { isomux: 1, name: null };
  if (typeof name !== "string") return null;
  return { isomux: 1, name: cutName(name.trim()) || null };
}

// At most MAX_FLOOR_NAME_CHARS UTF-16 units, never half a surrogate pair.
function cutName(name: string): string {
  if (name.length <= MAX_FLOOR_NAME_CHARS) return name;
  let cut = name.slice(0, MAX_FLOOR_NAME_CHARS);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
