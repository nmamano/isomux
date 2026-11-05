// The JSON rules of a messaging delivery block (WhatsApp and Discord): the
// JSON escapes <, > and &, so the block has exactly one opening and one
// closing tag, and a text that does not fit is cut a whole code point at a
// time, with a marker.

const ANGLE_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

// JSON with every <, > and & as a \u escape: still valid, with the same values.
export function escapedJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (c) => ANGLE_ESCAPES[c]);
}

// The escaped length of a string between its quotes.
export function escapedLength(text: string): number {
  return escapedJson(text).length - 2;
}

export const CUT_MARKER = "…[cut]";
const MARKER_COST = escapedLength(CUT_MARKER);

// The longest whole-code-point prefix whose escaped text, with the marker,
// fits `share`.
export function cutTo(text: string, share: number): string {
  let used = MARKER_COST;
  let units = 0;
  for (const codePoint of text) {
    used += escapedLength(codePoint);
    if (used > share) break;
    units += codePoint.length;
  }
  return text.slice(0, units) + CUT_MARKER;
}
