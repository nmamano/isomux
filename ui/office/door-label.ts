// A door's room-name label, wrapped into lines centred over the door. Each
// line is at most DOOR_LABEL_WIDTH wide, so it never runs off the wall end.
// The label shrinks down to DOOR_LABEL_MIN_SIZE so that its widest word fits;
// a word too wide even then breaks by code points. Past DOOR_LABEL_MAX_LINES
// the last line ends in an ellipsis. The door's title and aria-label keep the
// full name.

export const DOOR_LABEL_SIZE = 12;
export const DOOR_LABEL_MIN_SIZE = 10;
/** The widest line: the door's width plus a small margin. */
export const DOOR_LABEL_WIDTH = 72;
export const DOOR_LABEL_MAX_LINES = 3;

// Room names have no length cap, and in WallDoor each measure is a DOM write
// and a layout. Only this many leading code points are fitted, far more than
// three lines can show; a label cut here always ends in an ellipsis.
const DOOR_LABEL_MAX_CODE_POINTS = 120;
// A word that sets the size measures exactly a line at that size, give or
// take float rounding.
const FIT_EPSILON = 1e-9;

export interface DoorLabelFit {
  lines: string[];
  size: number;
}

/**
 * `measure(text)` is the drawn width of `text` at DOOR_LABEL_SIZE.
 */
export function fitDoorLabel(
  label: string,
  measure: (text: string) => number,
): DoorLabelFit {
  const trimmed = label.trim();
  const head: string[] = [];
  for (const cp of trimmed) {
    if (head.length === DOOR_LABEL_MAX_CODE_POINTS) break;
    head.push(cp);
  }
  const cutShort = head.join("").length < trimmed.length;
  const words = head
    .join("")
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return { lines: [], size: DOOR_LABEL_SIZE };

  const widths = new Map<string, number>();
  const width = (text: string) => {
    let w = widths.get(text);
    if (w === undefined) {
      w = measure(text);
      widths.set(text, w);
    }
    return w;
  };
  const widest = Math.max(...words.map(width));
  const size = Math.max(
    DOOR_LABEL_MIN_SIZE,
    Math.min(DOOR_LABEL_SIZE, (DOOR_LABEL_SIZE * DOOR_LABEL_WIDTH) / widest),
  );
  // The widest line, measured at DOOR_LABEL_SIZE.
  const limit = (DOOR_LABEL_WIDTH * DOOR_LABEL_SIZE) / size;
  const fits = (text: string) => width(text) <= limit + FIT_EPSILON;

  // Lines are spans [start, end) of code points of the words joined by
  // single spaces. The wrap stops as soon as a line past the limit starts.
  const cps = [...words.join(" ")];
  const text = (start: number, end: number) => cps.slice(start, end).join("");
  const lines: [number, number][] = [];
  let line: [number, number] | null = null;
  const full = () => lines.length === DOOR_LABEL_MAX_LINES;
  let at = 0;
  for (const word of words) {
    const start = at;
    const end = start + [...word].length;
    at = end + 1;
    if (fits(word)) {
      if (line && fits(text(line[0], end))) {
        line[1] = end;
        continue;
      }
      if (line) lines.push(line);
      if (full()) break;
      line = [start, end];
      continue;
    }
    // Too wide even at the minimum size: break it into pieces that each
    // fill a line. The last piece is a word like any other.
    if (line) lines.push(line);
    line = null;
    let piece = start;
    while (!full() && !fits(text(piece, end))) {
      let stop = piece + 1;
      while (stop < end && fits(text(piece, stop + 1))) stop++;
      lines.push([piece, stop]);
      piece = stop;
    }
    line = [piece, end];
    if (full()) break;
  }
  const overflow = full() && (line !== null || at < cps.length);
  if (line && !full()) lines.push(line);
  if (!overflow && !cutShort) {
    return { lines: lines.map(([s, e]) => text(s, e)), size };
  }

  // The last line is the rest of the text, cut to the longest start that
  // fits with an ellipsis.
  const rest = lines.pop()![0];
  let stop = rest;
  while (stop < cps.length && fits(`${text(rest, stop + 1)}…`)) stop++;
  return {
    lines: [
      ...lines.map(([s, e]) => text(s, e)),
      `${text(rest, stop).trimEnd()}…`,
    ],
    size,
  };
}
