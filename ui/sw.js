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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the fallback title.
  }
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    data: { url: typeof data.url === "string" ? data.url : "/" },
  };
  if (typeof data.tag === "string") {
    options.tag = data.tag;
    options.renotify = data.renotify === true;
  }
  // Every push must show a notification: iOS drops a subscription whose
  // pushes show nothing.
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" && data.title ? data.title : "Isomux",
      options,
    ),
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
