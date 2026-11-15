// One OpenCode authority broker per member with their own OS user (slice
// 2d-ii-b of task b94dfd25): their OpenCode runs as their uid, which cannot
// reach the office's socket, so their agents get <share>/authority/
// authority.sock (folder 02750, socket 0660), served for their uid only. The
// broker closes, and its socket goes, when the member's host is forgotten
// (disable, an undone enable).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { chmodShare } from "../../split/share-mode.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvForUserId } from "../../env-loader.ts";
import { forgetMemberHost } from "../../member-hosts.ts";
import { recordMemberOsUser } from "../../member-os-users.ts";
import { setMemberShareRoot } from "../../member-runtime.ts";
import { createMember, deleteUserById } from "../../users.ts";
import {
  isolateMember,
  type IsolatedMember,
} from "../../test-support/member-host-fixture.ts";
import {
  closeMemberAuthorityBroker,
  openCodeAuthorityBroker,
  openCodeAuthorityBrokerForEnv,
} from "./authority-broker.ts";

let root: string;
let iso: IsolatedMember;
let alice: string;
let share: string;
const modeOf = (path: string) => lstatSync(path).mode & 0o7777;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "member-authority-"));
  setMemberShareRoot(root);
  const made = createMember(`BrokerAlice${Date.now()}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  iso = await isolateMember(alice);
  // Alice's share, setgid, as root makes it at enable.
  share = join(root, iso.member.host.username());
  mkdirSync(share);
  chmodShare(share, 0o2750);
});

afterEach(() => {
  closeMemberAuthorityBroker(alice);
  iso.dispose();
  deleteUserById(alice);
  setMemberShareRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("a member's OpenCode authority broker", () => {
  it("listens in their share, not at the office's socket: a setgid folder and a 0660 socket of the share's group", () => {
    const broker = openCodeAuthorityBrokerForEnv(buildEnvForUserId(alice));
    expect(broker).not.toBe(openCodeAuthorityBroker);
    const binding = broker.bind("agent-a", "token-a");
    try {
      const socket = join(share, "authority", "authority.sock");
      expect(binding.socketPath).toBe(socket);
      expect(lstatSync(socket).isSocket()).toBe(true);
      expect(modeOf(socket)).toBe(0o660);
      expect(modeOf(join(share, "authority"))).toBe(0o2750);
      expect(lstatSync(socket).gid).toBe(lstatSync(share).gid);
    } finally {
      binding.unbind();
    }
  });

  // Round 1 F1: the bit and the group come only from the share; a share
  // without the bit gives the member no socket.
  it("does not listen when the share has no setgid bit", () => {
    chmodSync(share, 0o750);
    const broker = openCodeAuthorityBrokerForEnv(buildEnvForUserId(alice));
    expect(() => broker.bind("agent-a", "token-a")).toThrow();
    expect(existsSync(join(share, "authority", "authority.sock"))).toBe(false);
  });

  it("is one broker for every agent of the member", () => {
    const env = buildEnvForUserId(alice);
    expect(openCodeAuthorityBrokerForEnv(env)).toBe(
      openCodeAuthorityBrokerForEnv(env),
    );
  });

  it("an office agent keeps the office's broker", () => {
    expect(openCodeAuthorityBrokerForEnv(undefined)).toBe(
      openCodeAuthorityBroker,
    );
    expect(openCodeAuthorityBrokerForEnv(process.env)).toBe(
      openCodeAuthorityBroker,
    );
  });

  it("closes, and its socket goes, when the member's host is forgotten", () => {
    const env = buildEnvForUserId(alice);
    const broker = openCodeAuthorityBrokerForEnv(env);
    const binding = broker.bind("agent-a", "token-a");
    expect(existsSync(binding.socketPath)).toBe(true);
    forgetMemberHost(alice);
    expect(existsSync(binding.socketPath)).toBe(false);
    // The next agent of the member gets a new broker.
    expect(openCodeAuthorityBrokerForEnv(env)).not.toBe(broker);
  });

  it("is replaced, and the old one closed, when the member's OS user changes", () => {
    const env = buildEnvForUserId(alice);
    const before = openCodeAuthorityBrokerForEnv(env);
    const binding = before.bind("agent-a", "token-a");
    recordMemberOsUser(alice, {
      name: iso.member.host.username(),
      uid: process.getuid!() + 1,
    });
    const after = openCodeAuthorityBrokerForEnv(env);
    expect(after).not.toBe(before);
    // The old broker was closed: its socket went, and only the new one
    // listens there once it binds.
    expect(existsSync(binding.socketPath)).toBe(false);
    const next = after.bind("agent-a", "token-a");
    expect(lstatSync(next.socketPath).isSocket()).toBe(true);
    next.unbind();
  });
});
