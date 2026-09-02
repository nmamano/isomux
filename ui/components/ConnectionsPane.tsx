import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";
import { dialogCancelBtn } from "./dialog-styles.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { ProviderSignInCard } from "./ProviderSignInCard.tsx";
import { ManagedEnvEditor } from "./ManagedEnvEditor.tsx";

export function ConnectionsPane({
  username,
  role,
}: {
  username: string;
  role: "owner" | "member";
}) {
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
      <section style={{ ...cardStyle, marginTop: 14 }}>
        <h5 style={{ margin: "0 0 12px" }}>Environment variables</h5>
        <div>
          <div style={{ fontSize: 12, fontWeight: 650 }}>
            Variables for every agent in this office
          </div>
          <p style={{ ...hint, margin: "8px 0" }}>
            These variables load for every agent unless a user variable
            overrides them.
          </p>
          {role === "owner" ? (
            <ManagedEnvEditor path="/api/office/env" />
          ) : (
            <p style={{ ...hint, margin: 0 }}>
              Office-wide variables are managed by an office owner.
            </p>
          )}
        </div>
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 14,
            marginTop: 14,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 650 }}>
            Variables for agents I spawn
          </div>
          <p style={{ ...hint, margin: "8px 0" }}>
            These variables load for agents you spawn and override office-wide
            variables.
          </p>
          <ManagedEnvEditor
            path={`/api/users/${encodeURIComponent(username)}/env`}
          />
          <p style={{ ...hint, margin: "10px 0 0" }}>
            Add <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, or{" "}
            <code>OPENCODE_API_KEY</code> to use provider API keys. Other
            per-user variables work the same way, for example{" "}
            <code>GH_TOKEN</code> so the <code>gh</code> CLI acts as you. Then{" "}
            <code>/clear</code> agents to apply changes.
          </p>
        </div>
      </section>
    </div>
  );
}
