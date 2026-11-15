// Part 3d, C2 (task b94dfd25): the lowest writer of an agent's manager,
// OfficeState.updateAgent, refuses a change between hosts on its own, so a
// new path that skips the callers' check fails loudly and changes nothing.
import { afterEach, expect, it } from "bun:test";
import { rmSync } from "fs";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentInfo } from "../../shared/types.ts";
import {
  assertSameAgentHost,
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "../member-os-users.ts";

afterEach(() => {
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
});

// MUTANT: updateAgent without the beforeManagerChange call (dies on the
// throw and on the unchanged manager).
it("refuses a manager on another host in updateAgent, and changes nothing", () => {
  recordMemberOsUser("u-alice", { name: "isomux-test-alice", uid: 4646 });
  const state = new OfficeState();
  state.beforeManagerChange = assertSameAgentHost;
  state.addExistingAgent({
    id: "a1",
    name: "Office worker",
    userId: "u-owner",
    manager: "Owner",
  } as AgentInfo);
  expect(() =>
    state.updateAgent("a1", { userId: "u-alice", manager: "Alice" }),
  ).toThrow();
  expect([state.getAgent("a1")?.userId, state.getAgent("a1")?.manager]).toEqual(
    ["u-owner", "Owner"],
  );
  // The enabling condition: a change on one host, and a patch without a
  // manager change, go through.
  state.updateAgent("a1", { userId: "u-bob", manager: "Bob" });
  state.updateAgent("a1", { name: "Renamed" });
  expect([state.getAgent("a1")?.userId, state.getAgent("a1")?.name]).toEqual([
    "u-bob",
    "Renamed",
  ]);
});
