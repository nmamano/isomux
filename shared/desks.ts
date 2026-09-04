// The desk grid every room is laid out on: 8 slots, 2 columns x 4 rows.
//
// The row/col pairs only mean something to the UI renderer, but the LENGTH of
// this list is a domain invariant - OfficeState assigns and validates desk
// indices against it - so the list lives in shared/ and the UI imports it from
// here. Never the reverse: shared/ must not import UI.

export const DESK_SLOTS = [
  { row: 0, col: 0 },
  { row: 0, col: 1 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
  { row: 2, col: 0 },
  { row: 2, col: 1 },
  { row: 3, col: 0 },
  { row: 3, col: 1 },
];

export const DESK_COUNT = DESK_SLOTS.length;

// A desk index is valid iff it names one of the slots above. Fractional and
// negative indices are rejected explicitly: -1 doubles as OfficeState's
// "no free desk" sentinel, and any out-of-range index names a desk that has no
// place to be drawn.
export function isValidDesk(desk: number): boolean {
  return Number.isInteger(desk) && desk >= 0 && desk < DESK_COUNT;
}
