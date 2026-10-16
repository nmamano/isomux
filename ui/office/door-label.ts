// A door's room-name label, fitted to the wall it hangs on. Each door stands
// DOOR_LABEL_END from the end of its wall, so a centred label wider than
// twice that runs off the wall. A longer label keeps its outer end at the
// wall end and runs along the wall towards the corner, shrinks down to
// DOOR_LABEL_MIN_SIZE, and past DOOR_LABEL_MAX_WIDTH ends in an ellipsis.
// The door's title and aria-label keep the full name.

export const DOOR_LABEL_SIZE = 12;
export const DOOR_LABEL_MIN_SIZE = 10;
/** From the door's centre to the end of its wall, less a small margin. */
export const DOOR_LABEL_END = 36;
export const DOOR_LABEL_MAX_WIDTH = 140;

export interface DoorLabelFit {
  text: string;
  size: number;
  /** False: centred on the door. True: outer end at the wall end. */
  atWallEnd: boolean;
}

/**
 * `prefixWidth(n)` is the drawn width of the label's first n UTF-16 units at
 * DOOR_LABEL_SIZE; `ellipsisWidth` is the width of "…" at that size.
 */
export function fitDoorLabel(
  label: string,
  prefixWidth: (n: number) => number,
  ellipsisWidth: number,
): DoorLabelFit {
  const width = prefixWidth(label.length);
  if (width <= 2 * DOOR_LABEL_END) {
    return { text: label, size: DOOR_LABEL_SIZE, atWallEnd: false };
  }
  const shrunk = (DOOR_LABEL_SIZE * DOOR_LABEL_MAX_WIDTH) / width;
  if (shrunk >= DOOR_LABEL_MIN_SIZE) {
    return {
      text: label,
      size: Math.min(DOOR_LABEL_SIZE, shrunk),
      atWallEnd: true,
    };
  }
  const scale = DOOR_LABEL_MIN_SIZE / DOOR_LABEL_SIZE;
  let n = label.length - 1;
  while (
    n > 0 &&
    (prefixWidth(n) + ellipsisWidth) * scale > DOOR_LABEL_MAX_WIDTH
  )
    n--;
  // Never cut a surrogate pair in half.
  const code = label.charCodeAt(n - 1);
  if (n > 0 && code >= 0xd800 && code <= 0xdbff) n--;
  return {
    text: `${label.slice(0, n).trimEnd()}…`,
    size: DOOR_LABEL_MIN_SIZE,
    atWallEnd: true,
  };
}
