// The desk index being dragged, shared across desk components. HTML5 drag is
// a singleton interaction and dataTransfer payloads are unreadable during
// dragover/dragenter, so drop targets read the source desk here to decide
// whether feedback applies (e.g. no SWAP badge over the agent's own desk).
let draggedDesk: number | null = null;

export function setDraggedDesk(desk: number | null): void {
  draggedDesk = desk;
}

export function getDraggedDesk(): number | null {
  return draggedDesk;
}
