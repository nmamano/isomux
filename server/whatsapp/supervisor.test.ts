// WhatsApp supervisor (task d03a61d8): one bridge child per member, driven
// through a fake child that speaks the stdio protocol, a fake clock and a real
// temp STATE_ROOT. Pins the link flow, what each disconnect does, the crash
// backoff and give-up, the memory watchdog, unlink and member removal, the
// boot sweep, and the child's environment.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  WHATSAPP_BACKOFF_FIRST_MS,
  WHATSAPP_CHATS_SEEN_MAX,
  WHATSAPP_BACKOFF_MAX_MS,
  WHATSAPP_FAILURE_WINDOW_MS,
  WHATSAPP_LOGOUT_WAIT_MS,
  WHATSAPP_MAX_FAILURES,
  WHATSAPP_PAIRING_COOLDOWN_MS,
  WHATSAPP_RSS_LIMIT,
  WHATSAPP_RSS_SAMPLE_MS,
  WHATSAPP_SEND_TIMEOUT_MS,
  createWhatsAppSupervisor,
  type BridgeChild,
  type BridgeSpawnSpec,
  type WhatsAppSupervisor,
} from "./supervisor.ts";
import {
  memberDir,
  readLink,
  whatsappRoot,
  writeLink,
  WHATSAPP_RUNTIME_DIR,
} from "./store.ts";
import type { BridgeCommand, BridgeEvent } from "./protocol.ts";
import { DISCONNECT } from "./protocol.ts";
import type { InstallResult } from "./installer.ts";
import type { WhatsAppStatus } from "../../shared/whatsapp.ts";

const U = "u-alice";
const V = "u-bob";
const PHONE = "447700900123";
const MINUTE = 60_000;

// Lets the supervisor's promise chains run (its fs work is synchronous).
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class FakeClock {
  t = 1_800_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  // Runs every timer due within ms, in time order, letting the supervisor
  // react after each.
  async advance(ms: number): Promise<void> {
    await settle();
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers)
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at))
          next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

// A bridge child that answers the protocol as the real one does: logout ends
// in a loggedOut close and an exit, stop and kill end in an exit. A deaf child
// ignores logout and stop.
class FakeChild implements BridgeChild {
  sent: BridgeCommand[] = [];
  kills = 0;
  exited = false;
  deaf = false;
  private eventListeners: ((event: BridgeEvent) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  constructor(readonly pid: number) {}
  send(cmd: BridgeCommand): void {
    this.sent.push(cmd);
    if (this.deaf || this.exited) return;
    if (cmd.op === "logout")
      queueMicrotask(() => {
        this.emit({ ev: "closed", statusCode: DISCONNECT.loggedOut });
        this.exit(0);
      });
    if (cmd.op === "stop") queueMicrotask(() => this.exit(0));
  }
  kill(): void {
    this.kills++;
    queueMicrotask(() => this.exit(null));
  }
  onEvent(listener: (event: BridgeEvent) => void): void {
    this.eventListeners.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }
  emit(event: BridgeEvent): void {
    if (this.exited) return;
    for (const l of this.eventListeners) l(event);
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitListeners) l(code);
  }
  // A disconnect as the bridge reports it: the close, then the process ends.
  close(statusCode: number | null): void {
    this.emit({ ev: "closed", statusCode });
    this.exit(0);
  }
}

const BASE_ENV = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/office",
  ISOMUX_AGENT_TOKEN: "agent-token-must-not-leak",
  ISOMUX_PORT: "4000",
  ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
  OPENAI_API_KEY: "sk-must-not-leak",
};

const svgOf = (code: string) => `<svg data-code="${code}"/>`;

interface Harness {
  sup: WhatsAppSupervisor;
  stateRoot: string;
  clock: FakeClock;
  spawns: { spec: BridgeSpawnSpec; child: FakeChild }[];
  installs: number;
  installResult: InstallResult;
  pages: { userId: string; key: string }[];
  emits: { userId: string; status: WhatsAppStatus }[];
  rss: Map<number, number | null>;
  // Faults of the office around the supervisor: the pager store cannot save,
  // or the next spawns fail (for example the Bun binary moved in an update).
  pagerThrows: boolean;
  spawnFailures: number;
  // Slice 2 hooks: each member's routed chats, and what reached the hooks.
  allow: Map<string, string[]>;
  hookCalls: (
    | { hook: "onMessage"; userId: string; id: string }
    | { hook: "onLinked"; userId: string; phone: string }
    | { hook: "onUnlinked"; userId: string }
    | { hook: "onShutdown"; childrenRunning: number }
  )[];
  onMessageThrows: boolean;
  childOf(userId: string): FakeChild[];
}

let current: Harness | null = null;
afterEach(async () => {
  if (!current) return;
  const h = current;
  current = null;
  const done = h.sup.shutdown();
  await h.clock.advance(WHATSAPP_LOGOUT_WAIT_MS);
  await done;
  rmSync(h.stateRoot, { recursive: true, force: true });
});

function harness(): Harness {
  const stateRoot = mkdtempSync(join(tmpdir(), "t-d03a61d8-sup-"));
  const clock = new FakeClock();
  let pid = 4000;
  const h: Harness = {
    sup: undefined as unknown as WhatsAppSupervisor,
    stateRoot,
    clock,
    spawns: [],
    installs: 0,
    installResult: {
      ok: true,
      runtimeDir: join(stateRoot, "whatsapp", "runtime"),
    },
    pages: [],
    emits: [],
    rss: new Map(),
    pagerThrows: false,
    spawnFailures: 0,
    allow: new Map(),
    hookCalls: [],
    onMessageThrows: false,
    childOf: (userId) =>
      h.spawns
        .filter((s) => s.spec.cwd === memberDir(stateRoot, userId))
        .map((s) => s.child),
  };
  h.sup = createWhatsAppSupervisor({
    stateRoot,
    bridgeEntry: "/opt/isomux/server/whatsapp/bridge.ts",
    bunPath: "/opt/bun/bin/bun",
    baseEnv: BASE_ENV,
    spawner: (spec) => {
      if (h.spawnFailures > 0) {
        h.spawnFailures--;
        throw new Error("spawn ENOENT");
      }
      const child = new FakeChild(++pid);
      h.spawns.push({ spec, child });
      return child;
    },
    installer: {
      ensure: async () => {
        h.installs++;
        return h.installResult;
      },
    },
    clock,
    readRss: (p) => h.rss.get(p) ?? null,
    pager: {
      raise: (userId, key) => {
        if (h.pagerThrows) throw new Error("pager file not writable");
        h.pages.push({ userId, key });
      },
    },
    renderQr: svgOf,
    emitStatus: (userId, status) => {
      h.emits.push({ userId, status: structuredClone(status) });
    },
    hooks: {
      allowlist: (userId) => h.allow.get(userId) ?? [],
      onMessage: (userId, msg) => {
        if (h.onMessageThrows) throw new Error("inbound failed");
        h.hookCalls.push({ hook: "onMessage", userId, id: msg.id });
      },
      onLinked: (userId, phone) =>
        void h.hookCalls.push({ hook: "onLinked", userId, phone }),
      onUnlinked: (userId) =>
        void h.hookCalls.push({ hook: "onUnlinked", userId }),
      onShutdown: () =>
        void h.hookCalls.push({
          hook: "onShutdown",
          childrenRunning: h.spawns.filter((sp) => !sp.child.exited).length,
        }),
    },
  });
  current = h;
  return h;
}

// A member who linked before this boot.
async function bootLinked(h: Harness): Promise<FakeChild> {
  writeLink(h.stateRoot, U, { phone: PHONE, linkedAt: 5 });
  await h.sup.boot();
  await until(() => h.childOf(U).length === 1, "the boot spawn");
  return h.childOf(U)[0];
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

describe("whatsapp supervisor: linking", () => {
  it("a QR link: one child in the member's 0700 dir with only the allowed env; the QR reaches that member; the accepted link is saved", async () => {
    const h = harness();
    const res = await h.sup.link(U, { method: "qr" });
    expect(res).toEqual({
      ok: true,
      status: { state: "linking", method: "qr" },
    });
    expect(h.installs).toBe(1);
    expect(h.spawns).toHaveLength(1);
    const { spec, child } = h.spawns[0];
    expect(spec.cwd).toBe(memberDir(h.stateRoot, U));
    expect(statSync(spec.cwd).mode & 0o777).toBe(0o700);
    // The child runs third-party code: no office token, provider key or
    // office variable, only the allowed keys the server has.
    expect(spec.env).toEqual({ PATH: BASE_ENV.PATH, HOME: BASE_ENV.HOME });
    expect(spec.argv[0]).toBe("/opt/bun/bin/bun");
    expect(spec.argv).toContain("/opt/isomux/server/whatsapp/bridge.ts");
    // The allowlist first, before the link (slice 2).
    expect(child.sent).toEqual([
      { op: "routes", chats: [] },
      { op: "link", method: "qr" },
    ]);

    await h.sup.link(V, { method: "qr" });
    child.emit({ ev: "qr", code: "QR-ALICE-1" });
    const linking: WhatsAppStatus = {
      state: "linking",
      method: "qr",
      qrSvg: svgOf("QR-ALICE-1"),
    };
    await until(
      () => h.sup.status(U).state === "linking" && "qrSvg" in h.sup.status(U),
      "the QR status",
    );
    expect(h.sup.status(U)).toEqual(linking);
    expect(last(h.emits)).toEqual({ userId: U, status: linking });
    // Bob's link sees none of it.
    expect(h.sup.status(V)).toEqual({ state: "linking", method: "qr" });
    expect(
      h.emits.filter(
        (e) => e.userId !== U && JSON.stringify(e).includes("QR-ALICE-1"),
      ),
    ).toEqual([]);

    child.emit({ ev: "linked", phone: PHONE });
    await until(() => h.sup.status(U).state === "linked", "the linked status");
    expect(readLink(h.stateRoot, U)).toEqual({
      phone: PHONE,
      linkedAt: h.clock.now(),
    });
    expect(
      statSync(join(memberDir(h.stateRoot, U), "link.json")).mode & 0o777,
    ).toBe(0o600);
    expect(h.sup.status(U)).toMatchObject({ state: "linked", phone: PHONE });
    expect(last(h.emits)).toMatchObject({
      userId: U,
      status: { state: "linked", phone: PHONE },
    });
    expect(h.pages).toEqual([]);
  });

  it("restartRequired right after pairing restarts at once; open marks the link connected", async () => {
    const h = harness();
    await h.sup.link(U, { method: "qr" });
    const first = h.spawns[0].child;
    first.emit({ ev: "linked", phone: PHONE });
    await until(() => readLink(h.stateRoot, U) !== null, "link.json");
    first.close(DISCONNECT.restartRequired);
    await h.clock.advance(0);
    expect(h.childOf(U)).toHaveLength(2);
    const second = h.childOf(U)[1];
    second.emit({ ev: "open" });
    await until(
      () =>
        h.sup.status(U).state === "linked" &&
        (h.sup.status(U) as { connected?: boolean }).connected === true,
      "the connected status",
    );
    expect(h.sup.status(U)).toEqual({
      state: "linked",
      phone: PHONE,
      linkedAt: readLink(h.stateRoot, U)!.linkedAt,
      connected: true,
    });
    expect(last(h.emits)).toEqual({ userId: U, status: h.sup.status(U) });
    expect(h.pages).toEqual([]);
  });

  it("a pairing code goes to the normalised number and reaches the member", async () => {
    const h = harness();
    const res = await h.sup.link(U, {
      method: "code",
      phone: "+44 7700-900 123",
    });
    expect(res.ok).toBe(true);
    const child = h.spawns[0].child;
    expect(child.sent).toEqual([
      { op: "routes", chats: [] },
      { op: "link", method: "code", phone: PHONE },
    ]);
    child.emit({ ev: "pairing-code", code: "ABCD1234" });
    await until(() => "pairingCode" in h.sup.status(U), "the code status");
    expect(h.sup.status(U)).toEqual({
      state: "linking",
      method: "code",
      pairingCode: "ABCD1234",
    });
  });

  it("refuses a bad number before any download, a second link while linking, and a second code within the cooldown", async () => {
    const h = harness();
    const bad = await h.sup.link(U, { method: "code", phone: "12345" });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect(h.installs).toBe(0);
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });

    expect((await h.sup.link(U, { method: "code", phone: PHONE })).ok).toBe(
      true,
    );
    expect(await h.sup.link(U, { method: "qr" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(h.spawns).toHaveLength(1);

    // Cancelled, then a new code at once: the number gets no second push.
    await h.sup.unlink(U);
    expect(await h.sup.link(U, { method: "code", phone: PHONE })).toMatchObject(
      { ok: false, status: 429 },
    );
    expect(h.spawns).toHaveLength(1);
    // The cooldown is for codes only.
    expect((await h.sup.link(U, { method: "qr" })).ok).toBe(true);
    expect(h.spawns).toHaveLength(2);
    await h.sup.unlink(U);

    await h.clock.advance(WHATSAPP_PAIRING_COOLDOWN_MS);
    expect((await h.sup.link(U, { method: "code", phone: PHONE })).ok).toBe(
      true,
    );
    expect(h.spawns).toHaveLength(3);
  });

  it("a failed download leaves the member unlinked with the reason: no child, no page", async () => {
    const h = harness();
    h.installResult = { ok: false };
    const res = await h.sup.link(U, { method: "qr" });
    expect(res).toEqual({
      ok: true,
      status: { state: "unlinked", reason: "install_failed" },
    });
    expect(h.sup.status(U)).toEqual({
      state: "unlinked",
      reason: "install_failed",
    });
    expect(h.spawns).toHaveLength(0);
    expect(h.pages).toEqual([]);
  });

  it("a link nobody completes expires: unlinked with the reason, its directory gone, no page, no restart", async () => {
    const h = harness();
    await h.sup.link(U, { method: "qr" });
    h.spawns[0].child.emit({ ev: "qr", code: "QR-1" });
    h.spawns[0].child.close(DISCONNECT.timedOut);
    await until(() => h.sup.status(U).state === "unlinked", "the expiry");
    expect(h.sup.status(U)).toEqual({
      state: "unlinked",
      reason: "link_expired",
    });
    expect(last(h.emits)).toEqual({ userId: U, status: h.sup.status(U) });
    await until(
      () => !existsSync(memberDir(h.stateRoot, U)),
      "the dir removal",
    );
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([]);
  });

  it("unlink during a link cancels it: the child ends, the directory goes", async () => {
    const h = harness();
    await h.sup.link(U, { method: "qr" });
    const child = h.spawns[0].child;
    const done = h.sup.unlink(U);
    await h.clock.advance(WHATSAPP_LOGOUT_WAIT_MS);
    await done;
    expect(child.exited).toBe(true);
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([]);
  });
});

describe("whatsapp supervisor: boot", () => {
  it("starts a child only for linked members, after the download check, and sweeps an interrupted link", async () => {
    const h = harness();
    writeLink(h.stateRoot, U, { phone: PHONE, linkedAt: 5 });
    // Bob's link was interrupted by a restart: credentials, no link.json.
    const bobDir = memberDir(h.stateRoot, V);
    mkdirSync(join(bobDir, "auth"), { recursive: true });
    writeFileSync(join(bobDir, "auth", "creds.json"), "{}");
    // The downloaded package is not a member.
    const runtime = join(whatsappRoot(h.stateRoot), WHATSAPP_RUNTIME_DIR);
    mkdirSync(join(runtime, "node_modules"), { recursive: true });
    writeFileSync(join(runtime, "bun.lock"), "{}");

    await h.sup.boot();
    await until(() => h.spawns.length === 1, "the boot spawn");
    expect(h.installs).toBe(1);
    expect(h.spawns[0].spec.cwd).toBe(memberDir(h.stateRoot, U));
    expect(existsSync(bobDir)).toBe(false);
    expect(existsSync(join(runtime, "bun.lock"))).toBe(true);
    expect(h.sup.status(U)).toEqual({
      state: "linked",
      phone: PHONE,
      linkedAt: 5,
      connected: false,
    });
    expect(h.sup.status(V)).toEqual({ state: "unlinked" });
    await settle();
    expect(h.spawns).toHaveLength(1);
  });

  it("an office with no linked member downloads nothing and starts nothing", async () => {
    const h = harness();
    await h.sup.boot();
    await settle();
    expect(h.installs).toBe(0);
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });
  });
});

describe("whatsapp supervisor: disconnects of a linked member", () => {
  it("the phone removed the device: directory gone, unlinked with the reason, one page, no restart", async () => {
    const h = harness();
    const child = await bootLinked(h);
    child.close(DISCONNECT.loggedOut);
    await until(() => h.sup.status(U).state === "unlinked", "the unlink");
    expect(h.sup.status(U)).toEqual({
      state: "unlinked",
      reason: "unlinked_by_phone",
    });
    await until(
      () => !existsSync(memberDir(h.stateRoot, U)),
      "the dir removal",
    );
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([
      { userId: U, key: `whatsapp:${U}:unlinked-by-phone` },
    ]);
  });

  it("another client took the session: dead with the reason, one page, no restart", async () => {
    const h = harness();
    const child = await bootLinked(h);
    child.close(DISCONNECT.connectionReplaced);
    await until(() => h.sup.status(U).state === "dead", "dead");
    expect(h.sup.status(U)).toEqual({
      state: "dead",
      reason: "replaced",
      phone: PHONE,
    });
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([{ userId: U, key: `whatsapp:${U}:dead` }]);
  });

  it("a crash loop backs off, doubling, then shows dead with one page; a close and its exit count once", async () => {
    const h = harness();
    await bootLinked(h);
    for (let failure = 1; failure <= WHATSAPP_MAX_FAILURES; failure++) {
      const child = last(h.childOf(U));
      // Odd failures crash with no close; even ones close with an error
      // code and then exit.
      if (failure % 2 === 1) child.exit(1);
      else child.close(500);
      if (failure === WHATSAPP_MAX_FAILURES) break;
      await settle();
      if (failure <= 2) {
        const wait = WHATSAPP_BACKOFF_FIRST_MS * 2 ** (failure - 1);
        await h.clock.advance(wait - 1);
        expect(h.childOf(U)).toHaveLength(failure);
        await h.clock.advance(1);
      } else {
        await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
      }
      expect(h.childOf(U)).toHaveLength(failure + 1);
      expect(h.sup.status(U).state).toBe("linked");
    }
    await until(() => h.sup.status(U).state === "dead", "dead");
    expect(h.sup.status(U)).toEqual({
      state: "dead",
      reason: "crash_loop",
      phone: PHONE,
    });
    expect(h.pages).toEqual([{ userId: U, key: `whatsapp:${U}:dead` }]);
  });

  it("a dead crash loop keeps trying the same session at the longest backoff, with no new page, and an open heals it", async () => {
    // A network outage of a minute fails every child in a row. Giving up
    // would make each member scan their phone again.
    const h = harness();
    await bootLinked(h);
    for (let failure = 1; failure <= WHATSAPP_MAX_FAILURES; failure++) {
      last(h.childOf(U)).exit(1);
      if (failure < WHATSAPP_MAX_FAILURES)
        await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    }
    await until(() => h.sup.status(U).state === "dead", "dead");
    await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS - 1);
    expect(h.childOf(U)).toHaveLength(WHATSAPP_MAX_FAILURES);
    await h.clock.advance(1);
    expect(h.childOf(U)).toHaveLength(WHATSAPP_MAX_FAILURES + 1);
    // The same session: nothing was deleted.
    expect(readLink(h.stateRoot, U)).toEqual({ phone: PHONE, linkedAt: 5 });

    last(h.childOf(U)).exit(1);
    await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    expect(h.childOf(U)).toHaveLength(WHATSAPP_MAX_FAILURES + 2);
    expect(h.sup.status(U).state).toBe("dead");
    expect(h.pages).toEqual([{ userId: U, key: `whatsapp:${U}:dead` }]);

    last(h.childOf(U)).emit({ ev: "open" });
    await until(() => h.sup.status(U).state === "linked", "healed");
    expect(h.sup.status(U)).toEqual({
      state: "linked",
      phone: PHONE,
      linkedAt: 5,
      connected: true,
    });
    expect(last(h.emits)).toEqual({ userId: U, status: h.sup.status(U) });
  });

  it("failures further apart than the window never give up", async () => {
    const h = harness();
    await bootLinked(h);
    const crashes = WHATSAPP_MAX_FAILURES * 2;
    for (let i = 0; i < crashes; i++) {
      last(h.childOf(U)).exit(1);
      await h.clock.advance(WHATSAPP_FAILURE_WINDOW_MS + MINUTE);
    }
    expect(h.childOf(U)).toHaveLength(crashes + 1);
    expect(h.sup.status(U).state).toBe("linked");
    expect(h.pages).toEqual([]);
  });

  it("restartRequired is not a failure", async () => {
    const h = harness();
    await bootLinked(h);
    last(h.childOf(U)).close(DISCONNECT.restartRequired);
    await h.clock.advance(0);
    expect(h.childOf(U)).toHaveLength(2);
    // One failure short of the limit, unless the restart counted.
    for (let i = 1; i < WHATSAPP_MAX_FAILURES; i++) {
      last(h.childOf(U)).exit(1);
      await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    }
    expect(h.childOf(U)).toHaveLength(WHATSAPP_MAX_FAILURES + 1);
    expect(h.sup.status(U).state).toBe("linked");
    expect(h.pages).toEqual([]);
  });

  it("a child above the memory limit is killed and restarted with the backoff; at or under it, or unknown, it runs on", async () => {
    const h = harness();
    const child = await bootLinked(h);
    h.rss.set(child.pid, WHATSAPP_RSS_LIMIT);
    await h.clock.advance(WHATSAPP_RSS_SAMPLE_MS);
    h.rss.set(child.pid, null);
    await h.clock.advance(WHATSAPP_RSS_SAMPLE_MS);
    expect(child.kills).toBe(0);
    expect(child.exited).toBe(false);

    h.rss.set(child.pid, WHATSAPP_RSS_LIMIT + 1);
    await h.clock.advance(WHATSAPP_RSS_SAMPLE_MS);
    expect(child.kills).toBeGreaterThan(0);
    expect(child.exited).toBe(true);
    await h.clock.advance(WHATSAPP_BACKOFF_FIRST_MS - 1);
    expect(h.childOf(U)).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.childOf(U)).toHaveLength(2);
  });
});

describe("whatsapp supervisor: a new link from a retrying dead session", () => {
  it("ends the retry child before the new link starts: one child runs, on the new session", async () => {
    const h = harness();
    await bootLinked(h);
    for (let failure = 1; failure <= WHATSAPP_MAX_FAILURES; failure++) {
      last(h.childOf(U)).exit(1);
      if (failure < WHATSAPP_MAX_FAILURES)
        await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    }
    await until(() => h.sup.status(U).state === "dead", "dead");
    await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    // The condition: a retry child runs on the old session.
    const retry = last(h.childOf(U));
    expect(h.childOf(U)).toHaveLength(WHATSAPP_MAX_FAILURES + 1);
    expect(retry.exited).toBe(false);

    const res = await h.sup.link(U, { method: "qr" });
    expect(res.ok).toBe(true);
    await settle();
    // The old child would keep writing the old credentials into the new
    // session's directory.
    expect(retry.exited).toBe(true);
    const live = h.childOf(U).filter((c) => !c.exited);
    expect(live).toHaveLength(1);
    expect(live[0].sent).toEqual([
      { op: "routes", chats: [] },
      { op: "link", method: "qr" },
    ]);
    expect(h.sup.status(U)).toEqual({ state: "linking", method: "qr" });
  });
});

describe("whatsapp supervisor: unlink, member removal and shutdown", () => {
  it("unlink logs the device out, ends the child and deletes the directory, with no page", async () => {
    const h = harness();
    const child = await bootLinked(h);
    await h.sup.unlink(U);
    expect(child.sent).toContainEqual({ op: "logout" });
    expect(child.exited).toBe(true);
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });
    expect(last(h.emits)).toEqual({
      userId: U,
      status: { state: "unlinked" },
    });
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([]);
  });

  it("a child that does not answer the logout is killed after the wait", async () => {
    const h = harness();
    const child = await bootLinked(h);
    child.deaf = true;
    const done = h.sup.unlink(U);
    await h.clock.advance(WHATSAPP_LOGOUT_WAIT_MS - 1);
    expect(child.sent).toContainEqual({ op: "logout" });
    expect(child.kills).toBe(0);
    await h.clock.advance(1);
    await done;
    expect(child.kills).toBeGreaterThan(0);
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });
  });

  it("removing a member logs out and deletes their directory; a dead member's too", async () => {
    const h = harness();
    writeLink(h.stateRoot, V, { phone: "15550100", linkedAt: 6 });
    const child = await bootLinked(h);
    await until(() => h.childOf(V).length === 1, "Bob's spawn");

    await h.sup.removeMember(U);
    expect(child.sent).toContainEqual({ op: "logout" });
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
    expect(h.sup.status(U)).toEqual({ state: "unlinked" });

    // Bob is dead: no child runs, his credentials are still on disk.
    h.childOf(V)[0].close(DISCONNECT.connectionReplaced);
    await until(() => h.sup.status(V).state === "dead", "Bob dead");
    expect(existsSync(memberDir(h.stateRoot, V))).toBe(true);
    await h.sup.removeMember(V);
    expect(existsSync(memberDir(h.stateRoot, V))).toBe(false);
    expect(h.sup.status(V)).toEqual({ state: "unlinked" });
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(2);
  });

  it("shutdown ends every child and keeps the links: no page, no restart", async () => {
    const h = harness();
    const child = await bootLinked(h);
    const done = h.sup.shutdown();
    await h.clock.advance(WHATSAPP_LOGOUT_WAIT_MS);
    await done;
    expect(child.exited).toBe(true);
    expect(child.sent).not.toContainEqual({ op: "logout" });
    expect(readLink(h.stateRoot, U)).toEqual({ phone: PHONE, linkedAt: 5 });
    await h.clock.advance(10 * MINUTE);
    expect(h.spawns).toHaveLength(1);
    expect(h.pages).toEqual([]);
  });
});

// The supervisor runs in the office server, from timers and child exits: a
// throw there is an uncaught error, and Bun ends the whole server on it.
describe("whatsapp supervisor: faults around it never escape", () => {
  it("a pager that throws: the unlink by the phone still completes", async () => {
    const h = harness();
    const child = await bootLinked(h);
    h.pagerThrows = true;
    expect(() => child.close(DISCONNECT.loggedOut)).not.toThrow();
    await until(() => h.sup.status(U).state === "unlinked", "the unlink");
    expect(h.sup.status(U)).toEqual({
      state: "unlinked",
      reason: "unlinked_by_phone",
    });
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
  });

  it("a spawn that throws on a restart counts as a failure and is tried again", async () => {
    const h = harness();
    await bootLinked(h);
    h.spawnFailures = 1;
    last(h.childOf(U)).exit(1);
    // The restart timer's spawn throws inside the timer.
    await h.clock.advance(WHATSAPP_BACKOFF_FIRST_MS);
    expect(h.spawnFailures).toBe(0);
    expect(h.childOf(U)).toHaveLength(1);
    await h.clock.advance(WHATSAPP_BACKOFF_MAX_MS);
    expect(h.childOf(U)).toHaveLength(2);
    expect(h.sup.status(U).state).toBe("linked");
  });

  it("a spawn that throws at link: the link answers, and the member can link again", async () => {
    const h = harness();
    h.spawnFailures = 1;
    const res = await h.sup.link(U, { method: "qr" });
    expect(res.ok).toBe(true);
    expect(h.sup.status(U).state).not.toBe("linking");
    expect((await h.sup.link(U, { method: "qr" })).ok).toBe(true);
    expect(h.spawns).toHaveLength(1);
  });
});

describe("whatsapp supervisor: rows and inbound (slice 2)", () => {
  const CHATS = ["447700900123@s.whatsapp.net"];
  const routed: BridgeCommand = { op: "routes", chats: CHATS };
  const message = (id: string) => ({
    ev: "message" as const,
    id,
    chat: "447700900123@s.whatsapp.net",
    group: false,
    ts: 1,
    fromMe: false,
    sender: "447700900123@s.whatsapp.net",
    senderName: null,
    senderPhone: "447700900123",
    text: "hi",
    mentionsMe: false,
    quotedId: null,
  });

  it("the allowlist is the first command at every spawn: at boot, at a restart and at a link", async () => {
    const h = harness();
    h.allow.set(U, CHATS);
    const booted = await bootLinked(h);
    expect(booted.sent[0]).toEqual(routed);
    booted.exit(1);
    await h.clock.advance(WHATSAPP_BACKOFF_FIRST_MS);
    expect(h.childOf(U)).toHaveLength(2);
    expect(h.childOf(U)[1].sent[0]).toEqual(routed);

    await h.sup.link(V, { method: "qr" });
    expect(h.childOf(V)[0].sent).toEqual([
      { op: "routes", chats: [] },
      { op: "link", method: "qr" },
    ]);
  });

  it("setRoutes sends the current allowlist to the live bridge, and nothing when none runs", async () => {
    const h = harness();
    const child = await bootLinked(h);
    h.allow.set(U, CHATS);
    h.sup.setRoutes(U);
    expect(child.sent.at(-1)).toEqual(routed);
    expect(() => h.sup.setRoutes(V)).not.toThrow();
  });

  it("a message goes to the inbound hook; a hook that throws never escapes and the next message still goes", async () => {
    const h = harness();
    const child = await bootLinked(h);
    h.onMessageThrows = true;
    expect(() => child.emit(message("m1"))).not.toThrow();
    h.onMessageThrows = false;
    child.emit(message("m2"));
    await settle();
    expect(h.hookCalls.filter((c) => c.hook === "onMessage")).toEqual([
      { hook: "onMessage", userId: U, id: "m2" },
    ]);
  });

  it("chats seen since the link: newest name per chat, capped, and cleared on unlink", async () => {
    const h = harness();
    const child = await bootLinked(h);
    child.emit({
      ev: "chat",
      chat: "c0@s.whatsapp.net",
      name: "Old",
      group: false,
    });
    child.emit({
      ev: "chat",
      chat: "c0@s.whatsapp.net",
      name: "New",
      group: false,
    });
    for (let i = 1; i <= WHATSAPP_CHATS_SEEN_MAX + 5; i++)
      child.emit({
        ev: "chat",
        chat: `g${i}@g.us`,
        name: `G${i}`,
        group: true,
      });
    await settle();
    const seen = h.sup.chatsSeen(U);
    expect(seen).toHaveLength(WHATSAPP_CHATS_SEEN_MAX);
    expect(seen).toContainEqual({
      chat: `g${WHATSAPP_CHATS_SEEN_MAX + 5}@g.us`,
      name: `G${WHATSAPP_CHATS_SEEN_MAX + 5}`,
      group: true,
    });
    expect(
      seen.filter((c) => c.chat === "c0@s.whatsapp.net").length,
    ).toBeLessThanOrEqual(1);
    expect(h.sup.chatsSeen(V)).toEqual([]);
    await h.sup.unlink(U);
    expect(h.sup.chatsSeen(U)).toEqual([]);
  });

  it("tells the hooks about a new link, each way a link ends, and the stop before the children end", async () => {
    const h = harness();
    await h.sup.link(U, { method: "qr" });
    h.childOf(U)[0].emit({ ev: "linked", phone: PHONE });
    await until(() => h.sup.status(U).state === "linked", "linked");
    expect(h.hookCalls).toContainEqual({
      hook: "onLinked",
      userId: U,
      phone: PHONE,
    });

    await h.sup.unlink(U);
    writeLink(h.stateRoot, V, { phone: "15550100", linkedAt: 6 });
    await h.sup.boot();
    await until(() => h.childOf(V).length === 1, "Bob's spawn");
    h.childOf(V)[0].close(DISCONNECT.loggedOut);
    await until(() => h.sup.status(V).state === "unlinked", "Bob unlinked");
    expect(h.hookCalls.filter((c) => c.hook === "onUnlinked")).toEqual([
      { hook: "onUnlinked", userId: U },
      { hook: "onUnlinked", userId: V },
    ]);

    writeLink(h.stateRoot, U, { phone: PHONE, linkedAt: 7 });
    await h.sup.boot();
    await until(() => h.childOf(U).some((c) => !c.exited), "Alice again");
    await h.sup.removeMember(U);
    expect(h.hookCalls.filter((c) => c.hook === "onUnlinked")).toHaveLength(3);

    writeLink(h.stateRoot, V, { phone: "15550100", linkedAt: 8 });
    await h.sup.boot();
    await until(() => h.childOf(V).some((c) => !c.exited), "Bob again");
    const done = h.sup.shutdown();
    await h.clock.advance(WHATSAPP_LOGOUT_WAIT_MS);
    await done;
    // Before the children stop, so pending bursts are still deliverable.
    expect(h.hookCalls.filter((c) => c.hook === "onShutdown")).toEqual([
      { hook: "onShutdown", childrenRunning: 1 },
    ]);
  });

  it("Link again from a dead session keeps the rows file; an explicit unlink deletes it", async () => {
    const h = harness();
    await bootLinked(h);
    const rowsFile = join(memberDir(h.stateRoot, U), "routes.json");
    writeFileSync(rowsFile, JSON.stringify({ phone: PHONE, routes: [] }));
    last(h.childOf(U)).close(DISCONNECT.connectionReplaced);
    await until(() => h.sup.status(U).state === "dead", "dead");
    expect((await h.sup.link(U, { method: "qr" })).ok).toBe(true);
    expect(existsSync(rowsFile)).toBe(true);
    expect(existsSync(join(memberDir(h.stateRoot, U), "link.json"))).toBe(
      false,
    );
    await h.sup.unlink(U);
    expect(existsSync(memberDir(h.stateRoot, U))).toBe(false);
  });
});

describe("whatsapp supervisor: a reply send (slice 2b)", () => {
  const MOM = "447700900123@s.whatsapp.net";
  const req = (requestId: string) => ({
    requestId,
    chat: MOM,
    text: "*Helper*\nsee you at 5",
  });
  // A send's answer as it lands, so a test can see one still waiting.
  function track<T>(p: Promise<T>): { done: boolean; value?: T } {
    const t: { done: boolean; value?: T } = { done: false };
    void p.then((v) => {
      t.done = true;
      t.value = v;
    });
    return t;
  }

  it("goes to the member's own bridge and answers with the message id or the failure, each by its request id", async () => {
    const h = harness();
    writeLink(h.stateRoot, V, { phone: "447700900222", linkedAt: 5 });
    const child = await bootLinked(h);
    await until(() => h.childOf(V).length === 1, "Bob's boot spawn");
    child.emit({ ev: "open" });
    const one = track(h.sup.send(U, req("ask-1")));
    const two = track(h.sup.send(U, req("ask-2")));
    expect(child.sent.slice(-2)).toEqual([
      { op: "send", ...req("ask-1") },
      { op: "send", ...req("ask-2") },
    ]);
    expect(h.childOf(V)[0].sent.some((c) => c.op === "send")).toBe(false);

    // Another member's bridge and an unknown request id answer nothing.
    h.childOf(V)[0].emit({ ev: "sent", requestId: "ask-1", id: "FORGED" });
    child.emit({ ev: "sent", requestId: "ask-9", id: "OTHER" });
    await settle();
    expect([one.done, two.done]).toEqual([false, false]);

    child.emit({ ev: "send-failed", requestId: "ask-2" });
    child.emit({ ev: "sent", requestId: "ask-1", id: "3EB0A" });
    await settle();
    expect(one).toEqual({ done: true, value: { ok: true, id: "3EB0A" } });
    expect(two).toEqual({ done: true, value: { ok: false, reason: "failed" } });
    // A second answer to a settled request changes nothing.
    expect(() =>
      child.emit({ ev: "sent", requestId: "ask-1", id: "3EB0B" }),
    ).not.toThrow();
    await settle();
    expect(one.value).toEqual({ ok: true, id: "3EB0A" });
  });

  it("no answer in the wait is unknown; a bridge that ends while a send waits is unknown at once", async () => {
    const h = harness();
    const child = await bootLinked(h);
    child.emit({ ev: "open" });
    const late = track(h.sup.send(U, req("ask-1")));
    await h.clock.advance(WHATSAPP_SEND_TIMEOUT_MS - 1);
    expect(late.done).toBe(false);
    await h.clock.advance(1);
    expect(late).toEqual({
      done: true,
      value: { ok: false, reason: "unknown" },
    });
    expect(() =>
      child.emit({ ev: "sent", requestId: "ask-1", id: "3EB0A" }),
    ).not.toThrow();
    await settle();
    expect(late.value).toEqual({ ok: false, reason: "unknown" });

    const cut = track(h.sup.send(U, req("ask-2")));
    await settle();
    expect(cut.done).toBe(false);
    child.exit(1);
    await settle();
    // The clock did not move: the exit answered, not the wait.
    expect(cut).toEqual({
      done: true,
      value: { ok: false, reason: "unknown" },
    });
  });

  it("a member with no linked bridge running gets not_linked at once, and nothing starts", async () => {
    const h = harness();
    // Read after one settle: a send that waits for an answer shows as not done.
    const none = track(h.sup.send(U, req("ask-1")));
    await settle();
    expect(none).toEqual({
      done: true,
      value: { ok: false, reason: "not_linked" },
    });
    expect(h.spawns).toHaveLength(0);

    // A link in progress has a child but no linked account.
    await h.sup.link(U, { method: "qr" });
    expect(h.childOf(U)).toHaveLength(1);
    const linking = track(h.sup.send(U, req("ask-2")));
    await settle();
    expect(linking).toEqual({
      done: true,
      value: { ok: false, reason: "not_linked" },
    });
    expect(h.childOf(U)[0].sent.some((c) => c.op === "send")).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });
});
