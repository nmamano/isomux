export function createTerminalFinalizer({
  isCurrent,
  detach,
  emitExit,
}: {
  isCurrent: () => boolean;
  detach: () => void;
  emitExit: (exitCode: number) => void;
}): (exitCode: number) => void {
  let finalized = false;
  return (exitCode) => {
    if (finalized) return;
    finalized = true;
    if (!isCurrent()) return;
    detach();
    emitExit(exitCode);
  };
}
