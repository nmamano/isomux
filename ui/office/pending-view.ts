import { useCallback, useEffect, useRef, useState } from "react";

// Optimistic overlay for a per-member view write (room order, tucked rooms).
// The bar shows the written value at once; the server state takes over again
// when it confirms the write, or at once when the write fails.
//
// Only the newest write is held. A response for an older write is ignored, so
// an older failure cannot drop a newer move. Before the newest write settles,
// no server state drops the overlay: a delayed older state cannot confirm the
// newer value, and an unrelated push keeps the overlay on top of it. After a
// successful settle, the overlay drops when the server state matches the
// value, or at the first server state that arrives after the settle. The
// server queues a write's own push before its HTTP response, but the response
// can overtake pushes still in flight on the socket; those older states then
// show until the confirming push arrives behind them. The bar always ends on
// the server's latest state.
export interface PendingView<S, V> {
  seq: number;
  value: V;
  // The server state seen when the write succeeded; null while in flight.
  settledAgainst: { server: S } | null;
}

export function startPending<S, V>(seq: number, value: V): PendingView<S, V> {
  return { seq, value, settledAgainst: null };
}

export function settlePending<S, V>(
  pending: PendingView<S, V> | null,
  seq: number,
  ok: boolean,
  server: S,
): PendingView<S, V> | null {
  if (!pending || pending.seq !== seq) return pending;
  if (!ok) return null;
  return { ...pending, settledAgainst: { server } };
}

// The value to show over the server state, or null for "show the server
// state".
export function visiblePending<S, V>(
  pending: PendingView<S, V> | null,
  server: S,
  matches: (server: S, value: V) => boolean,
): V | null {
  if (!pending) return null;
  if (pending.settledAgainst === null) return pending.value;
  if (pending.settledAgainst.server !== server) return null;
  return matches(server, pending.value) ? null : pending.value;
}

export function usePendingView<S, V>(
  server: S,
  matches: (server: S, value: V) => boolean,
): [V | null, (value: V, send: () => Promise<unknown>) => void] {
  const [pending, setPending] = useState<PendingView<S, V> | null>(null);
  const seqRef = useRef(0);
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);
  const write = useCallback((value: V, send: () => Promise<unknown>) => {
    const seq = ++seqRef.current;
    setPending(startPending<S, V>(seq, value));
    const settle = (ok: boolean) =>
      setPending((p) => settlePending(p, seq, ok, serverRef.current));
    send().then(
      () => settle(true),
      () => settle(false),
    );
  }, []);
  return [visiblePending(pending, server, matches), write];
}

// `order` first, in its order, then every room it does not list, in the
// current order. Ids in `order` with no room are skipped.
export function applyRoomOrder<R extends { id: string }>(
  rooms: readonly R[],
  order: readonly string[],
): R[] {
  const byId = new Map(rooms.map((r) => [r.id, r] as const));
  const listed: R[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const room = byId.get(id);
    if (room && !seen.has(id)) {
      listed.push(room);
      seen.add(id);
    }
  }
  return [...listed, ...rooms.filter((r) => !seen.has(r.id))];
}

export function roomsInOrder(
  rooms: readonly { id: string }[],
  order: readonly string[],
): boolean {
  const ordered = applyRoomOrder(rooms, order);
  return ordered.every((r, i) => r.id === rooms[i].id);
}
