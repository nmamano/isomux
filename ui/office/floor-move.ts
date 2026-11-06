// The floor move when a member goes down the trap door to the back room or
// up its ladder to the front (task c996e4a9). Other routes between the two
// (the Back button, a tab, a key) switch with no animation. It lasts
// FLOOR_MOVE_MS; a member who asks for reduced motion gets a plain switch.
//
// At the click the old view (the child of the floor marked data-floor-view)
// is snapshotted and the switch dispatches at once. After React commits, the
// copy and the live new view, which stays hit-testable, move together as one
// building: the back room hangs under the front room, its wall tops at the
// bottom of the front floor's slab, as the rooms behind a door share a wall
// (task 28aa0955). Down through the hatch the camera descends, so both move
// up; up the ladder, both move down. The front room is nearer the camera and
// paints over the back room; it fades as the camera passes its floor.
import { cancelRoomTurn, ease, snapshot } from "./room-turn.ts";
import { FLOOR_BACK_X, FLOOR_BACK_Y, SCENE_W, VB_X, VB_Y } from "./grid.ts";
import { SLAB_H, WALL_H } from "./back-room/geometry.ts";

export type FloorDir = "down" | "up";

export const FLOOR_MOVE_MS = 600;

// Going down, the back room fades in under the front floor over the first
// BACK_FADE of the move, then the front room fades out from FADE_FROM to
// FADE_TO. Going up is the same in reverse.
const BACK_FADE = 0.25,
  FADE_FROM = 0.25,
  FADE_TO = 0.75;
// The views' controls (data-floor-chrome) stay on the screen, not on the
// building: the old ones fade out over the first CHROME_FADE of the move,
// the new ones fade in over the last.
const CHROME_FADE = 0.2;

/** Where the building's back corner, on the floor, is on screen, and the
 * scene's scale. */
interface Corner {
  x: number;
  y: number;
  s: number;
}

/** Reads a view's back corner from its scene box, the SCENE_W wide box
 * marked data-floor-scene. */
function sceneCorner(view: HTMLElement): Corner | null {
  const box = view.querySelector<HTMLElement>("[data-floor-scene]");
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const s = r.width / SCENE_W;
  if (!(s > 0)) return null;
  return {
    x: r.left + (FLOOR_BACK_X - VB_X) * s,
    y: r.top + (FLOOR_BACK_Y - VB_Y) * s,
    s,
  };
}

interface Job {
  floorEl: HTMLElement;
  dir: FloorDir;
  roomId: string | null;
  from: HTMLElement;
  fromCorner: Corner | null;
}

// A click's snapshot waits in `pending` until its target commits, and only
// for PENDING_MS, so a click that changed nothing leaves no stale snapshot
// behind. A frame is too short: the ladder's way up can go back in the
// browser history, and that switch commits on the popstate event, which can
// come after the next frame. Then the move is `running` until it ends or is
// cancelled.
const PENDING_MS = 400;
let pending: Job | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
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
  if (expiry !== null) clearTimeout(expiry);
  expiry = null;
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
  pending = { floorEl, dir, roomId, from, fromCorner: sceneCorner(view) };
  expiry = setTimeout(() => {
    expiry = null;
    pending = null;
  }, PENDING_MS);
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

function ramp(p: number): number {
  return Math.min(1, Math.max(0, (p - FADE_FROM) / (FADE_TO - FADE_FROM)));
}

function runMove(
  { floorEl, dir, roomId, from, fromCorner }: Job,
  view: HTMLElement,
) {
  const h = floorEl.clientHeight || view.offsetHeight;
  // Where the new view's content starts, relative to where it rests: in the
  // joint building the back room's wall tops (WALL_H above its floor) meet
  // the bottom of the front floor's slab (SLAB_H under it). Without a scene
  // box, the new view comes in from a whole view height away.
  const toCorner = sceneCorner(view);
  let vx = 0,
    vy = dir === "down" ? h : -h;
  if (fromCorner && toCorner) {
    const [up, down] =
      dir === "down" ? [fromCorner, toCorner] : [toCorner, fromCorner];
    const dx = up.x - down.x,
      dy = up.y - down.y + SLAB_H * up.s + WALL_H * down.s;
    [vx, vy] = dir === "down" ? [dx, dy] : [-dx, -dy];
  }

  // One host clips the copy to the floor's box. The front room paints over
  // the back room: going down the host sits right after the live view, going
  // up right before it. Later siblings (the members chat) still paint over
  // both. This DOM order sets the paint order only because both views are
  // positioned (position: relative), as the host is.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  host.append(from);
  if (dir === "down") view.after(host);
  else view.before(host);

  const [front, back] = dir === "down" ? [from, view] : [view, from];
  const chrome = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLElement>("[data-floor-chrome]"),
  ];
  const oldChrome = chrome(from),
    newChrome = chrome(view);
  const frame = (p: number) => {
    const e = ease(p);
    // How far the camera is from the front room, in time.
    const q = dir === "down" ? p : 1 - p;
    front.style.opacity = String(1 - ramp(q));
    back.style.opacity = String(Math.min(1, q / BACK_FADE));
    from.style.translate = `${-vx * e}px ${-vy * e}px`;
    const lx = vx * (1 - e),
      ly = vy * (1 - e);
    view.style.translate = `${lx}px ${ly}px`;
    // The floor does not clip: the live view clips the part that is out of
    // the floor's box.
    view.style.clipPath = `inset(${Math.max(0, -ly)}px ${Math.max(0, lx)}px ${Math.max(0, ly)}px ${Math.max(0, -lx)}px)`;
    for (const el of oldChrome)
      el.style.opacity = String(Math.max(0, 1 - p / CHROME_FADE));
    for (const el of newChrome)
      el.style.opacity = String(Math.max(0, 1 - (1 - p) / CHROME_FADE));
  };
  frame(0);

  let t0: number | null = null;
  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    host.remove();
    view.style.translate = "";
    view.style.clipPath = "";
    view.style.opacity = "";
    for (const el of newChrome) el.style.opacity = "";
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
