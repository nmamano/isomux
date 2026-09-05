import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, PresenceInfo, RoomWire } from "../../shared/types.ts";
import { DESK_SLOTS } from "../../shared/desks.ts";
import { deskPixelPos } from "./grid.ts";

// "Outside SE wall" lobby coordinates. Until the desk repositioning lands,
// idle ghosts cannot fit on the floor; they line up here, past the SE wall.
// Adjacent ghosts step right by `GHOST_LOBBY_GAP` so the name tags don't
// collide.
const GHOST_LOBBY_BASE_X = 600;
const GHOST_LOBBY_BASE_Y = 590;
const GHOST_LOBBY_GAP = 52;

// Stack offsets for multiple bosses focused on the same agent. Small
// diagonal step so the second/third ghost peeks out from behind the
// first. The cap-3-visible + N-badge logic is intentionally NOT
// implemented in v1; a count of 4+ at one desk should be vanishingly
// rare given the office's user count.
const GHOST_STACK_DX = 18;
const GHOST_STACK_DY = 4;

// CSS transition duration (ms) for ghost left/top - must match the
// `transition: left ... top ...` declaration in Ghost.tsx's motionStyle.
// Exit phantoms are removed 60ms after this to give the slide time to
// finish across paint-scheduling jitter.
const GHOST_TRANSITION_MS = 220;
const EXIT_PHANTOM_LIFETIME_MS = GHOST_TRANSITION_MS + 60;

// Pixel coord (scene-container space) for one of the room's doors. Passed
// in from OfficeView so this module stays unaware of scene layout constants.
export interface DoorCoord {
  left: number;
  top: number;
}

export interface GhostPlacement {
  presence: PresenceInfo;
  left: number;
  top: number;
  dimmed: boolean;
}

// Placements plus a use counter per door. The counters only ever go up,
// by one per ghost that crosses that door in either direction, so a
// consumer can restart a door animation by keying on the number and
// never has to know anything about presences.
export interface GhostTransitions {
  placements: GhostPlacement[];
  leftDoorUses: number;
  rightDoorUses: number;
}

// Returns whether two maps have equal keys + (referential) values. Cheap
// fast-path so we don't trigger spurious re-renders by replacing state with
// an equivalent-but-new Map instance.
function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// Pixel placements for every ghost that should render in the current room
// (assuming they stay put - i.e., no door-transition override). Output is in
// INPUT ORDER (which the server sorts by connectionId), NOT grouped by
// anchor. Stable React child order keyed by connectionId is the invariant
// that prevents browsers from reorder-induced re-attach + animation restart
// on unrelated ghosts when someone arrives at or leaves a different desk.
// Anchor membership only determines coordinates and intra-group stack rank,
// never iteration order.
//
// The recipient's own ghost is filtered out entirely - a boss never sees
// their own avatar (only other devices / other users render). If the boss
// is the only device connected, no ghost renders; other tabs/devices of
// the same user appear as their own ghosts via their own connectionId.
function computeNaturalPlacements(
  presences: PresenceInfo[],
  roomAgents: AgentInfo[],
  currentRoomId: string | null,
  ownConnectionId: string | null,
): GhostPlacement[] {
  const visible = presences.filter(
    (p) =>
      p.currentRoomId === currentRoomId && p.connectionId !== ownConnectionId,
  );
  const groups = new Map<string, PresenceInfo[]>();
  for (const p of visible) {
    const agent =
      p.focusedAgentId !== null
        ? roomAgents.find((a) => a.id === p.focusedAgentId)
        : undefined;
    const key = agent ? `desk:${agent.desk}` : "lobby";
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }
  const rankByConn = new Map<string, { key: string; index: number }>();
  for (const [key, group] of groups) {
    group.forEach((p, index) => {
      rankByConn.set(p.connectionId, { key, index });
    });
  }
  const out: GhostPlacement[] = [];
  for (const p of visible) {
    const rank = rankByConn.get(p.connectionId);
    if (!rank) continue;
    const { key, index: i } = rank;
    let left: number;
    let top: number;
    if (key === "lobby") {
      left = GHOST_LOBBY_BASE_X + i * GHOST_LOBBY_GAP;
      top = GHOST_LOBBY_BASE_Y;
    } else {
      const deskIndex = Number(key.slice(5));
      const slot = DESK_SLOTS[deskIndex];
      if (!slot) continue;
      const { left: deskLeft, top: deskTop } = deskPixelPos(slot.row, slot.col);
      // SE of the chair. Chair anchor is (deskLeft+90, deskTop+116);
      // the ghost top-left sits a touch lower-right of that so the
      // body's visual centroid hovers near the chair shoulder. Layout
      // is intentionally cramped before desk repositioning.
      left = deskLeft + 130 + i * GHOST_STACK_DX;
      top = deskTop + 90 + i * GHOST_STACK_DY;
    }
    out.push({
      presence: p,
      left,
      top,
      dimmed: p.viewMode === "away",
    });
  }
  return out;
}

// Owns the full pixel placement of every visible ghost - natural lobby /
// desk positions, door-slide overrides on room switches, and exit phantoms
// so departures animate to the door instead of popping out.
//
// Desk-to-desk slides (focus change inside a single room) and lobby-stack
// reshuffles are NOT managed here; they're a passive consequence of left/top
// changes flowing through Ghost.tsx's CSS `transition: left 220ms ease-out,
// top 220ms ease-out, opacity 220ms` declaration. This hook only adds the
// extra state needed to coordinate door slides, which can't be expressed as
// natural left/top changes because the React node would otherwise unmount
// (on exit) or fresh-mount at the wrong coord (on entry) before any
// transition could run.
//
// Detection runs SYNCHRONOUSLY during render via the React render-phase
// setState pattern: we hold `prevPresences` and `prevOwnRoomId` in state,
// compare against the current props, and update state during the render
// that first sees a diff. React discards that render and re-renders with
// the new state - so the first paint after a presence_list room change
// already has door coords applied (for entry overrides) and exit phantoms
// inserted, keeping DOM element identity by connectionId across the
// natural -> phantom transition so the existing left/top CSS transition
// animates the slide instead of remount-popping.
//
// Direction rule: the two room ids are resolved to their dense positions in
// the visible `rooms` list, and sign(currIdx - prevIdx) decides which door.
//   forward (positive): exit RIGHT (old room) / enter LEFT (new room).
//   backward (negative): exit LEFT (old room) / enter RIGHT (new room).
//
// No door animation when:
//   - the viewer themselves changed currentRoomId (their movement, not the
//     other presence's): all in-flight state is cleared,
//   - the presence's prevRoomId or currRoomId is null (connect / disconnect /
//     crossing in or out of the recipient's visible projection),
//   - either room id is missing from the visible `rooms` list (no direction),
//   - we've never seen this presence before (initial mount of its entry).
export function useGhostTransitions(
  presences: PresenceInfo[],
  roomAgents: AgentInfo[],
  currentRoomId: string | null,
  rooms: RoomWire[],
  ownConnectionId: string | null,
  leftDoor: DoorCoord,
  rightDoor: DoorCoord,
): GhostTransitions {
  const [entering, setEntering] = useState<Map<string, DoorCoord>>(
    () => new Map(),
  );
  const [exiting, setExiting] = useState<Map<string, GhostPlacement>>(
    () => new Map(),
  );
  // One counter per door, bumped in the same render-phase pass that
  // decides a ghost slides to or from that door.
  const [doorUses, setDoorUses] = useState({ left: 0, right: 0 });
  // `prevPresences` / `prevOwnRoomId` are kept in STATE (not refs) so the
  // render-phase compare-and-update pattern is a pure function of state
  // and props. Refs would also work but would be a side-effect mutation
  // during render, which strict-mode double-renders catch.
  const [prevPresences, setPrevPresences] = useState<PresenceInfo[]>(presences);
  const [prevOwnRoomId, setPrevOwnRoomId] = useState<string | null>(
    currentRoomId,
  );

  // Global room id -> dense index in the visible projection. Used ONLY to
  // derive the slide direction (which door) when a ghost changes rooms; all
  // room-membership checks are by id. An id missing here means the room isn't
  // in this session's visible set, so the door animation is skipped.
  const roomIndexById = useMemo(() => {
    const m = new Map<string, number>();
    rooms.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [rooms]);

  // Map<cid, prevRoomId> derived from prevPresences. Recomputed only when
  // prevPresences changes (i.e., when we accept a new diff into state).
  const prevRoomByCid = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of prevPresences) m.set(p.connectionId, p.currentRoomId);
    return m;
  }, [prevPresences]);

  // Effect-managed bookkeeping. Not read in render.
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const enteringRafsRef = useRef<
    Map<string, { raf1: number; raf2: number | null }>
  >(new Map());

  // Render-phase derived-state pattern. When `presences` or `currentRoomId`
  // change (compared by reference / value to the snapshot in state), detect
  // transitions and update state IN THIS render so the same render's return
  // value reflects them. React discards the just-returned output and
  // re-renders with the updated state before painting.
  if (presences !== prevPresences || currentRoomId !== prevOwnRoomId) {
    const ownChanged = prevOwnRoomId !== currentRoomId;

    if (ownChanged) {
      // The viewer moved. Their natural appearance/disappearance from our
      // view is from our movement, not theirs - drop any in-flight
      // animations. The exit-timer / rAF cleanup happens in the [entering]
      // and [exiting] sync effects when the maps reduce to empty.
      if (entering.size > 0) setEntering(new Map());
      if (exiting.size > 0) setExiting(new Map());
    } else {
      const newEnteringEntries = new Map<string, DoorCoord>();
      const newExitingEntries = new Map<string, GhostPlacement>();
      let leftUses = 0;
      let rightUses = 0;

      for (const p of presences) {
        // The viewer's own connection is never a ghost here, and its room
        // change arrives from the server a render after currentRoomId
        // moved, so without this it would count as a ghost coming in
        // through the door.
        if (p.connectionId === ownConnectionId) continue;
        const prevRoomId = prevRoomByCid.get(p.connectionId);
        const currRoomId = p.currentRoomId;
        if (prevRoomId === undefined) continue;
        if (prevRoomId === currRoomId) continue;
        if (prevRoomId === null || currRoomId === null) continue;

        // Direction needs the dense ordering of the two rooms. If either id
        // isn't in the visible projection, skip the door anim (don't guess).
        const prevIdx = roomIndexById.get(prevRoomId);
        const currIdx = roomIndexById.get(currRoomId);
        if (prevIdx === undefined || currIdx === undefined) continue;

        const goingForward = currIdx > prevIdx;
        if (prevRoomId === currentRoomId) {
          const door = goingForward ? rightDoor : leftDoor;
          if (goingForward) rightUses += 1;
          else leftUses += 1;
          newExitingEntries.set(p.connectionId, {
            presence: p,
            left: door.left,
            top: door.top,
            dimmed: p.viewMode === "away",
          });
        } else if (currRoomId === currentRoomId) {
          const door = goingForward ? leftDoor : rightDoor;
          if (goingForward) leftUses += 1;
          else rightUses += 1;
          newEnteringEntries.set(p.connectionId, {
            left: door.left,
            top: door.top,
          });
        }
      }
      if (leftUses > 0 || rightUses > 0) {
        setDoorUses({
          left: doorUses.left + leftUses,
          right: doorUses.right + rightUses,
        });
      }

      if (newEnteringEntries.size > 0) {
        // Merge per-cid: preserve any still-pending entering overrides
        // from a prior render (within the rAF clear window) so a second
        // arrival's door-coord paint doesn't wipe out an earlier one.
        const mergedEntering = new Map(entering);
        let enteringChanged = false;
        for (const [cid, door] of newEnteringEntries) {
          if (mergedEntering.get(cid) !== door) {
            mergedEntering.set(cid, door);
            enteringChanged = true;
          }
        }
        if (enteringChanged) setEntering(mergedEntering);
      }

      // Rebound (someone re-entered while a phantom of theirs was active):
      // dropping the phantom lets the natural placement take over; the
      // existing DOM element transitions from door back to natural.
      //
      // Known edge case: if the entry door differs from the exit door
      // (presence went R -> R+1 -> R-1 -> R fast enough to land while
      // the phantom is still alive), the same DOM element slides across
      // the entire scene instead of remount-popping at the new door.
      // Requires three room hops within EXIT_PHANTOM_LIFETIME_MS - rare.
      // Fix would be a per-cid remount-generation key, but that
      // complicates the common same-door rebound. Deferred for v1.
      const enteredCids = Array.from(newEnteringEntries.keys());
      const rebounds = enteredCids.filter((cid) => exiting.has(cid));
      if (newExitingEntries.size > 0 || rebounds.length > 0) {
        const mergedExiting = new Map(exiting);
        for (const cid of rebounds) mergedExiting.delete(cid);
        for (const [cid, ph] of newExitingEntries) mergedExiting.set(cid, ph);
        if (!mapsEqual(exiting, mergedExiting)) setExiting(mergedExiting);
      }
    }

    setPrevPresences(presences);
    setPrevOwnRoomId(currentRoomId);
  }

  // Sync rAF schedule to current `entering` state. New cids in `entering`
  // get a two-rAF schedule whose inner callback removes the cid from
  // entering (per-cid, so multiple staggered arrivals each get their own
  // door-coord paint window). Removed cids get their rAFs cancelled.
  useEffect(() => {
    for (const [cid] of entering) {
      if (!enteringRafsRef.current.has(cid)) {
        const raf1 = requestAnimationFrame(() => {
          const raf2 = requestAnimationFrame(() => {
            enteringRafsRef.current.delete(cid);
            setEntering((curr) => {
              if (!curr.has(cid)) return curr;
              const next = new Map(curr);
              next.delete(cid);
              return next;
            });
          });
          const entry = enteringRafsRef.current.get(cid);
          if (entry) entry.raf2 = raf2;
        });
        enteringRafsRef.current.set(cid, { raf1, raf2: null });
      }
    }
    for (const cid of Array.from(enteringRafsRef.current.keys())) {
      if (!entering.has(cid)) {
        const r = enteringRafsRef.current.get(cid);
        if (r !== undefined) {
          cancelAnimationFrame(r.raf1);
          if (r.raf2 !== null) cancelAnimationFrame(r.raf2);
        }
        enteringRafsRef.current.delete(cid);
      }
    }
  }, [entering]);

  // Sync removal-timer schedule to current `exiting` state.
  useEffect(() => {
    for (const [cid] of exiting) {
      if (!exitTimersRef.current.has(cid)) {
        const t = setTimeout(() => {
          exitTimersRef.current.delete(cid);
          setExiting((curr) => {
            if (!curr.has(cid)) return curr;
            const next = new Map(curr);
            next.delete(cid);
            return next;
          });
        }, EXIT_PHANTOM_LIFETIME_MS);
        exitTimersRef.current.set(cid, t);
      }
    }
    for (const cid of Array.from(exitTimersRef.current.keys())) {
      if (!exiting.has(cid)) {
        const t = exitTimersRef.current.get(cid);
        if (t !== undefined) clearTimeout(t);
        exitTimersRef.current.delete(cid);
      }
    }
  }, [exiting]);

  // Cancel all pending timers / rAFs on unmount.
  useEffect(
    () => () => {
      for (const t of exitTimersRef.current.values()) clearTimeout(t);
      exitTimersRef.current.clear();
      for (const r of enteringRafsRef.current.values()) {
        cancelAnimationFrame(r.raf1);
        if (r.raf2 !== null) cancelAnimationFrame(r.raf2);
      }
      enteringRafsRef.current.clear();
    },
    [],
  );

  // Final placement list: natural placements with entering overrides
  // applied, plus exit phantoms for any cid that just left, sorted by
  // connectionId so React's child order stays stable across all the
  // merge variants. This is the invariant Ghost.tsx's two-layer split
  // relies on to keep inline CSS transitions from re-attach-restarting.
  const naturalPlacements = useMemo(
    () =>
      computeNaturalPlacements(
        presences,
        roomAgents,
        currentRoomId,
        ownConnectionId,
      ),
    [presences, roomAgents, currentRoomId, ownConnectionId],
  );

  const placements = useMemo(() => {
    const byCid = new Map<string, GhostPlacement>();
    for (const p of naturalPlacements) {
      const override = entering.get(p.presence.connectionId);
      byCid.set(
        p.presence.connectionId,
        override !== undefined
          ? { ...p, left: override.left, top: override.top }
          : p,
      );
    }
    for (const [cid, phantom] of exiting) {
      if (!byCid.has(cid)) byCid.set(cid, phantom);
    }
    return Array.from(byCid.values()).sort((a, b) =>
      a.presence.connectionId.localeCompare(b.presence.connectionId),
    );
  }, [naturalPlacements, entering, exiting]);

  return useMemo(
    () => ({
      placements,
      leftDoorUses: doorUses.left,
      rightDoorUses: doorUses.right,
    }),
    [placements, doorUses],
  );
}
