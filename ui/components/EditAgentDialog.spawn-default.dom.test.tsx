// The stop a new agent starts at (task 9279a412; Nil, 2026-11-05: a
// human-spawned agent defaults to Privileged). The slider is not touched: the
// save sends what the dialog opened at. A member with a permission pack starts
// at the pack's agent ceiling, which is below Privileged. How a save at each
// stop is sent is in EditAgentDialog.spawn-access.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { AGENT_ACCESS_STOPS } = await import("../../shared/agent-access.ts");
const {
  cleanup,
  renderSpawn,
  route,
  save,
  settle,
  shim,
  stopChecked,
  stopDisabled,
  user,
  viewer,
} = await import("../test-support/access-slider-fixture.tsx");
const { room } = await import("../test-support/claude-limits-fixture.tsx");

// The viewer as member `id` of the fixture's users.
function asMember(id: string, name: string) {
  return { ...viewer([]), userId: id, username: name, role: "member" as const };
}

function checkedStop(container: HTMLElement) {
  return AGENT_ACCESS_STOPS.find((stop) => stopChecked(container, stop));
}

describe("a new agent's default stop", () => {
  it("is Privileged for an owner and for a member without a pack: an untouched save is the spawn, then one PUT /access to Privileged", async () => {
    const spawners = [
      ["owner", viewer([])],
      ["member", asMember("member", "Member")],
    ] as const;
    for (const [who, session] of spawners) {
      const calls = shim();
      const view = renderSpawn(session);
      try {
        await settle();
        expect({ who, stop: checkedStop(view.container) }).toEqual({
          who,
          stop: "privileged",
        });
        await save(view.container);
        expect({ who, order: calls.map(route) }).toEqual({
          who,
          order: ["POST /api/agents", "PUT :id/access"],
        });
        expect({
          who,
          access: (calls[0].body as { access?: unknown }).access,
          put: calls[1].body,
        }).toEqual({ who, access: undefined, put: { access: "privileged" } });
      } finally {
        cleanup(view);
      }
    }
  });

  // Every pack ceiling is below Privileged (MEMBER_CEILING_STOPS), so the
  // ceiling wins: the spawn carries it, and nothing raises the agent after.
  // The agent works in the room's folder (task 329974fe): the member sets no
  // folder, so the spawn carries none.
  it("is the pack's agent ceiling for a member with a permission pack: an untouched save sends it in the spawn, with no PUT /access and no folder", async () => {
    const calls = shim();
    const view = renderSpawn(asMember("packed", "Packed"), packed, {
      ...room,
      cwd: ROOM_FOLDER,
    });
    try {
      await settle();
      expect(checkedStop(view.container)).toBe("web");
      // The dialog shows the room folder.
      expect(shownValues(view.container)).toContain(ROOM_FOLDER);
      await save(view.container);
      expect(calls.map(route)).toEqual(["POST /api/agents"]);
      expect(calls[0].body).toMatchObject({ access: "web" });
      expect(Object.keys(calls[0].body as object)).not.toContain("cwd");
    } finally {
      cleanup(view);
    }
  });

  // A room with no folder is the home folder, which a Folder agent may not
  // have: the member's agent starts at Office there.
  it("is Office for a member with a pack in a room with no folder", async () => {
    const calls = shim();
    const view = renderSpawn(asMember("packed", "Packed"), packed);
    try {
      await settle();
      expect({
        checked: checkedStop(view.container),
        folder: stopDisabled(view.container, "folder"),
        web: stopDisabled(view.container, "web"),
      }).toEqual({ checked: "office", folder: true, web: true });
      await save(view.container);
      expect(calls.map(route)).toEqual(["POST /api/agents"]);
      expect(calls[0].body).toMatchObject({ access: "office" });
      expect(Object.keys(calls[0].body as object)).not.toContain("cwd");
    } finally {
      cleanup(view);
    }
  });
});

const ROOM_FOLDER = "/srv/studio";

// A member whose pack goes up to Web.
const packed = {
  ...user("packed", "Packed", "member"),
  pack: {
    areas: { asks: "write" as const },
    agentCeiling: "web" as const,
  },
};

// What the dialog shows: the values of its inputs and its text.
function shownValues(container: HTMLElement): string[] {
  return [
    ...[...container.querySelectorAll("input")].map((input) => input.value),
    ...[...container.querySelectorAll("*")]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent ?? ""),
  ];
}
