// True while a desk is being dragged anywhere in the office. HTML5 drag events
// bubble to the document, and DeskUnit records the dragged desk.

import { useEffect, useState } from "react";
import { getDraggedDesk } from "./drag-state.ts";

export function useDeskDrag(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = () =>
      // DeskUnit sets the dragged desk in its own dragstart handler, which
      // runs before this document listener.
      setDragging(getDraggedDesk() !== null);
    const end = () => setDragging(false);
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  return dragging;
}
