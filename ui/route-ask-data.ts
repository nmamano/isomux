// The data the whatsapp-route and discord-route ask cards read (task
// 33210f25): the viewer's WhatsApp chats and rows, and their Discord bots,
// the servers each bot sees and their routes. A card cannot know its shape
// before this lands (a chat picker, a "moves" line, the current values), so
// the reads happen once per viewer, at boot when the viewer has an open ask of
// that kind (useRouteAskPrefetch), and the cards draw what is held at once.
//
// One state per kind:
//   empty   - nothing read yet.
//   reading - a read for viewerId is in flight; `held` is the last data for
//             that viewer (null on the first read), which the hooks return.
//   held    - the last read for viewerId landed.
// A read that lands goes to held. A refresh from held goes to reading with
// the data kept. A read that lands for a viewer the state no longer belongs to
// (sign-out, then sign-in as another member in the same tab) writes nothing;
// a read for another viewer replaces the state (another viewer's data is never
// returned). A rejected request keeps the held value of that part (chats,
// rows, the bot list, one bot's guilds, routes); it reads as [] only when
// nothing is held.

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch, ApiError } from "./api.ts";
import { useAppState } from "./store.tsx";
import { resetBetweenTestFiles } from "./test-file-resets.ts";
import type { WhatsAppChatSeen, WhatsAppRoute } from "../shared/whatsapp.ts";
import type {
  DiscordBotListed,
  DiscordGuildSeen,
  DiscordRoute,
} from "../shared/discord.ts";

export interface WhatsAppRouteData {
  chats: WhatsAppChatSeen[];
  rows: WhatsAppRoute[];
}

export interface DiscordRouteBot {
  botId: string;
  name: string;
  guilds: DiscordGuildSeen[];
}

export interface DiscordRouteData {
  bots: DiscordRouteBot[];
  routes: DiscordRoute[];
}

export type RouteDataState<T> =
  | { state: "empty" }
  | { state: "reading"; viewerId: string; held: T | null }
  | { state: "held"; viewerId: string; data: T };

// One kind's store: its state, the subscribers, and how a read is made from
// what is held for the same viewer.
interface RouteStore<T> {
  state: RouteDataState<T>;
  listeners: Set<() => void>;
  // One function per store, so useSyncExternalStore keeps its subscription
  // across renders.
  subscribe: (onChange: () => void) => () => void;
  read: (held: T | null) => Promise<T>;
}

function makeStore<T>(read: (held: T | null) => Promise<T>): RouteStore<T> {
  const listeners = new Set<() => void>();
  return {
    state: { state: "empty" },
    listeners,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
  };
}

function setState<T>(store: RouteStore<T>, state: RouteDataState<T>): void {
  store.state = state;
  for (const l of store.listeners) l();
}

function load<T>(store: RouteStore<T>, viewerId: string): void {
  const s = store.state;
  if (s.state === "reading" && s.viewerId === viewerId) return;
  const held =
    s.state === "held" && s.viewerId === viewerId
      ? s.data
      : s.state === "reading" && s.viewerId === viewerId
        ? s.held
        : null;
  const next: RouteDataState<T> = { state: "reading", viewerId, held };
  setState(store, next);
  // Only the read the state still waits for writes: a late read (another
  // viewer's, or one a reset dropped) writes nothing.
  store.read(held).then(
    (data) => {
      if (store.state === next)
        setState(store, { state: "held", viewerId, data });
    },
    () => {
      if (store.state === next)
        setState(
          store,
          held ? { state: "held", viewerId, data: held } : { state: "empty" },
        );
    },
  );
}

function dataFor<T>(store: RouteStore<T>, viewerId: string | null): T | null {
  const s = store.state;
  if (viewerId === null || s.state === "empty" || s.viewerId !== viewerId)
    return null;
  return s.state === "held" ? s.data : s.held;
}

function useRouteData<T>(
  store: RouteStore<T>,
  viewerId: string | null,
): T | null {
  const data = useSyncExternalStore(store.subscribe, () =>
    dataFor(store, viewerId),
  );
  useEffect(() => {
    if (viewerId !== null) load(store, viewerId);
  }, [store, viewerId]);
  return data;
}

// A rejected request keeps what is held of that part; [] when nothing is.
const settled = <T>(res: PromiseSettledResult<T>, held: T | undefined) =>
  res.status === "fulfilled" ? res.value : (held ?? ([] as T));

const whatsapp = makeStore<WhatsAppRouteData>(async (held) => {
  const [chats, rows] = await Promise.allSettled([
    apiFetch<WhatsAppChatSeen[]>("GET", "/api/whatsapp/chats"),
    apiFetch<WhatsAppRoute[]>("GET", "/api/whatsapp/routes"),
  ]);
  return {
    chats: settled(chats, held?.chats),
    rows: settled(rows, held?.rows),
  };
});

const discord = makeStore<DiscordRouteData>(async (held) => {
  const [listed, routes] = await Promise.allSettled([
    apiFetch<DiscordBotListed[]>("GET", "/api/discord"),
    apiFetch<DiscordRoute[]>("GET", "/api/discord/routes"),
  ]);
  let bots: DiscordRouteBot[];
  if (listed.status === "fulfilled") {
    const seen = await Promise.allSettled(
      listed.value.map((b) =>
        apiFetch<DiscordGuildSeen[]>(
          "GET",
          `/api/discord/bots/${encodeURIComponent(b.id)}/guilds`,
        ),
      ),
    );
    bots = listed.value.map((b, i) => {
      const res = seen[i];
      // A bot that is not connected yet (404) sees no server.
      const none =
        res.status === "rejected" &&
        res.reason instanceof ApiError &&
        res.reason.status === 404;
      return {
        botId: b.id,
        name: b.name,
        guilds: none
          ? []
          : settled(res, held?.bots.find((h) => h.botId === b.id)?.guilds),
      };
    });
  } else bots = held?.bots ?? [];
  return { bots, routes: settled(routes, held?.routes) };
});

/** Start a read of the viewer's WhatsApp chats and rows, unless one for that
 *  viewer is in flight. */
export function loadWhatsAppRouteData(viewerId: string): void {
  load(whatsapp, viewerId);
}

/** Start a read of the viewer's Discord bots, their servers and routes,
 *  unless one for that viewer is in flight. */
export function loadDiscordRouteData(viewerId: string): void {
  load(discord, viewerId);
}

/** The held WhatsApp data for the viewer, or null until the first read lands.
 *  A null viewer (not the ask's member) reads nothing. On mount, starts a
 *  refresh that keeps the held data until it lands. */
export function useWhatsAppRouteData(
  viewerId: string | null,
): WhatsAppRouteData | null {
  return useRouteData(whatsapp, viewerId);
}

/** As useWhatsAppRouteData, for Discord. */
export function useDiscordRouteData(
  viewerId: string | null,
): DiscordRouteData | null {
  return useRouteData(discord, viewerId);
}

/** Mounted once, by App: start each kind's read when the viewer has an open
 *  ask of that kind of their own. Keyed on that per-kind boolean and the
 *  viewer id, so an unrelated asks delta starts no read. */
export function useRouteAskPrefetch(): void {
  const { asks, sessionContext } = useAppState();
  const viewerId = sessionContext?.userId ?? null;
  const owns = (kind: string) =>
    viewerId !== null &&
    asks.some((e) => e.memberUserId === viewerId && e.step?.kind === kind);
  const wantWhatsApp = owns("whatsapp-route");
  const wantDiscord = owns("discord-route");
  useEffect(() => {
    if (viewerId !== null && wantWhatsApp) loadWhatsAppRouteData(viewerId);
  }, [viewerId, wantWhatsApp]);
  useEffect(() => {
    if (viewerId !== null && wantDiscord) loadDiscordRouteData(viewerId);
  }, [viewerId, wantDiscord]);
}

/** Tests: back to empty for both kinds, in-flight reads dropped. */
export function resetRouteAskData(): void {
  setState(whatsapp, { state: "empty" });
  setState(discord, { state: "empty" });
}
resetBetweenTestFiles(resetRouteAskData);
