import { describe, expect, it } from "bun:test";
import {
  webhookViewerForIdentity,
  webhookVisibleTo,
  type WebhookViewer,
  type WebhookVisibilityFacts,
} from "./webhook-visibility.ts";
import {
  AGENT_CAPABILITIES,
  API_CAPABILITIES,
  RUN_CAPABILITIES,
  USER_CAPABILITIES,
  type Identity,
} from "./identity/index.ts";

const ROOM = "a1a1a1a1";
const OTHER_ROOM = "b2b2b2b2";

const facts = (
  over: Partial<WebhookVisibilityFacts> = {},
): WebhookVisibilityFacts => ({
  ownerUserId: "u-owner",
  liveRoomId: ROOM,
  ...over,
});

const viewer = (over: Partial<WebhookViewer> = {}): WebhookViewer => ({
  userId: "u-viewer",
  participates: true,
  officeWide: false,
  hasRoomAccess: () => false,
  ...over,
});

const inRoom = (roomId: string) => (id: string) => id === roomId;

describe("webhookVisibleTo", () => {
  it("the owner, an office-wide viewer and a member of the live room see the hook", () => {
    expect(webhookVisibleTo(facts(), viewer({ userId: "u-owner" }))).toBe(true);
    expect(webhookVisibleTo(facts(), viewer({ officeWide: true }))).toBe(true);
    expect(
      webhookVisibleTo(facts(), viewer({ hasRoomAccess: inRoom(ROOM) })),
    ).toBe(true);
  });

  it("a member of another room, and anyone once the hook has no room, do not", () => {
    expect(
      webhookVisibleTo(facts(), viewer({ hasRoomAccess: inRoom(OTHER_ROOM) })),
    ).toBe(false);
    expect(
      webhookVisibleTo(
        facts({ liveRoomId: null }),
        viewer({ hasRoomAccess: () => true }),
      ),
    ).toBe(false);
    expect(
      webhookVisibleTo(
        facts({ liveRoomId: null }),
        viewer({ userId: "u-owner" }),
      ),
    ).toBe(true);
  });

  it("a viewer that does not participate sees nothing, even its own hook", () => {
    expect(
      webhookVisibleTo(
        facts(),
        viewer({
          participates: false,
          userId: "u-owner",
          officeWide: true,
          hasRoomAccess: () => true,
        }),
      ),
    ).toBe(false);
  });

  it("a null viewer user id never matches the owner", () => {
    expect(webhookVisibleTo(facts(), viewer({ userId: null }))).toBe(false);
  });
});

describe("webhookViewerForIdentity", () => {
  const identity = (over: Partial<Identity>): Identity => ({
    scope: "user",
    userId: "u-1",
    role: "member",
    capabilities: USER_CAPABILITIES,
    ...over,
  });
  const owners = (userId: string) => userId === "u-boss";

  it("a user, an API token and an agent participate; a cron run and an agent without webhook:read do not", () => {
    const at = (i: Identity) =>
      webhookViewerForIdentity(i, owners, () => false).participates;
    expect(at(identity({}))).toBe(true);
    expect(at(identity({ scope: "api", capabilities: API_CAPABILITIES }))).toBe(
      true,
    );
    expect(
      at(
        identity({
          scope: "agent",
          agentId: "agent-1",
          capabilities: AGENT_CAPABILITIES,
        }),
      ),
    ).toBe(true);
    expect(
      at(
        identity({
          scope: "agent",
          agentId: "agent-1",
          capabilities: AGENT_CAPABILITIES.filter((c) => c !== "webhook:read"),
        }),
      ),
    ).toBe(false);
    expect(
      at(identity({ scope: "cron-run", capabilities: RUN_CAPABILITIES })),
    ).toBe(false);
  });

  it("office-wide reach follows the live owner record, for an agent of an owner too", () => {
    expect(
      webhookViewerForIdentity(
        identity({ userId: "u-boss" }),
        owners,
        () => false,
      ).officeWide,
    ).toBe(true);
    expect(
      webhookViewerForIdentity(
        identity({
          scope: "agent",
          agentId: "agent-1",
          userId: "u-boss",
          capabilities: AGENT_CAPABILITIES,
        }),
        owners,
        () => false,
      ).officeWide,
    ).toBe(true);
    expect(
      webhookViewerForIdentity(identity({}), owners, () => false).officeWide,
    ).toBe(false);
  });
});
