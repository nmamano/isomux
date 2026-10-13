// The caller's own connections (GET /api/me/connections), read once for the
// whole page. The tabs take from it what their own lists cannot say: the
// claude.ai connectors and their statuses, the MCP servers set in Claude's own
// files, why an MCP server is left out, whether a personal one replaces an
// office one, and which secrets have a test. It is the caller's data, so the
// page uses it for the office card and for "You", never under another member.

import { createContext, useContext, useEffect, useState } from "react";
import type { ConnectionsListRes } from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { useAppState } from "../store.tsx";
import { normalizeConnectionsList } from "../connection-rows.ts";
import {
  onConnectionsChanged,
  onManagedEnvSaved,
} from "../connections-events.ts";

type MyConnections = { list: ConnectionsListRes | null; failed: boolean };

const MyConnectionsCtx = createContext<MyConnections>({
  list: null,
  failed: false,
});

export function useMyConnections(): ConnectionsListRes | null {
  return useContext(MyConnectionsCtx).list;
}

// The read failed or answered with another shape: what only this list knows
// (the claude.ai connectors, the servers set in Claude's files) is missing,
// and the page says so rather than showing nothing.
export function useMyConnectionsFailed(): boolean {
  return useContext(MyConnectionsCtx).failed;
}

export function MyConnectionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { providerAccounts } = useAppState();
  const [state, setState] = useState<MyConnections>({
    list: null,
    failed: false,
  });
  const [reloads, setReloads] = useState(0);

  // A sign-in or sign-out changes the list: reload when the accounts change,
  // not on every identical update.
  const accountsKey = providerAccounts
    .map(
      (account) =>
        `${account.provider}:${account.scope}:${account.accountStatus}:${account.accountLabel ?? ""}`,
    )
    .join("|");

  useEffect(() => onManagedEnvSaved(() => setReloads((n) => n + 1)), []);
  useEffect(() => onConnectionsChanged(() => setReloads((n) => n + 1)), []);

  useEffect(() => {
    let live = true;
    apiFetch<ConnectionsListRes>("GET", "/api/me/connections")
      .then((result) => {
        // A server without this route, or a stub, answers with another
        // shape: the tabs then go without what only this list knows.
        if (!live) return;
        const list = normalizeConnectionsList(result);
        setState({ list, failed: list === null });
      })
      .catch(() => {
        if (live) setState({ list: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [accountsKey, reloads]);

  return (
    <MyConnectionsCtx.Provider value={state}>
      {children}
    </MyConnectionsCtx.Provider>
  );
}
