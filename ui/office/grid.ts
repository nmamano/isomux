// Isometric grid layout for 8 desks (2 columns x 4 rows)

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

export function isoXY(row: number, col: number) {
  const tw = 240,
    th = 140;
  return {
    x: (col - row) * (tw / 2),
    y: (col + row) * (th / 2),
  };
}
