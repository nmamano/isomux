/** The largest setup-access window any new instance may originate. */
export const ACCESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Parse the operator CLI's explicit window without letting it exceed policy. */
export function accessWindowDurationMs(raw: string): number {
  const m = /^(\d+)([mhd])$/.exec(raw);
  if (!m) throw new Error(`must look like 90m, 2h or 3d (got ${raw})`);
  const n = Number(m[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  if (!unitMs) throw new Error(`has an unknown unit (got ${raw})`);
  const duration = n * unitMs;
  if (duration <= 0) throw new Error("must be greater than zero");
  if (duration > ACCESS_WINDOW_MS) {
    throw new Error("cannot exceed the seven-day setup-access limit");
  }
  return duration;
}
