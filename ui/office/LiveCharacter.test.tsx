// The character outside a desk (chat header, app widget, lobby) sweats on the
// same rule as at the desk: mid-turn, and the working stretch is past
// SWEAT_AFTER_MS.

import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo, AgentState } from "../../shared/types.ts";
import { initialState, StateCtx } from "../store.tsx";
import { SWEAT_AFTER_MS } from "./DeskUnit.tsx";
import { LiveCharacter } from "./LiveCharacter.tsx";

const agent = (state: AgentState) =>
  ({
    id: "agent-1",
    state,
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: null,
      hat: "none",
    },
  }) as unknown as AgentInfo;

const sweats = (state: AgentState, workedMs?: number) =>
  renderToStaticMarkup(
    createElement(
      StateCtx.Provider,
      {
        value: {
          ...initialState,
          workingSince: new Map(
            workedMs === undefined ? [] : [["agent-1", Date.now() - workedMs]],
          ),
        },
      },
      createElement(LiveCharacter, { agent: agent(state) }),
    ),
  ).includes("data-sweat");

describe("LiveCharacter sweat", () => {
  it("sweats once a working stretch passes the threshold", () => {
    expect(sweats("thinking", SWEAT_AFTER_MS + 1000)).toBe(true);
    expect(sweats("tool_executing", SWEAT_AFTER_MS + 1000)).toBe(true);
  });

  it("does not sweat before the threshold, without a stretch, or when not working", () => {
    expect(sweats("thinking", SWEAT_AFTER_MS - 5000)).toBe(false);
    expect(sweats("thinking")).toBe(false);
    expect(sweats("idle", SWEAT_AFTER_MS + 1000)).toBe(false);
  });
});
