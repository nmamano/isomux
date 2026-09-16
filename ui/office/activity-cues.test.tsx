// The three cues that say an agent is MID-TURN: output scrolling past on its
// monitor, screen light on its face, and steam off its drink.
//
// All three answer to one state and not to a timer, which is the whole point
// of them - an office where every desk animates all the time says nothing. So
// what these cases pin is the mapping from agent state to cue, state by state,
// including the two that are easy to get wrong: an agent waiting on a reply
// and an agent sitting on an error have a LIT screen but nobody working at it.

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentState } from "../../shared/types.ts";
import { SKIN_COLORS } from "../../shared/outfit-options.ts";
import { Character, faceLitColor } from "./Character.tsx";
import { DeskSprite } from "./DeskSprite.tsx";

const OUTFIT = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short" as const,
  skin: "#FFD5B8",
  beard: "none" as const,
  accessory: null,
  hat: "none" as const,
};

// Which states a turn is running in, written as a record over the whole of
// AgentState rather than as two lists: a state added to the union and not
// classified here stops this file compiling, instead of quietly going
// untested and picking up whichever cue the branch happens to give it.
const MID_TURN_BY_STATE: Record<AgentState, boolean> = {
  thinking: true,
  tool_executing: true,
  idle: false,
  waiting_for_response: false,
  error: false,
  stopped: false,
};
const states = (midTurn: boolean) =>
  (Object.keys(MID_TURN_BY_STATE) as AgentState[]).filter(
    (s) => MID_TURN_BY_STATE[s] === midTurn,
  );
const MID_TURN = states(true);
const NOT_MID_TURN = states(false);

const desk = (state: AgentState, agentType: "claude" | "codex" = "claude") =>
  renderToStaticMarkup(<DeskSprite state={state} agentType={agentType} />);

describe("monitor", () => {
  it("scrolls output past only while the agent is mid-turn", () => {
    for (const state of MID_TURN)
      expect([state, desk(state).includes("data-screen-scroll")]).toEqual([
        state,
        true,
      ]);
    for (const state of NOT_MID_TURN)
      expect([state, desk(state).includes("data-screen-scroll")]).toEqual([
        state,
        false,
      ]);
  });

  // A lit screen that is not being worked at keeps its own slow sweep, so the
  // two never both run: that would read as two different things happening.
  it("shows the idle sweep and the scrolling lines at different times", () => {
    const markup = desk("thinking");
    const sweeps = markup.split("<animate").length - 1;
    expect(markup.includes("data-screen-scroll")).toBe(true);
    expect(sweeps).toBeGreaterThan(0);
    for (const state of ["waiting_for_response", "error"] as AgentState[]) {
      expect([state, desk(state).includes("data-screen-scroll")]).toEqual([
        state,
        false,
      ]);
    }
  });
});

describe("drink", () => {
  for (const vessel of ["claude", "codex"] as const) {
    it(`steams from a ${vessel} desk only while the agent is mid-turn`, () => {
      for (const state of MID_TURN)
        expect([state, desk(state, vessel).includes("data-steam")]).toEqual([
          state,
          true,
        ]);
      for (const state of NOT_MID_TURN)
        expect([state, desk(state, vessel).includes("data-steam")]).toEqual([
          state,
          false,
        ]);
    });
  }
});

describe("face", () => {
  const character = (state: AgentState, portrait = false) =>
    renderToStaticMarkup(
      <Character state={state} outfit={OUTFIT} portrait={portrait} />,
    );

  it("catches the screen light only while the agent is mid-turn", () => {
    for (const state of MID_TURN)
      expect([state, character(state).includes("data-face-light")]).toEqual([
        state,
        true,
      ]);
    for (const state of NOT_MID_TURN)
      expect([state, character(state).includes("data-face-light")]).toEqual([
        state,
        false,
      ]);
  });

  // The portrait is a plaque avatar with no desk in front of it, so there is
  // no screen to be lit by - and it is drawn at 40px, where a gradient is
  // mud.
  it("leaves the portrait unlit whatever the agent is doing", () => {
    for (const state of [...MID_TURN, ...NOT_MID_TURN])
      expect([
        state,
        character(state, true).includes("data-face-light"),
      ]).toEqual([state, false]);
  });

  it("paints the light in the face's own skin, not in a colour of its own", () => {
    for (const tone of SKIN_COLORS) {
      const markup = renderToStaticMarkup(
        <Character state="thinking" outfit={{ ...OUTFIT, skin: tone }} />,
      );
      const lit = faceLitColor(tone);
      // Every stop of the gradient, so nobody can reintroduce one fixed pale
      // blue at the bright end and leave the fall-off looking right.
      const stops = [...markup.matchAll(/stop-color="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect([tone, stops.length > 0]).toEqual([tone, true]);
      expect([tone, new Set(stops)]).toEqual([tone, new Set([lit])]);
    }
  });

  it("returns a colour it cannot read untouched", () => {
    for (const bad of ["", "cornflower", "#12", "#ggghhh", "rgb(1,2,3)"])
      expect(faceLitColor(bad)).toBe(bad);
  });

  // Two characters on screen at once must not share one gradient: the office
  // draws up to eight, and a definition that outlives its owner is a face that
  // loses its light when an unrelated agent goes idle.
  it("gives every character its own light definitions", () => {
    const two = renderToStaticMarkup(
      <>
        <Character state="thinking" outfit={OUTFIT} />
        <Character state="thinking" outfit={OUTFIT} />
      </>,
    );
    const ids = [...two.matchAll(/id="(face-[a-z]+-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

// The same light has to fall on every agent. The first cut of this cue mixed
// each face towards one fixed pale blue, so how much a face moved depended on
// how far from that blue it already was: measured at 1x on 2026-09-16, the
// palest skin the picker offers moved 22/255 at its peak and the darkest
// 89/255 - invisible on one agent, washing the face flat on another.
//
// What these cases pin is the fix, at BOTH ends at once. A change that dims
// the pale end or brightens the dark end fails here, and so does going back to
// mixing towards a fixed colour.
describe("face light, across every skin the picker offers", () => {
  const rgb = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lifts = SKIN_COLORS.map((tone) => {
    const base = rgb(tone);
    const lit = rgb(faceLitColor(tone));
    return { tone, base, lit, gain: lit.map((v, i) => v - base[i]) };
  });

  it("gains the same light on every skin, channel by channel", () => {
    for (const a of lifts) {
      for (const b of lifts) {
        for (let ch = 0; ch < 3; ch++) {
          // A channel already at white cannot gain any more, and a face that
          // clips is the one case where two gains may honestly differ.
          if (a.lit[ch] === 255 || b.lit[ch] === 255) continue;
          expect([a.tone, b.tone, ch, a.gain[ch]]).toEqual([
            a.tone,
            b.tone,
            ch,
            b.gain[ch],
          ]);
        }
      }
    }
  });

  it("stays faint on the darkest skin and stays visible on the palest", () => {
    const peaks = lifts.map((l) => ({
      tone: l.tone,
      peak: Math.max(...l.gain),
    }));
    for (const { tone, peak } of peaks) {
      // Below this the cue is not there; above it, it is an effect.
      expect([tone, peak >= 24, peak <= 44]).toEqual([tone, true, true]);
    }
    // And no face may be lit appreciably harder than any other, which is the
    // defect itself rather than either of its ends.
    const spread =
      Math.max(...peaks.map((p) => p.peak)) -
      Math.min(...peaks.map((p) => p.peak));
    expect(spread).toBeLessThanOrEqual(6);
  });

  it("leaves every lit face still its own colour", () => {
    // Mixing towards one blue pulls faces together; adding light keeps them
    // apart. The darkest skin lit must stay darker than the palest skin unlit,
    // by a wide margin, in every channel.
    const darkest = rgb(faceLitColor("#5C3A28"));
    const palest = rgb("#FDEBD0");
    for (let ch = 0; ch < 3; ch++)
      expect([ch, darkest[ch] < palest[ch] - 60]).toEqual([ch, true]);
  });
});
