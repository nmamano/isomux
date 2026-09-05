import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import {
  cardStyle,
  hint,
  sectionHeader,
  SettingsLink,
} from "./access-shared.tsx";
import { dialogCancelBtn } from "./dialog-styles.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { ProviderSignInCard } from "./ProviderSignInCard.tsx";
import { ManagedEnvEditor } from "./ManagedEnvEditor.tsx";
import { useI18n } from "../i18n.tsx";

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
  const { t } = useI18n();
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
          : t("settings.connections.checkFailed"),
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
            : t("settings.connections.checkFailed"),
        ),
      );
    // The catalog lookup is stable for the life of a language, and re-running
    // this on a language change would refetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <h4 style={sectionHeader}>
          {isOffice
            ? t("settings.sidebar.connectionsOffice")
            : t("settings.sidebar.connectionsPersonal")}
        </h4>
        <button
          style={dialogCancelBtn}
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          {refreshing
            ? t("settings.connections.refreshing")
            : t("settings.connections.refresh")}
        </button>
      </div>
      <p style={hint}>
        {isOffice
          ? t("settings.connections.officeIntro")
          : t("settings.connections.personalIntro")}
      </p>
      {error && <p style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
      <ProviderSignInCard
        provider="codex"
        accounts={accounts}
        onAccounts={updateAccounts}
        scopes={scopes}
        onGoToOtherHalf={onGoToOtherHalf}
      />
      <ProviderSignInCard
        provider="claude"
        accounts={accounts}
        onAccounts={updateAccounts}
        scopes={scopes}
        onGoToOtherHalf={onGoToOtherHalf}
      />
      <section style={{ ...cardStyle, marginTop: 14 }}>
        <h5 style={{ margin: "0 0 12px" }}>
          {t("settings.connections.envTitle")}
        </h5>
        {isOffice ? (
          <div>
            <div style={{ fontSize: 12, fontWeight: 650 }}>
              {t("settings.connections.officeVars")}
            </div>
            <p style={{ ...hint, margin: "8px 0" }}>
              {t("settings.connections.officeVarsHint")}
            </p>
            {role === "owner" ? (
              <ManagedEnvEditor path="/api/office/env" />
            ) : (
              <p style={{ ...hint, margin: 0 }}>
                {t("settings.connections.ownerManaged")}
              </p>
            )}
            <ProviderKeyNote />
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 12, fontWeight: 650 }}>
              {t("settings.connections.personalVars")}
            </div>
            <p style={{ ...hint, margin: "8px 0" }}>
              {t("settings.connections.personalVarsHint")}
            </p>
            <ManagedEnvEditor
              path={`/api/users/${encodeURIComponent(username)}/env`}
            />
            <ProviderKeyNote />
          </div>
        )}
      </section>
      <CrossLink half={half} onGoToOtherHalf={onGoToOtherHalf} />
    </div>
  );
}

// What the variables are FOR. The rule is the same on both halves, so the
// paragraph is one component rather than two copies that can drift, and it
// closes both halves for both roles: a member who cannot edit the office
// variables can still act on the per-user half of what it says.
function ProviderKeyNote() {
  const { rich } = useI18n();
  return (
    <p style={{ ...hint, margin: "10px 0 0" }}>
      {rich("settings.connections.providerKeyNote", {
        code: (chunk) => <code>{chunk}</code>,
      })}
    </p>
  );
}

// The pointer to the other half.
function CrossLink({
  half,
  onGoToOtherHalf,
}: {
  half: ConnectionsHalf;
  onGoToOtherHalf?: () => void;
}) {
  const { rich } = useI18n();
  // One key per sentence, the pointer inside it (ruling 16): the name of the
  // other section sits in the middle of the sentence in English and at the end
  // in Catalan, so it cannot be a separate string.
  return (
    <p style={{ ...hint, marginTop: 14 }}>
      {rich(
        half === "office"
          ? "settings.connections.crossLinkFromOffice"
          : "settings.connections.crossLinkFromPersonal",
        {
          link: (chunk) => (
            <SettingsLink label={chunk} onGo={onGoToOtherHalf} />
          ),
        },
      )}
    </p>
  );
}
