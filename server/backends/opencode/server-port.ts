// The pinned CLI reports the address only after listen succeeds. Match its
// complete loopback line, not an arbitrary URL in provider or diagnostic output.
export function parseOpenCodeServerPort(stdout: string): number | null {
  const match =
    /(?:^|\n)opencode server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\r?\n/.exec(
      stdout,
    );
  if (!match) return null;
  const port = Number(match[1]);
  return port <= 65535 ? port : null;
}
