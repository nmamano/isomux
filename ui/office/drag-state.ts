// The desk index being dragged, shared across desk components. HTML5 drag is
// a singleton interaction and dataTransfer payloads are unreadable during
// dragover/dragenter, so drop targets read the source desk here to decide
// whether feedback applies (e.g. no SWAP badge over the agent's own desk).
let draggedDesk: number | null = null;
const listeners = new Set<() => void>();

export function setDraggedDesk(desk: number | null): void {
  if (desk === draggedDesk) return;
  draggedDesk = desk;
  for (const listener of listeners) listener();
}

export function getDraggedDesk(): number | null {
  return draggedDesk;
}

export function subscribeDraggedDesk(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
