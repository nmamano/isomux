// The route-table side of member permission packs (task 134b8f77, part 2):
// a member with a pack carries it as limits, and the executor refuses a route
// without an area, so every route a member reaches declares one; and the file
// panel routes check that the agent fits. The behavior is member-pack.test.ts.

import { expect, it } from "bun:test";
import { API_ROUTES } from "../routes/table.ts";
import { passesRouteStageOne } from "../identity/dispatch.ts";
import { USER_CAPABILITIES, type Identity } from "../identity/index.ts";
import type { GuardDeps } from "../identity/guards.ts";
import { FILE_FIT } from "../identity/agent-fit.ts";

// Whether a member may reach `route`: stage 1, and a stage 2 guard that does
// not refuse the member before it reads any office state (as officeOwner
// does). A guard that needs office state may allow, so it counts.
function memberMayReach(
  route: (typeof API_ROUTES)[number],
  identity: Identity,
): boolean {
  if (!passesRouteStageOne(route.auth, identity)) return false;
  if (route.auth.kind !== "capability") return true;
  const needsState = new Proxy(
    {},
    {
      get() {
        throw new Error("reads office state");
      },
    },
  );
  try {
    return route.auth.resourceGuard({
      identity,
      params: needsState as Record<string, string>,
      body: {},
      deps: needsState as GuardDeps,
    }).ok;
  } catch {
    return true;
  }
}

it("every route a member reaches declares a known area, so a pack limits it", () => {
  // Task 134b8f77 part 2: a member with a permission pack carries it as
  // limits, and the executor refuses a route without an area. Computed with
  // a member identity, so a route only an office owner reaches drops out.
  const memberIdentity: Identity = {
    scope: "user",
    userId: "u-member",
    role: "member",
    capabilities: USER_CAPABILITIES,
  };
  const memberStageOne = API_ROUTES.filter((route) =>
    memberMayReach(route, memberIdentity),
  );
  expect(memberStageOne.length).toBeGreaterThan(100);
  // What drops out is what a member never reaches, such as an owner-only
  // route; a route an owner or the agent's manager reaches stays in.
  const opIds = memberStageOne.map((route) => route.opId);
  expect(opIds).not.toContain("users.setAccess");
  expect(opIds).toContain("agents.setAccess");
  const missing = memberStageOne
    .filter((route) => route.tokenArea === undefined)
    .map((route) => route.opId);
  expect(missing).toEqual([]);
  // Pairing a browser lends tabs to agents; a provider sign-in is the
  // environment agents run in.
  for (const route of memberStageOne.filter(
    (r) =>
      r.opId.startsWith("browser.") || r.opId.startsWith("providerAccounts."),
  ))
    expect({
      opId: route.opId,
      area:
        typeof route.tokenArea === "object" ? route.tokenArea.area : undefined,
    }).toEqual({
      opId: route.opId,
      area: route.opId.startsWith("browser.") ? "agents" : "environment",
    });
});

it("every files route a member reaches on an agent checks that the agent fits", () => {
  // The file panel opens an agent's files: a member with a pack opens it
  // only on agents that fit the pack. A route missing from FILE_FIT would
  // open any agent's files.
  const memberIdentity: Identity = {
    scope: "user",
    userId: "u-member",
    role: "member",
    capabilities: USER_CAPABILITIES,
  };
  const fileRoutes = API_ROUTES.filter(
    (route) =>
      typeof route.tokenArea === "object" &&
      route.tokenArea.area === "files" &&
      route.path.startsWith("/api/agents/:id") &&
      memberMayReach(route, memberIdentity),
  ).map((route) => route.opId);
  expect(fileRoutes.sort()).toEqual([
    "agents.closeFile",
    "agents.openFile",
    "agents.saveFile",
  ]);
  expect(Object.keys(FILE_FIT).sort()).toEqual(fileRoutes);
  for (const opId of fileRoutes)
    expect({ opId, fit: FILE_FIT[opId] }).toEqual({
      opId,
      fit: { kind: "param", name: "id" },
    });
});

it("the routes every pack lets a member call are their own pages", () => {
  // A pack with no area still lets the member manage their own view,
  // preferences, record, sign-ins, sessions and API tokens, and read the
  // agent reference. Anything added here is reachable by a Read only member.
  const memberIdentity: Identity = {
    scope: "user",
    userId: "u-member",
    role: "member",
    capabilities: USER_CAPABILITIES,
  };
  expect(
    API_ROUTES.filter(
      (route) =>
        route.tokenArea === "always" && memberMayReach(route, memberIdentity),
    )
      .map((route) => route.opId)
      .sort(),
  ).toEqual(
    [
      "agentReference.get",
      "agentReference.list",
      "apiTokens.list",
      "apiTokens.mint",
      "apiTokens.revoke",
      "connections.list",
      "invites.list",
      "invites.mintSelf",
      "invites.revoke",
      "prefs.update",
      "sessions.list",
      "sessions.revoke",
      "users.delete",
      "users.update",
      "view.listRooms",
      "view.setNotifRooms",
      "view.setOrder",
      "view.setPushRooms",
      "view.setShown",
      "view.setTucked",
    ].sort(),
  );
});
