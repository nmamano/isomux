// The "are you sure?" step of a destructive action that has no Undo (AGENTS.md
// "UI rules"): the first activation arms the control, which then reads
// "Confirm?"; a second activation runs the action. A blur or Escape ends it.
// One hook serves a list: each control has a stable key (a token id, a route
// id), and one key is armed at a time.

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export interface ConfirmBindings {
  ref: (el: HTMLElement | null) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  "data-confirm-armed"?: "";
}

export interface ConfirmStep {
  // The key of the armed control, or null.
  armed: string | null;
  // The first call arms `key`; a second call with the same key disarms and
  // runs `action`.
  confirm(key: string, action: () => void): void;
  // Props for the control with this key.
  bind(key: string): ConfirmBindings;
}

export function useConfirmStep(): ConfirmStep {
  const [armed, setArmed] = useState<string | null>(null);
  const controls = useRef(new Map<string, HTMLElement>());

  // The armed control takes the focus, so the blur that ends it comes in
  // every browser: Chrome drops the focus of a button disabled during an
  // await with no blur, and Safari does not focus a clicked button.
  useEffect(() => {
    if (armed !== null)
      controls.current.get(armed)?.focus({ preventScroll: true });
  }, [armed]);

  const confirm = useCallback(
    (key: string, action: () => void) => {
      if (armed !== key) {
        setArmed(key);
        return;
      }
      setArmed(null);
      action();
    },
    [armed],
  );

  const bind = (key: string): ConfirmBindings => ({
    ref: (el) => {
      if (el) controls.current.set(key, el);
      else controls.current.delete(key);
    },
    onBlur: () => setArmed((a) => (a === key ? null : a)),
    onKeyDown: (e) => {
      if (e.key !== "Escape" || armed !== key) return;
      // The container (a dialog, a page) does not close as well.
      e.stopPropagation();
      setArmed(null);
    },
    // Keep the focus on the armed control: Safari clears the focus on a
    // mousedown on a button, and that blur would end the confirm before the
    // second click lands.
    onMouseDown: (e) => {
      if (armed === key) e.preventDefault();
    },
    ...(armed === key ? { "data-confirm-armed": "" as const } : {}),
  });

  return { armed, confirm, bind };
}

// Whether the focused control is an armed confirm step. A container's
// capture Escape listener stands down for it, so Escape ends the confirm
// instead of closing the container.
export function isConfirmArmed(): boolean {
  return document.activeElement?.closest("[data-confirm-armed]") != null;
}
