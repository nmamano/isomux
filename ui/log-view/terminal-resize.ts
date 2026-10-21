// Tells the PTY the terminal size. A window drag fits xterm many times; each
// size sent to the PTY makes the shell redraw the line being typed, and a
// redraw for a width xterm has already left behind leaves a copy of that line
// in the scrollback. So the PTY gets one size after the drag settles.

export const PTY_RESIZE_SETTLE_MS = 150;

export interface PtyResizer {
  // Sends once, settleMs after the last request, and only when the size
  // differs from the last size sent.
  request(cols: number, rows: number): void;
  // Sends at once, even when the size equals the last size sent, and cancels
  // a pending request.
  now(cols: number, rows: number): void;
  // Cancels a pending request; nothing is sent after it.
  dispose(): void;
}

export function createPtyResizer(
  send: (cols: number, rows: number) => void,
  settleMs = PTY_RESIZE_SETTLE_MS,
): PtyResizer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = "";
  let disposed = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const sendSize = (cols: number, rows: number) => {
    last = `${cols}x${rows}`;
    send(cols, rows);
  };
  return {
    request(cols, rows) {
      if (disposed) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (`${cols}x${rows}` !== last) sendSize(cols, rows);
      }, settleMs);
    },
    now(cols, rows) {
      if (disposed) return;
      cancel();
      sendSize(cols, rows);
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
