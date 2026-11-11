// The leave guard of the page on top (task c61316be): a page that can hold
// unsaved edits (Settings, the task board) registers how it leaves, so a
// click outside the page - the desktop sidebar's rows - goes through the
// page's own discard prompt instead of dropping the edits. App provides the
// slot and asks it before a sidebar row navigates.

import {
  createContext,
  useContext,
  useEffect,
  type MutableRefObject,
} from "react";

/** Runs `after` once the page may go: at once when nothing is unsaved, else
 *  after the member picks Discard in the page's prompt (never on Keep). */
export type LeaveGuard = (after: () => void) => void;

export const PageLeaveGuard =
  createContext<MutableRefObject<LeaveGuard | null> | null>(null);

/** Registers `guard` while the calling page is mounted. No deps on purpose:
 *  the guard reads the page's latest state, so it is set on every render. */
export function useLeaveGuard(guard: LeaveGuard): void {
  const slotRef = useContext(PageLeaveGuard);
  useEffect(() => {
    if (!slotRef) return;
    slotRef.current = guard;
    return () => {
      if (slotRef.current === guard) slotRef.current = null;
    };
  });
}
