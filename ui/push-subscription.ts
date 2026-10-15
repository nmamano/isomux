// This browser's Web Push subscription for the pager
// (ui/components/PushDevicesBlock.tsx, server/web-push-*.ts).

import { apiFetch } from "./api.ts";
import { base64UrlDecode, pushDeviceId } from "../shared/web-push.ts";

// The longest a sign-out waits for this device to be forgotten.
export const FORGET_DEVICE_TIMEOUT_MS = 3000;

export type PushSupport = "ok" | "ios-install" | "unsupported";

export interface PushEnv {
  hasPush: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

export function readPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    hasPush:
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone:
      nav.standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true,
  };
}

// iPadOS reports itself as a Mac; the touch points tell them apart.
export function isIos(env: PushEnv): boolean {
  return (
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === "MacIntel" && env.maxTouchPoints > 1)
  );
}

// iOS offers Web Push only to a site opened from the Home Screen.
export function pushSupport(env: PushEnv): PushSupport {
  if (isIos(env) && !env.standalone) return "ios-install";
  return env.hasPush ? "ok" : "unsupported";
}

// A name for the device list when the member gave this device none.
export function guessDeviceLabel(env: PushEnv): string {
  if (/iPhone/.test(env.userAgent)) return "iPhone";
  if (isIos(env)) return "iPad";
  if (/Android/.test(env.userAgent)) return "Android";
  if (/Mac/.test(env.platform)) return "Mac";
  if (/Win/.test(env.platform)) return "Windows";
  if (/Linux/.test(env.platform)) return "Linux";
  return "";
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((x, i) => x === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

// The id of this browser's subscription for this office's key, or null.
// A subscription made with another key (the office made new keys) counts
// as none.
export async function currentDeviceId(
  publicKey: string,
): Promise<string | null> {
  const key = base64UrlDecode(publicKey);
  if (!key) return null;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub || !sameKey(sub.options.applicationServerKey, key)) return null;
  return pushDeviceId(sub.endpoint);
}

export async function subscribe(
  publicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const key = base64UrlDecode(publicKey);
  if (!key) throw new Error("bad key");
  const manager = (await registration()).pushManager;
  const old = await manager.getSubscription();
  if (old && !sameKey(old.options.applicationServerKey, key)) {
    await old.unsubscribe();
  }
  const sub = await manager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

export async function unsubscribe(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  await sub?.unsubscribe();
}

// Sign-out: remove this browser from the member's devices and unsubscribe
// it, so the lock screen stops showing their pages. Best effort: it never
// throws, and it gives up after FORGET_DEVICE_TIMEOUT_MS.
export async function forgetThisDevice(username: string): Promise<void> {
  const work = (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    const id = await pushDeviceId(sub.endpoint);
    await apiFetch<void>(
      "DELETE",
      `/api/users/${encodeURIComponent(username)}/push-devices/${id}`,
    ).catch(() => {});
    await sub.unsubscribe();
  })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((done) => {
      timer = setTimeout(done, FORGET_DEVICE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}
