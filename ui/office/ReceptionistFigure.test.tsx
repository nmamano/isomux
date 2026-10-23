import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceptionistFigure } from "./ReceptionistFigure.tsx";
import { CHARACTER_GEOMETRY } from "./Character.tsx";
import { LOBBY_ROOM_ID, type AgentInfo } from "../../shared/types.ts";

const AGENT = {
  id: "agent-r",
  name: "Receptionist",
  desk: 0,
  roomId: LOBBY_ROOM_ID,
  state: "idle",
  modelFamily: "opencode/muse-spark-1.2-contributor-free",
  agentType: "opencode",
  outfit: {
    hat: "none",
    color: "#C97B4A",
    hair: "#3B2A20",
    hairStyle: "bun",
    skin: "#E8B48A",
    beard: "none",
    accessory: "glasses",
  },
} as unknown as AgentInfo;

describe("ReceptionistFigure", () => {
  it("draws the character with its feet at the origin, a nametag, and the click hook", () => {
    const markup = renderToStaticMarkup(
      <svg>
        <ReceptionistFigure agent={AGENT} />
      </svg>,
    );
    expect(markup).toContain('data-receptionist="agent-r"');
    const anchor = markup.match(
      /transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"/,
    );
    expect(anchor).not.toBeNull();
    const [tx, ty, sc] = anchor!.slice(1).map(Number);
    expect(tx + (CHARACTER_GEOMETRY.width / 2) * sc).toBeCloseTo(0, 5);
    expect(ty + CHARACTER_GEOMETRY.feetY * sc).toBeCloseTo(0, 5);
    expect(markup).toContain(">Receptionist</span>");
    expect(markup).toContain("pointer-events:all");
    expect(markup).toContain("data-no-pan");
    expect(markup).toContain('fill="transparent"');
    expect(markup).not.toContain("NaN");
  });

  // The badge is the pill's purple chip after the name; the waiting state
  // is the same in both renders, so only needsAttention differs.
  it("shows the unread badge only when the agent needs attention", () => {
    const draw = (needsAttention: boolean) =>
      renderToStaticMarkup(
        <svg>
          <ReceptionistFigure
            agent={{ ...AGENT, state: "waiting_for_response" }}
            needsAttention={needsAttention}
          />
        </svg>,
      );
    const badge = /background:var\(--purple-text\)[^>]*>[^<]+<\/span>/;
    expect(draw(true)).toMatch(badge);
    expect(draw(false)).not.toMatch(badge);
  });
});
