// Service worker: makes the office installable as a PWA and shows pager
// pushes (server/web-push-delivery.ts). No caching. All requests pass
// through to the network.

// A new worker takes over at once, also while the installed app stays open
// in the background: a push that the old worker shows nothing for can make
// Safari drop the subscription. Safe, because nothing is cached.
self.addEventListener("install", () => self.skipWaiting());

// Take over open pages at once, so a notification click can navigate them.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Recording mode (ui/recording-mode.ts): the office page posts the flag on
// every load and every switch, and the worker keeps it in IndexedDB, because
// a push may wake the worker with no page open. While it is on, a push shows
// only "Isomux": a notification is drawn over whatever is being recorded.
const FLAGS_DB = "isomux-sw";
const FLAGS_STORE = "flags";
const RECORDING_KEY = "recording";

function openFlags() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FLAGS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FLAGS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function flagRequest(mode, run) {
  const db = await openFlags();
  try {
    return await new Promise((resolve, reject) => {
      const req = run(
        db.transaction(FLAGS_STORE, mode).objectStore(FLAGS_STORE),
      );
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// An unreadable flag reads as off: the push shows as it was sent.
async function recordingOn() {
  try {
    return (
      (await flagRequest("readonly", (s) => s.get(RECORDING_KEY))) === true
    );
  } catch {
    return false;
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "isomux-recording") return;
  event.waitUntil(
    flagRequest("readwrite", (s) =>
      s.put(data.on === true, RECORDING_KEY),
    ).catch(() => {}),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the fallback title.
  }
  // Every push must show a notification: iOS drops a subscription whose
  // pushes show nothing.
  event.waitUntil(
    (async () => {
      const hidden = await recordingOn();
      const options = {
        body: !hidden && typeof data.body === "string" ? data.body : "",
        icon: "/icons/icon-192.png",
        data: { url: typeof data.url === "string" ? data.url : "/" },
      };
      if (typeof data.tag === "string") {
        options.tag = data.tag;
        options.renotify = data.renotify === true;
      }
      await self.registration.showNotification(
        !hidden && typeof data.title === "string" && data.title
          ? data.title
          : "Isomux",
        options,
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The server sends a path; it opens on this worker's origin. Only a link
  // into this office.
  let url = new URL("/", self.location.origin);
  try {
    const target = new URL(event.notification.data?.url ?? "/", url);
    if (target.origin === url.origin) url = target;
  } catch {
    // Keep the office root.
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (!("focus" in client)) continue;
        await client.focus();
        if ("navigate" in client) {
          try {
            await client.navigate(url.href);
            return;
          } catch {
            // Not controlled by this worker: open a new window instead.
          }
        }
        break;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
