import type { RoomType } from "./types.ts";

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
export function roomSlotCount(room?: { type?: RoomType }): number {
  return room?.type === "lobby" ? 1 : DESK_COUNT;
}

export function isValidDesk(desk: number, room?: { type?: RoomType }): boolean {
  return Number.isInteger(desk) && desk >= 0 && desk < roomSlotCount(room);
}

// The back room: a second area of a room, on its own screen, that seats up to
// BACK_ROOM_SEATS agents at long tables. A back seat is stored in the same
// `desk` field as a front desk, from BACK_SEAT_BASE up.
//
// BACK_SEAT_BASE is a STORAGE FORMAT, not a layout value: it is a literal and
// must never follow DESK_SLOTS. If it did, a front layout with more or fewer
// slots would read every stored back seat as a different place.
export const BACK_SEAT_BASE = 8;
// The room is BACK_ROOM_MIN_SIDE x BACK_ROOM_MIN_SIDE seats at first and grows
// one table and one stool per table at a time, up to the max side.
export const BACK_ROOM_MIN_SIDE = 3;
export const BACK_ROOM_MAX_SIDE = 10;
export const BACK_ROOM_SEATS = BACK_ROOM_MAX_SIDE * BACK_ROOM_MAX_SIDE;

// A seat is (table, stool), numbered table * BACK_ROOM_MAX_SIDE + stool. The
// stride is the max side, not the current one, so growth (one more stool on
// every table, one more table) and shrinking never renumber a seat.
export interface BackSeat {
  table: number;
  stool: number;
}

export function isFrontDesk(desk: number, room?: { type?: RoomType }): boolean {
  return isValidDesk(desk, room);
}

export function isBackSeat(desk: number): boolean {
  return (
    Number.isInteger(desk) &&
    desk >= BACK_SEAT_BASE &&
    desk < BACK_SEAT_BASE + BACK_ROOM_SEATS
  );
}

export function backSeatOf(desk: number): BackSeat | null {
  if (!isBackSeat(desk)) return null;
  const seat = desk - BACK_SEAT_BASE;
  return {
    table: Math.floor(seat / BACK_ROOM_MAX_SIDE),
    stool: seat % BACK_ROOM_MAX_SIDE,
  };
}

export function deskOfBackSeat(seat: BackSeat): number {
  return BACK_SEAT_BASE + seat.table * BACK_ROOM_MAX_SIDE + seat.stool;
}

/** A place an agent can hold in this room: a front desk, or a back seat in
 *  any room but the lobby, which has no back room. */
export function isValidPlacement(
  desk: number,
  room?: { type?: RoomType },
): boolean {
  return (
    isValidDesk(desk, room) || (room?.type !== "lobby" && isBackSeat(desk))
  );
}

// The side of the square of seats the back room has now. It is derived from
// the seats in use, so it needs no stored state: at least the min side, wide
// enough for the outermost seat in use, and one more when every seat of that
// square is taken, so a free seat always exists until the max side is full.
// A ring only goes away when no one sits in it.
export function backRoomSide(desks: Iterable<number>): number {
  let extent = 0;
  let count = 0;
  for (const desk of desks) {
    const seat = backSeatOf(desk);
    if (!seat) continue;
    count++;
    extent = Math.max(extent, seat.table + 1, seat.stool + 1);
  }
  const side = Math.max(BACK_ROOM_MIN_SIDE, extent);
  return count >= side * side && side < BACK_ROOM_MAX_SIDE ? side + 1 : side;
}

/** The desk number of the seat a new back agent takes, or null when all
 *  BACK_ROOM_SEATS are in use. It is the first free seat of the smallest
 *  square that has one, so the inner seats fill first and the outer ring can
 *  empty again. Within a ring, seats go by table, then by stool. */
export function firstFreeBackSeat(desks: Iterable<number>): number | null {
  const taken = new Set(desks);
  const side = backRoomSide(taken);
  for (let ring = 0; ring < side; ring++) {
    for (let table = 0; table <= ring; table++) {
      for (let stool = 0; stool <= ring; stool++) {
        if (Math.max(table, stool) !== ring) continue;
        const desk = deskOfBackSeat({ table, stool });
        if (!taken.has(desk)) return desk;
      }
    }
  }
  return null;
}

// The server's error text for a spawn, move or revive into a full back room.
// English only, like the server's other error messages.
export const BACK_ROOM_FULL_MESSAGE = `The back room is full (${BACK_ROOM_SEATS} agents).`;
