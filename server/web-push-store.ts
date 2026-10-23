// Web Push state: the deployment's VAPID key pair and the devices where
// members turned on notifications. One file, STATE_ROOT/web-push.json (mode
// 0600): it holds the VAPID private key, and an endpoint is where the server
// sends. Backups leave it out (server/backup.ts); after a restore the server
// makes new keys and members turn notifications on again.
//
// Load posture, the same as pager-settings.json:
//   - no file                 → empty; keys are made on first use
//   - unparsable / bad shape  → moved aside, start empty; if it cannot be
//                               moved aside, the store is unavailable
//   - unreadable (EACCES...)  → unavailable: calls throw
//
// LEAF: imports only the atomic writer, the crypto module and shared helpers.

import { readFileSync, renameSync } from "fs";
import { atomicWriteFileSync } from "./persistence.ts";
import { errMessage } from "../shared/errors.ts";
import { base64UrlDecode, pushDeviceId } from "../shared/web-push.ts";
import type {
  PushDevice,
  PushDeviceFailure,
} from "../shared/contract-shapes.ts";
import { generateVapidKeys, type VapidKeys } from "./web-push-crypto.ts";

export interface PushDeviceRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  createdAt: number;
  lastFailure?: PushDeviceFailure;
}

interface WebPushFile {
  vapid?: VapidKeys & { createdAt: number };
  devices: PushDeviceRecord[];
}

const LABEL_MAX = 80;
const ENDPOINT_MAX = 2048;

// The push services of the browsers that support Web Push. The server POSTs
// to the saved endpoint, so any other host is refused at save time.
const PUSH_HOSTS: ReadonlyArray<string | RegExp> = [
  "fcm.googleapis.com",
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

function isPushEndpoint(raw: string): boolean {
  if (raw.length > ENDPOINT_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  return PUSH_HOSTS.some((h) =>
    typeof h === "string" ? url.hostname === h : h.test(url.hostname),
  );
}

export interface PushDeviceInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
}

// Validate a subscribe body: { endpoint, keys: { p256dh, auth }, label? }.
export function parsePushDeviceInput(
  raw: unknown,
): { ok: true; input: PushDeviceInput } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "body must be an object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.endpoint !== "string" || !isPushEndpoint(body.endpoint)) {
    return {
      ok: false,
      message: "endpoint must be an https URL of a browser push service",
    };
  }
  const keys = body.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys?.auth === "string" ? keys.auth : "";
  const point = base64UrlDecode(p256dh);
  if (!point || point.length !== 65 || point[0] !== 4) {
    return { ok: false, message: "keys.p256dh must be a P-256 public key" };
  }
  if (base64UrlDecode(auth)?.length !== 16) {
    return { ok: false, message: "keys.auth must be 16 bytes" };
  }
  if (body.label !== undefined && typeof body.label !== "string") {
    return { ok: false, message: "label must be a string" };
  }
  return {
    ok: true,
    input: {
      endpoint: body.endpoint,
      p256dh,
      auth,
      label: (body.label ?? "").trim().slice(0, LABEL_MAX),
    },
  };
}

export function toPushDevice(r: PushDeviceRecord): PushDevice {
  return {
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    ...(r.lastFailure ? { lastFailure: r.lastFailure } : {}),
  };
}

function isDevice(v: unknown): v is PushDeviceRecord {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.userId === "string" &&
    typeof d.endpoint === "string" &&
    typeof d.p256dh === "string" &&
    typeof d.auth === "string" &&
    typeof d.label === "string" &&
    typeof d.createdAt === "number"
  );
}

function isFile(v: unknown): v is WebPushFile {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  const vapid = f.vapid as Record<string, unknown> | undefined;
  return (
    (vapid === undefined ||
      (typeof vapid === "object" &&
        vapid !== null &&
        typeof vapid.publicKey === "string" &&
        typeof vapid.privateKey === "string" &&
        typeof vapid.createdAt === "number")) &&
    Array.isArray(f.devices) &&
    f.devices.every(isDevice)
  );
}

export type WebPushLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface WebPushPersistence {
  load(): WebPushLoadResult;
  // Durable write. MUST THROW on failure.
  save(file: WebPushFile): void;
  quarantine(): boolean;
}

export function createWebPushFilePersistence(path: string): WebPushPersistence {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "missing" };
        }
        console.error(`[web-push] cannot read ${path}: ${errMessage(err)}`);
        return { kind: "unreadable" };
      }
      try {
        return { kind: "data", value: JSON.parse(text) };
      } catch {
        return { kind: "corrupt" };
      }
    },
    save(file) {
      atomicWriteFileSync(path, JSON.stringify(file, null, 2), 0o600);
    },
    quarantine() {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
        console.error(`[web-push] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[web-push] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

export class WebPushUnavailableError extends Error {
  constructor() {
    super("the web push store is unavailable");
    this.name = "WebPushUnavailableError";
  }
}

export interface WebPushStore {
  // The key pair, made and saved on first use.
  vapid(): Promise<VapidKeys>;
  list(userId: string): PushDeviceRecord[];
  get(id: string): PushDeviceRecord | null;
  // Save the device for this member. The same endpoint saved by another
  // member moves to this one: a device belongs to who turned it on last.
  upsert(userId: string, input: PushDeviceInput): Promise<PushDeviceRecord>;
  // False when the member has no device with this id.
  remove(userId: string, id: string): boolean;
  removeMember(userId: string): void;
  // Delivery: the push service said the subscription is gone.
  drop(id: string): void;
  setFailure(id: string, failure: PushDeviceFailure | null): void;
}

export function createWebPushStore(
  persistence: WebPushPersistence,
  now: () => number = Date.now,
): WebPushStore {
  let file: WebPushFile = { devices: [] };
  let available = true;
  let making: Promise<VapidKeys> | null = null;

  const loaded = persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = persistence.quarantine();
  } else if (loaded.kind === "data") {
    if (isFile(loaded.value)) file = loaded.value;
    else available = persistence.quarantine();
  }

  const ensureAvailable = () => {
    if (!available) throw new WebPushUnavailableError();
  };

  const write = (next: WebPushFile) => {
    persistence.save(next);
    file = next;
  };

  const withDevices = (devices: PushDeviceRecord[]) => {
    if (devices.length !== file.devices.length) write({ ...file, devices });
  };

  return {
    async vapid() {
      ensureAvailable();
      if (file.vapid) {
        return {
          publicKey: file.vapid.publicKey,
          privateKey: file.vapid.privateKey,
        };
      }
      // One key pair even when two requests ask at once.
      making ??= (async () => {
        try {
          const keys = await generateVapidKeys();
          write({ ...file, vapid: { ...keys, createdAt: now() } });
          return keys;
        } finally {
          making = null;
        }
      })();
      return making;
    },

    list(userId) {
      ensureAvailable();
      return file.devices.filter((d) => d.userId === userId);
    },

    get(id) {
      ensureAvailable();
      return file.devices.find((d) => d.id === id) ?? null;
    },

    async upsert(userId, input) {
      ensureAvailable();
      const id = await pushDeviceId(input.endpoint);
      const record: PushDeviceRecord = {
        id,
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        label: input.label,
        createdAt: now(),
      };
      write({
        ...file,
        devices: [...file.devices.filter((d) => d.id !== id), record],
      });
      return record;
    },

    remove(userId, id) {
      ensureAvailable();
      const before = file.devices.length;
      withDevices(
        file.devices.filter((d) => !(d.id === id && d.userId === userId)),
      );
      return file.devices.length !== before;
    },

    removeMember(userId) {
      ensureAvailable();
      withDevices(file.devices.filter((d) => d.userId !== userId));
    },

    drop(id) {
      ensureAvailable();
      withDevices(file.devices.filter((d) => d.id !== id));
    },

    setFailure(id, failure) {
      ensureAvailable();
      const current = file.devices.find((d) => d.id === id);
      if (!current || (current.lastFailure ?? null) === failure) return;
      const next: PushDeviceRecord = { ...current };
      if (failure) next.lastFailure = failure;
      else delete next.lastFailure;
      write({
        ...file,
        devices: file.devices.map((d) => (d.id === id ? next : d)),
      });
    },
  };
}
