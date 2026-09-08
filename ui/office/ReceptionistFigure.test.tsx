import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceptionistFigure } from "./ReceptionistFigure.tsx";
import { LOBBY_ROOM_ID, type AgentInfo } from "../../shared/types.ts";

const AGENT = {
  id: "agent-r",
  name: "Receptionist",
  desk: 0,
  roomId: LOBBY_ROOM_ID,
  receptionist: true,
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
    expect(markup).toContain('transform="translate(-40 -108.4) scale(2)"');
    expect(markup).toContain(">Receptionist</text>");
    expect(markup).toContain("pointer-events:all");
    expect(markup).toContain("data-no-pan");
    expect(markup).toContain('fill="transparent"');
    expect(markup).not.toContain("unread");
    expect(markup).not.toContain("NaN");
  });

  it("shows the unread badge when the agent needs attention", () => {
    const markup = renderToStaticMarkup(
      <svg>
        <ReceptionistFigure
          agent={{ ...AGENT, state: "waiting_for_response" }}
          needsAttention
        />
      </svg>,
    );
    expect(markup).toContain(">unread</text>");
    expect(markup).toContain("var(--purple)");
  });
});
