// The room turn when a member walks through a wall door between two rooms.
// It is off, and no setting turns it on, until task ada9af7b ships it.
// Tests turn it on with setRoomTurn.
//
// At the click the old room is snapshotted (a DOM clone), the room switch
// dispatches at once, and after React commits the new room is snapshotted
// too. Both clones animate over the live scene, which stays hit-testable at
// opacity 0, so the switch and clicks never wait for the animation.
//
// Variant "turn" turns the world 90 degrees about the vertical axis through
// the back corner, where the two walls meet. The room behind the clicked
// door shares that wall, so after the turn the shared wall is the new room's
// other wall. Each plane maps by an exact affine: the floor by P*R*P^-1, each
// wall by its own base direction with verticals kept vertical. Upright
// sprites (desks, characters, props) move with their floor anchor and stay
// upright. Variant "cube" is a screen-space flip of the flat picture.

export type RoomTurn =
  | "off"
  | "turn-350"
  | "turn-600"
  | "cube-350"
  | "cube-600";
let roomTurn: RoomTurn = "off";

export function setRoomTurn(value: RoomTurn): void {
  roomTurn = value;
}

export type TurnSide = "left" | "right";
type Variant = "turn" | "cube";

const CHOICES: Record<
  Exclude<RoomTurn, "off">,
  { variant: Variant; ms: number }
> = {
  "turn-350": { variant: "turn", ms: 350 },
  "turn-600": { variant: "turn", ms: 600 },
  "cube-350": { variant: "cube", ms: 350 },
  "cube-600": { variant: "cube", ms: 600 },
};

// Scene pixel coordinates (950x700 box): the back corner is SVG (120, 40)
// shifted by the viewBox origin (-355, -100).
const CORNER_X = 475,
  CORNER_Y = 140;
// Screen vectors of one step along the floor axes: u runs down-left along
// the left wall, v down-right along the right wall (2:1 isometric).
const EU: [number, number] = [-1, 0.5];
const EV: [number, number] = [1, 0.5];

type M2 = [number, number, number, number]; // column-major a b c d (CSS order)

function mul(m: M2, n: M2): M2 {
  // (m * n), both column-major [a b c d] = [[a c],[b d]]
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
  ];
}
function inv(m: M2): M2 {
  const det = m[0] * m[3] - m[2] * m[1];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}
function apply(m: M2, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

// World rotation in floor (u, v) coordinates by deg. Positive turns the
// right wall toward the left wall's place.
function rot(deg: number): M2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  // (u, v) -> (c u + s v, -s u + c v)
  return [c, -s, s, c];
}
const P: M2 = [EU[0], EU[1], EV[0], EV[1]];
const P_INV = inv(P);

function groundMatrix(deg: number): M2 {
  return mul(P, mul(rot(deg), P_INV));
}
function wallMatrix(side: TurnSide, deg: number): M2 {
  const base = side === "left" ? EU : EV;
  const turned = apply(groundMatrix(deg), base[0], base[1]);
  return mul([turned[0], turned[1], 0, 1], inv([base[0], base[1], 0, 1]));
}
// A wall's inner face looks at the camera while its turned normal points
// toward the viewer, who looks from the front corner (+u, +v).
function wallFacesViewer(side: TurnSide, deg: number): boolean {
  const n: [number, number] = side === "left" ? [0, 1] : [1, 0];
  const [nu, nv] = apply(rot(deg), n[0], n[1]);
  return nu + nv > 1e-6;
}

function css(m: M2, tx = 0, ty = 0): string {
  return `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${tx}, ${ty})`;
}

// SVG ids are document-global: rename the clone's ids and the url(#...) and
// href references to them, so neither copy paints with the other's defs.
function renameIds(root: Element, suffix: string) {
  const ids = new Set<string>();
  root.querySelectorAll("[id]").forEach((el) => {
    ids.add(el.id);
    el.id = el.id + suffix;
  });
  if (ids.size === 0) return;
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      let v = attr.value;
      if (!v.includes("#")) continue;
      v = v.replace(
        /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g,
        (m: string, id: string) => (ids.has(id) ? `url(#${id}${suffix})` : m),
      );
      if ((attr.name === "href" || attr.name === "xlink:href") && v[0] === "#")
        if (ids.has(v.slice(1))) v = v + suffix;
      if (v !== attr.value) el.setAttribute(attr.name, v);
    }
  }
}

function snapshot(content: HTMLElement, suffix: string): HTMLElement {
  const clone = content.cloneNode(true) as HTMLElement;
  renameIds(clone, suffix);
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.pointerEvents = "none";
  clone.removeAttribute("data-testid");
  return clone;
}

// One animated piece of a snapshot and how it moves at a given world angle.
type Piece = (deg: number) => void;

function pieces(clone: HTMLElement): Piece[] {
  const out: Piece[] = [];
  const children = Array.from(clone.children) as HTMLElement[];
  for (const el of children) {
    const kind = el.getAttribute("data-turn");
    const ox = el.offsetLeft || 0,
      oy = el.offsetTop || 0;
    if (kind === "floor") {
      el.style.transformOrigin = `${CORNER_X - ox}px ${CORNER_Y - oy}px`;
      out.push((deg) => (el.style.transform = css(groundMatrix(deg))));
    } else if (kind === "walls" || kind === "doors") {
      // One copy per wall plane, each clipped to its side of the corner.
      const right = el.cloneNode(true) as HTMLElement;
      el.after(right);
      const big = 4000;
      const cx = CORNER_X - ox;
      el.style.clipPath = `polygon(${-big}px ${-big}px, ${cx}px ${-big}px, ${cx}px ${big}px, ${-big}px ${big}px)`;
      right.style.clipPath = `polygon(${cx}px ${-big}px, ${big}px ${-big}px, ${big}px ${big}px, ${cx}px ${big}px)`;
      for (const [node, side] of [
        [el, "left"],
        [right, "right"],
      ] as const) {
        node.style.transformOrigin = `${CORNER_X - ox}px ${CORNER_Y - oy}px`;
        out.push((deg) => {
          node.style.visibility = wallFacesViewer(side, deg)
            ? "visible"
            : "hidden";
          node.style.transform = css(wallMatrix(side, deg));
        });
      }
    } else if (el instanceof SVGSVGElement) {
      // A scene-wide drawing of upright props: move each top-level group by
      // the floor point under its bottom centre.
      for (const g of Array.from(el.children)) {
        if (!(g instanceof SVGGraphicsElement) || g.tagName === "defs")
          continue;
        let bb: DOMRect;
        try {
          bb = g.getBBox();
        } catch {
          continue;
        }
        if (bb.width === 0 && bb.height === 0) continue;
        // viewBox is 1:1 with pixels, offset by (-355, -100). A prop names
        // its floor point (in SVG units); otherwise take its footprint
        // centre, a quarter of its width above its lowest point (a 2:1
        // diamond as wide as the sprite).
        const named = g
          .getAttribute("data-turn-anchor")
          ?.split(",")
          .map(Number);
        const ax = (named ? named[0] : bb.x + bb.width / 2) + 355 + ox,
          ay = (named ? named[1] : bb.y + bb.height - bb.width / 4) + 100 + oy;
        const base = g.getAttribute("transform") ?? "";
        out.push((deg) => {
          const [dx, dy] = moveAnchor(ax, ay, deg);
          g.setAttribute("transform", `translate(${dx} ${dy}) ${base}`);
        });
      }
    } else {
      // Desks and slots name their floor point; anything else is taken
      // at its footprint centre, as for the SVG props above.
      const named = el.getAttribute("data-turn-anchor")?.split(",").map(Number);
      const ax = named ? named[0] : ox + el.offsetWidth / 2,
        ay = named ? named[1] : oy + el.offsetHeight - el.offsetWidth / 4;
      const base = el.style.transform;
      out.push((deg) => {
        const [dx, dy] = moveAnchor(ax, ay, deg);
        el.style.transform = `translate(${dx}px, ${dy}px) ${base}`;
      });
    }
  }
  return out;
}

function moveAnchor(ax: number, ay: number, deg: number): [number, number] {
  const [x, y] = apply(groundMatrix(deg), ax - CORNER_X, ay - CORNER_Y);
  return [x + CORNER_X - ax, y + CORNER_Y - ay];
}

function ease(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
function ramp(p: number, a: number, b: number): number {
  return Math.min(1, Math.max(0, (p - a) / (b - a)));
}

interface Job {
  side: TurnSide;
  variant: Variant;
  ms: number;
  targetRoomId: string;
  from: HTMLElement;
  content: HTMLElement;
}

// A door click's snapshot waits in `pending` until the target room commits;
// then the turn is `running` until it ends or is cancelled.
let pending: Job | null = null;
let running: { targetRoomId: string; cancel: () => void } | null = null;

function reducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Ends a pending or running turn and leaves only the live scene. */
export function cancelRoomTurn(): void {
  pending = null;
  running?.cancel();
  running = null;
}

/** Call from a door click, BEFORE the switch dispatches. The choice and its
 * time are read here, so a change mid-turn does not mix them. */
export function beginRoomTurn(
  content: HTMLElement | null,
  side: TurnSide,
  targetRoomId: string,
) {
  cancelRoomTurn();
  const choice = roomTurn;
  if (!content || choice === "off" || reducedMotion()) return;
  const { variant, ms } = CHOICES[choice];
  pending = {
    side,
    variant,
    ms,
    targetRoomId,
    from: snapshot(content, "__turnA"),
    content,
  };
}

/** Call from a layout effect on every room change; roomId is null when the
 * lobby is open. A change to any room but the door's target (a tab, the
 * lobby) is a plain switch: it ends the turn and starts none. */
export function finishRoomTurn(roomId: string | null) {
  const job = pending;
  pending = null;
  if (!job || job.targetRoomId !== roomId) {
    if (running && running.targetRoomId !== roomId) cancelRoomTurn();
    return;
  }
  // Wait one frame: door labels fit themselves in a layout effect that
  // re-renders after this one, and the callback still runs before the paint.
  const raf0 = requestAnimationFrame(() => runTurn(job));
  running = {
    targetRoomId: job.targetRoomId,
    cancel: () => cancelAnimationFrame(raf0),
  };
}

function runTurn({ side, variant, ms, targetRoomId, from, content }: Job) {
  const to = snapshot(content, "__turnB");
  // Siblings of the live scene in the viewport layer, so zoom, pan and the
  // centering transform apply to them exactly as to the live scene.
  content.after(to);
  content.after(from);
  content.style.opacity = "0";

  const sign = side === "right" ? 1 : -1;
  let frame: (p: number) => void;
  if (variant === "cube") {
    const half = 475;
    for (const el of [from, to]) {
      el.style.transformOrigin = `50% 50% ${-half}px`;
      el.style.backfaceVisibility = "hidden";
    }
    const baseA = from.style.transform,
      baseB = to.style.transform;
    frame = (p) => {
      const e = ease(p);
      from.style.transform = `${baseA} perspective(2400px) rotateY(${-sign * 90 * e}deg)`;
      to.style.transform = `${baseB} perspective(2400px) rotateY(${sign * 90 * (1 - e)}deg)`;
    };
  } else {
    const a = pieces(from),
      b = pieces(to);
    frame = (p) => {
      const deg = sign * 90 * ease(p);
      for (const f of a) f(deg);
      for (const f of b) f(deg - sign * 90);
      // The old room is in front until the shared wall stands edge-on.
      const aFront = p < 0.5;
      from.style.zIndex = aFront ? "2" : "1";
      to.style.zIndex = aFront ? "1" : "2";
      to.style.opacity = String(ramp(p, 0, 0.45));
      from.style.opacity = String(1 - ramp(p, 0.55, 1));
    };
  }
  for (const el of [from, to]) {
    el.style.position = "absolute";
  }
  frame(0);

  const t0 = performance.now();
  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    from.remove();
    to.remove();
    content.style.opacity = "";
  };
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    frame(p);
    if (p < 1) raf = requestAnimationFrame(tick);
    else {
      cleanup();
      running = null;
    }
  };
  raf = requestAnimationFrame(tick);
  running = { targetRoomId, cancel: cleanup };
}
