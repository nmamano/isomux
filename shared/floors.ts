// Floors: other Isomux offices this office links to from the lobby elevator.
// The office stores them itself; a floor is only an origin and the name its
// office card gave when it was added.

export interface Floor {
  id: string;
  // The office's origin (scheme, host, port), never a path or credentials.
  url: string;
  name: string | null;
  addedAt: number;
}

// The public office card every office answers before the auth wall. An office
// checks it before it adds a floor.
export const OFFICE_CARD_PATH = "/.well-known/isomux-office";

export interface OfficeCard {
  isomux: 1;
  name: string | null;
}

export const MAX_FLOORS = 100;
export const MAX_FLOOR_URL_CHARS = 2048;
export const MAX_FLOOR_NAME_CHARS = 120;

// The address a member typed, as the origin of an http(s) URL. A bare host
// gets https://. Returns null for another scheme, userinfo, an over-long
// input or anything that does not parse.
export function normaliseFloorUrl(input: string): string | null {
  if (input.length > MAX_FLOOR_URL_CHARS) return null;
  const text = input.trim();
  if (!text) return null;
  // A scheme is a name and a colon NOT followed by a digit: "host:4000" is a
  // bare host with a port, though URL would read "host:" as its scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)
    ? text
    : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.origin;
}
