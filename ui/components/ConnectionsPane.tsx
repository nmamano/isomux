import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import { hint, sectionHeader } from "./access-shared.tsx";
import { dialogCancelBtn } from "./dialog-styles.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { ProviderSignInCard } from "./ProviderSignInCard.tsx";

export function ConnectionsPane() {
  const { providerAccounts: liveAccounts } = useAppState();
  const dispatch = useDispatch();
  const accounts = liveAccounts;
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
      dispatch({
        type: "provider_accounts_updated",
        accounts: result.accounts,
      });
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
      .then((result) =>
        dispatch({
          type: "provider_accounts_updated",
          accounts: result.accounts,
        }),
      )
      .catch((caught) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not check provider accounts.",
        ),
      );
  }, [dispatch]);

  const updateAccounts = (next: ProviderAccountWire[]) =>
    dispatch({ type: "provider_accounts_updated", accounts: next });

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
        credentials, not us.
      </p>
      {error && <p style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
      <ProviderSignInCard
        provider="codex"
        accounts={accounts}
        onAccounts={updateAccounts}
      />
      <ProviderSignInCard
        provider="claude"
        accounts={accounts}
        onAccounts={updateAccounts}
      />
      <p style={{ ...hint, marginTop: 14 }}>
        <strong>Do you want to use an API token?</strong> Add{" "}
        <code>ANTHROPIC_API_KEY</code> (Claude) or <code>OPENAI_API_KEY</code>{" "}
        (Codex) to your env file (User Settings → Env File Path), or to the
        office env file (Office Settings → Env File Path) to share it with
        every agent. Then <code>/clear</code> agents to apply it.
      </p>
    </div>
  );
}
