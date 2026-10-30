// The floors slice (task 5a1891f9): full_state sets the lobby elevator's
// floors and floors_updated replaces them. An older server sends no floors,
// which reads as none rather than the list from before the reconnect.

import { describe, expect, it } from "bun:test";
import { initialState, reducer } from "./store.tsx";
import type { Floor } from "../shared/floors.ts";

const a: Floor = {
  id: "fa",
  url: "https://a.example.com",
  name: "A",
  addedAt: 1,
};
const b: Floor = {
  id: "fb",
  url: "https://b.example.com",
  name: null,
  addedAt: 2,
};

const fullState = (floors?: Floor[]) =>
  reducer(initialState, {
    type: "full_state",
    agents: [],
    recentCwds: [],
    office: { prompt: null, name: null },
    rooms: [],
    killedAgents: [],
    interactions: [],
    ...(floors ? { floors } : {}),
  });

describe("floors slice", () => {
  it("full_state sets the floors and floors_updated replaces them", () => {
    const loaded = fullState([a, b]);
    expect(loaded.floors).toEqual([a, b]);
    const updated = reducer(loaded, { type: "floors_updated", floors: [b] });
    expect(updated.floors).toEqual([b]);
  });

  it("a full_state with no floors clears the list", () => {
    const loaded = reducer(fullState(), {
      type: "floors_updated",
      floors: [a],
    });
    expect(loaded.floors).toEqual([a]);
    const reconnected = reducer(loaded, {
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [],
      killedAgents: [],
      interactions: [],
    });
    expect(reconnected.floors).toEqual([]);
  });
});
