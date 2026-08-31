import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import { hint, sectionHeader } from "./access-shared.tsx";
import { dialogCancelBtn } from "./dialog-styles.ts";
import { useAppState } from "../store.tsx";
import { ProviderSignInCard } from "./ProviderSignInCard.tsx";

export function ConnectionsPane() {
  const { providerAccounts: liveAccounts } = useAppState();
  const [loadedAccounts, setLoadedAccounts] = useState<ProviderAccountWire[]>(
    [],
  );
  const accounts = liveAccounts.length > 0 ? liveAccounts : loadedAccounts;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(refresh = false) {
    setRefreshing(refresh);
    setError(null);
    try {
      const result = await apiFetch<ProviderAccountsWire>(
        refresh ? "POST" : "GET",
        refresh
          ? "/api/me/provider-accounts/refresh"
          : "/api/me/provider-accounts",
      );
      setLoadedAccounts(result.accounts);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not check provider accounts.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void apiFetch<ProviderAccountsWire>("GET", "/api/me/provider-accounts")
      .then((result) => setLoadedAccounts(result.accounts))
      .catch((caught) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not check provider accounts.",
        ),
      );
  }, []);

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h4 style={sectionHeader}>Connections</h4>
        <button
          style={dialogCancelBtn}
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p style={hint}>
        Connect the accounts your agents use. The provider stores the
        credentials.
      </p>
      {error && <p style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
      <ProviderSignInCard
        provider="codex"
        accounts={accounts}
        onAccounts={setLoadedAccounts}
      />
      <ProviderSignInCard
        provider="claude"
        accounts={accounts}
        onAccounts={setLoadedAccounts}
      />
    </div>
  );
}
