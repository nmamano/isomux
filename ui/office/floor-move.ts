// The floor move when a member goes down the trap door to the back room or
// up its ladder to the front (task c996e4a9). Other routes between the two
// (the Back button, a tab, a key) switch with no animation. It lasts
// FLOOR_MOVE_MS; a member who asks for reduced motion gets a plain switch.
//
// At the click the old view (the child of the floor marked data-floor-view)
// is snapshotted and the switch dispatches at once. After React commits, the
// copy moves out of the floor's box while the live new view, which stays
// hit-testable, moves in from the other side: down through the hatch the
// camera descends, so both move up; up the ladder, both move down.

import { cancelRoomTurn, ease, snapshot } from "./room-turn.ts";

export type FloorDir = "down" | "up";

export const FLOOR_MOVE_MS = 600;

interface Job {
  floorEl: HTMLElement;
  dir: FloorDir;
  roomId: string | null;
  from: HTMLElement;
}

// A click's snapshot waits in `pending` until its target commits, and only
// until the next frame: React commits a click's update before that frame, so
// a click that changed nothing leaves no stale snapshot behind. Then the move
// is `running` until it ends or is cancelled.
let pending: Job | null = null;
let expiry = 0;
let running: {
  roomId: string | null;
  back: boolean;
  cancel: () => void;
} | null = null;

function liveView(floorEl: HTMLElement): HTMLElement | null {
  return floorEl.querySelector<HTMLElement>(":scope > [data-floor-view]");
}

function reducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function dropPending() {
  pending = null;
  if (expiry) cancelAnimationFrame(expiry);
  expiry = 0;
}

/** Ends a pending or running move and leaves only the live view. */
export function cancelFloorMove(): void {
  dropPending();
  running?.cancel();
  running = null;
}

/** Call from a hatch or ladder click, BEFORE the switch dispatches. floorEl
 * holds the live view, the child marked data-floor-view; roomId is the
 * current room. */
export function beginFloorMove(
  floorEl: HTMLElement | null,
  dir: FloorDir,
  roomId: string | null,
): void {
  // A door turn in flight would leave its copies in the snapshot.
  cancelRoomTurn();
  cancelFloorMove();
  const view = floorEl && liveView(floorEl);
  if (!floorEl || !view || reducedMotion()) return;
  const from = snapshot(view, "__floorA");
  from.removeAttribute("data-floor-view");
  // The copy keeps the old view's place and size in the floor.
  Object.assign(from.style, {
    position: "absolute",
    left: `${view.offsetLeft}px`,
    top: `${view.offsetTop}px`,
    width: `${view.offsetWidth}px`,
    height: `${view.offsetHeight}px`,
    margin: "0",
  });
  pending = { floorEl, dir, roomId, from };
  expiry = requestAnimationFrame(() => {
    expiry = 0;
    pending = null;
  });
}

/** Call from a layout effect on every change of room, lobby or side; roomId
 * is null when the lobby is open. A commit to anything but the click's
 * target ends the move and starts none. */
export function finishFloorMove(
  roomId: string | null,
  backShown: boolean,
): void {
  const job = pending;
  dropPending();
  const back = job?.dir === "down";
  if (!job || job.roomId !== roomId || back !== backShown) {
    if (running && (running.roomId !== roomId || running.back !== backShown))
      cancelFloorMove();
    return;
  }
  running?.cancel();
  const view = liveView(job.floorEl);
  if (!view) {
    running = null;
    return;
  }
  runMove(job, view);
}

function runMove({ floorEl, dir, roomId, from }: Job, view: HTMLElement) {
  // One host clips the copy to the floor's box. It sits right after the live
  // view, so later siblings (the members chat) still paint over it.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  host.append(from);
  view.after(host);

  const h = floorEl.clientHeight || view.offsetHeight;
  // The camera moves down through the hatch: the scene moves up.
  const sign = dir === "down" ? -1 : 1;
  const frame = (p: number) => {
    const e = ease(p);
    from.style.translate = `0px ${sign * h * e}px`;
    const live = -sign * h * (1 - e);
    view.style.translate = `0px ${live}px`;
    // The floor does not clip: the live view clips the part that has not
    // come into the floor's box yet.
    view.style.clipPath =
      live > 0
        ? `inset(0px 0px ${live}px 0px)`
        : `inset(${-live}px 0px 0px 0px)`;
  };
  frame(0);

  let t0: number | null = null;
  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    host.remove();
    view.style.translate = "";
    view.style.clipPath = "";
  };
  const tick = (now: number) => {
    t0 ??= now;
    const p = Math.min(1, (now - t0) / FLOOR_MOVE_MS);
    frame(p);
    if (p < 1) raf = requestAnimationFrame(tick);
    else {
      cleanup();
      running = null;
    }
  };
  raf = requestAnimationFrame(tick);
  running = { roomId, back: dir === "down", cancel: cleanup };
}
