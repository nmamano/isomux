/** Measured ladder and timing rationale: internal-docs/browser-panel-bandwidth.md.
 * Capture is shared. BrowserPool chooses the best demand among its watchers. */
export const BROWSER_CAPTURE_STEPS = [
  { quality: 50, scale: 1 },
  { quality: 30, scale: 1 },
  { quality: 20, scale: 1 },
  { quality: 20, scale: 0.75 },
  { quality: 20, scale: 0.5 },
] as const;

export class BrowserStreamPressure {
  level = 0;
  private direction = 0;
  private since = 0;

  /** Sampled every 250 ms, including quiet pages and drains. A full-frame
   * buffer needs 2 s of continuous pressure; recovery needs 8 s below a
   * quarter frame. The middle band resets dwell instead of changing quality. */
  sample(buffered: number, frameBytes: number, now: number): boolean {
    const direction =
      buffered > frameBytes ? 1 : buffered <= frameBytes / 4 ? -1 : 0;
    if (direction !== this.direction) {
      this.direction = direction;
      this.since = now;
    }
    if (!direction || now - this.since < (direction > 0 ? 2000 : 8000))
      return false;
    this.since = now;
    const next = Math.max(
      0,
      Math.min(BROWSER_CAPTURE_STEPS.length - 1, this.level + direction),
    );
    if (next === this.level) return false;
    this.level = next;
    return true;
  }
}
