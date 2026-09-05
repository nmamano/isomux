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

// One pane per owner, not one pane for both. The office half holds the
// sign-ins and variables that every agent in the office uses; the personal
// half holds the ones that apply to the agents you spawn. They used to share
// a pane, which put a paragraph a member cannot act on at the top of the only
// Connections screen they had. Each half links to the other, because the
// override rule (personal beats office) only makes sense if you can see both.
export type ConnectionsHalf = "office" | "personal";

export function ConnectionsPane({
  username,
  role,
  half,
  onGoToOtherHalf,
}: {
  username: string;
  role: "owner" | "member";
  half: ConnectionsHalf;
  onGoToOtherHalf?: () => void;
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

  // Both halves read the same endpoint - the response carries every scope -
  // so whichever half is mounted keeps the shared store slice fresh.
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

  const isOffice = half === "office";
  const scopes = isOffice ? (["office"] as const) : (["personal"] as const);

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
        {isOffice
          ? "The accounts and variables that every agent in this office uses. The provider stores the credentials, not us."
          : "The accounts and variables that the agents you spawn use. They override the office ones. The provider stores the credentials, not us."}
      </p>
      {error && <p style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
      <ProviderSignInCard
        provider="codex"
        accounts={accounts}
        onAccounts={updateAccounts}
        scopes={scopes}
      />
      <ProviderSignInCard
        provider="claude"
        accounts={accounts}
        onAccounts={updateAccounts}
        scopes={scopes}
      />
      <section style={{ ...cardStyle, marginTop: 14 }}>
        <h5 style={{ margin: "0 0 12px" }}>Environment variables</h5>
        {isOffice ? (
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
        ) : (
          <div>
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
              Add <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>,
              or <code>OPENCODE_API_KEY</code> to use provider API keys. Other
              per-user variables work the same way, for example, each member can
              set <code>GH_TOKEN</code> so their agents use their own GitHub
              credentials. Then <code>/clear</code> agents to apply changes.
            </p>
          </div>
        )}
      </section>
      <CrossLink half={half} onGoToOtherHalf={onGoToOtherHalf} />
    </div>
  );
}

// The pointer to the other half. It is a button when the page can navigate
// for you, and plain text otherwise, so the sentence still reads if a caller
// mounts the pane without a handler.
function CrossLink({
  half,
  onGoToOtherHalf,
}: {
  half: ConnectionsHalf;
  onGoToOtherHalf?: () => void;
}) {
  const target =
    half === "office" ? "You → Connections" : "Office → Connections";
  const lead =
    half === "office"
      ? "Your own sign-ins and variables, which override these, are under "
      : "The office-wide sign-ins and variables these override are under ";
  return (
    <p style={{ ...hint, marginTop: 14 }}>
      {lead}
      {onGoToOtherHalf ? (
        <button
          onClick={onGoToOtherHalf}
          style={{
            font: "inherit",
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--accent)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {target}
        </button>
      ) : (
        <strong>{target}</strong>
      )}
      .
    </p>
  );
}
