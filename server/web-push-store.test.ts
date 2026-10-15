// Web Push store (server/web-push-store.ts).
//
// Pins: the VAPID key pair is made once, on first use, and saved; a device
// belongs to one member and moves to whoever saves its endpoint last;
// removal is per member; a bad file is moved aside and an unreadable one
// makes the store refuse; only https endpoints of browser push services
// and well-formed keys are accepted.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createWebPushFilePersistence,
  createWebPushStore,
  isPushEndpoint,
  parsePushDeviceInput,
  WebPushUnavailableError,
  type PushDeviceInput,
} from "./web-push-store.ts";
import { pushDeviceId } from "../shared/web-push.ts";

const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const device = (n: number): PushDeviceInput => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  p256dh: P256DH,
  auth: AUTH,
  label: `Device ${n}`,
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "web-push-store-"));
  dirs.push(d);
  return join(d, "web-push.json");
}

describe("web push store: keys", () => {
  it("makes one key pair on first use, saves it 0600, and reloads it", async () => {
    const path = tmp();
    const store = createWebPushStore(createWebPushFilePersistence(path));
    const [a, b] = await Promise.all([store.vapid(), store.vapid()]);
    expect(a).toEqual(b);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = createWebPushStore(createWebPushFilePersistence(path));
    expect(await again.vapid()).toEqual(a);
  });
});

describe("web push store: devices", () => {
  it("keeps each member's devices apart", async () => {
    const store = createWebPushStore(createWebPushFilePersistence(tmp()));
    const one = await store.upsert("u-a", device(1));
    await store.upsert("u-b", device(2));
    expect(one.id).toBe(await pushDeviceId(device(1).endpoint));
    expect(store.list("u-a").map((d) => d.label)).toEqual(["Device 1"]);
    // Another member cannot remove it.
    expect(store.remove("u-b", one.id)).toBe(false);
    expect(store.list("u-a")).toHaveLength(1);
    expect(store.remove("u-a", one.id)).toBe(true);
    expect(store.list("u-a")).toHaveLength(0);
    expect(store.list("u-b")).toHaveLength(1);
  });

  it("moves an endpoint to the member who saved it last", async () => {
    const store = createWebPushStore(createWebPushFilePersistence(tmp()));
    await store.upsert("u-a", device(1));
    await store.upsert("u-b", device(1));
    expect(store.list("u-a")).toHaveLength(0);
    expect(store.list("u-b")).toHaveLength(1);
  });

  it("removes a member's devices, drops one, and records failures", async () => {
    const path = tmp();
    const store = createWebPushStore(createWebPushFilePersistence(path));
    const a1 = await store.upsert("u-a", device(1));
    await store.upsert("u-a", device(2));
    const b = await store.upsert("u-b", device(3));
    store.setFailure(b.id, "unreachable");
    expect(store.get(b.id)?.lastFailure).toBe("unreachable");
    store.setFailure(b.id, null);
    expect(store.get(b.id)?.lastFailure).toBeUndefined();
    store.drop(a1.id);
    expect(store.list("u-a").map((d) => d.label)).toEqual(["Device 2"]);
    store.removeMember("u-a");
    expect(store.list("u-a")).toHaveLength(0);
    // Saved: a fresh store reads the same devices.
    const again = createWebPushStore(createWebPushFilePersistence(path));
    expect(again.list("u-b").map((d) => d.id)).toEqual([b.id]);
    expect(again.list("u-a")).toHaveLength(0);
  });
});

describe("web push store: load posture", () => {
  it("moves a bad file aside and starts empty", async () => {
    const path = tmp();
    writeFileSync(path, "{ not json");
    const store = createWebPushStore(createWebPushFilePersistence(path));
    expect(store.list("u-a")).toEqual([]);
    expect(
      readdirSync(join(path, "..")).some((f) =>
        f.startsWith("web-push.json.corrupt-"),
      ),
    ).toBe(true);
  });

  it("refuses every call when the file cannot be read", async () => {
    const store = createWebPushStore({
      load: () => ({ kind: "unreadable" }),
      save: () => {},
      quarantine: () => true,
    });
    expect(() => store.list("u-a")).toThrow(WebPushUnavailableError);
    let err: unknown = null;
    try {
      await store.vapid();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WebPushUnavailableError);
  });
});

describe("parsePushDeviceInput", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    endpoint: device(1).endpoint,
    keys: { p256dh: P256DH, auth: AUTH },
    label: "  Phone  ",
    ...over,
  });

  it("accepts a push service endpoint and trims the label", () => {
    const parsed = parsePushDeviceInput(body());
    expect(parsed.ok && parsed.input.label).toBe("Phone");
  });

  it("refuses endpoints outside the browser push services", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://localhost:4000/api/agents",
      "https://127.0.0.1/x",
      "https://push.apple.com.evil.example/x",
      // Look-alikes: a suffix match must stop at a dot.
      "https://xpush.apple.com/x",
      "https://evil-push.apple.com.attacker.net/x",
      "https://xpush.services.mozilla.com/x",
      "https://xnotify.windows.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
    ]) {
      expect(isPushEndpoint(endpoint)).toBe(false);
      expect(parsePushDeviceInput(body({ endpoint })).ok).toBe(false);
    }
    for (const endpoint of [
      "https://web.push.apple.com/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isPushEndpoint(endpoint)).toBe(true);
    }
  });

  it("refuses malformed keys", () => {
    expect(
      parsePushDeviceInput(body({ keys: { p256dh: AUTH, auth: AUTH } })).ok,
    ).toBe(false);
    expect(
      parsePushDeviceInput(body({ keys: { p256dh: P256DH, auth: P256DH } })).ok,
    ).toBe(false);
    expect(parsePushDeviceInput(body({ keys: undefined })).ok).toBe(false);
  });
});
