// The lobby elevator's floors (shared/floors.ts), office-wide.
//
// Persistence: <stateRoot>/floors.json, a JSON array of floors in the order
// they were added, written through atomically on every change. A missing or
// damaged file reads as an empty list: full_state reads it at every connect,
// and a bad file must never fail a boot or a socket.

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { MAX_FLOORS, normaliseFloorUrl, type Floor } from "../shared/floors.ts";

export type FloorAddResult =
  { kind: "added"; floor: Floor } | { kind: "exists" } | { kind: "full" };

export interface FloorsStore {
  list(): Floor[];
  // Synchronous, so the duplicate and cap checks and the write happen in one
  // step after the caller's probe has resolved.
  add(url: string, name: string | null): FloorAddResult;
  remove(id: string): boolean;
}

export function createFloorsStore(stateRoot: string = STATE_ROOT): FloorsStore {
  const file = join(stateRoot, "floors.json");
  let floors: Floor[] | null = null;

  const load = (): Floor[] => {
    if (floors) return floors;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
      floors = Array.isArray(raw) ? raw.filter(isFloor) : [];
    } catch {
      floors = [];
    }
    return floors;
  };
  const save = (next: Floor[]): void => {
    atomicWriteFileSync(file, JSON.stringify(next, null, 2));
    floors = next;
  };

  return {
    list: () => [...load()],
    add(url, name) {
      const current = load();
      if (current.some((f) => f.url === url)) return { kind: "exists" };
      if (current.length >= MAX_FLOORS) return { kind: "full" };
      const floor: Floor = {
        id: randomBytes(4).toString("hex"),
        url,
        name,
        addedAt: Date.now(),
      };
      save([...current, floor]);
      return { kind: "added", floor };
    },
    remove(id) {
      const current = load();
      const next = current.filter((f) => f.id !== id);
      if (next.length === current.length) return false;
      save(next);
      return true;
    },
  };
}

// A hand-edited or damaged entry is dropped, never a crash. The url must be
// a normalised origin: it goes to location.assign when a member opens it.
function isFloor(raw: unknown): raw is Floor {
  if (!raw || typeof raw !== "object") return false;
  const f = raw as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.url === "string" &&
    normaliseFloorUrl(f.url) === f.url &&
    (f.name === null || typeof f.name === "string") &&
    typeof f.addedAt === "number"
  );
}
