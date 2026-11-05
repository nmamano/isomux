// The Model providers tab: the Claude and Codex sign-ins agents run on, and
// OpenCode. The sign-in cards are the ones the Connections panes had (Nil:
// that part worked well), laid flat inside the page's cards. An owner who
// looks at another member sees that member's status only: the sign-in is the
// member's own CLI login, which nobody else can start (Lead, ruling 3).
//
// OpenCode has no sign-in here: it ships with Isomux, its free models need
// no key (the default model, OPENCODE_DEFAULT_MODEL, is one), and a key for
// the paid ones is the OPENCODE_API_KEY variable (OpenCodeSection.tsx).

import { useEffect, useState, type CSSProperties } from "react";
import type {
  MemberProviderStatus,
  UserEnvNamesRes,
} from "../../shared/contract-shapes.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { ProviderSignInCard } from "../components/ProviderSignInCard.tsx";
import { ProviderMark } from "../components/ProviderMark.tsx";
import { MemberUsageCard } from "../components/MemberUsageCard.tsx";
import { OpenCodeSection } from "./OpenCodeSection.tsx";
import { Empty, ItemRow, Pill, errorText } from "./kit.tsx";
import { useMyConnections } from "./my-connections.tsx";
import {
  onConnectionsChanged,
  onManagedEnvSaved,
} from "../connections-events.ts";
import { useAlive } from "./use-alive.ts";
import { isGone, type Role, type Target } from "./target.ts";

// The sign-in and usage cards, flat inside the page's card: a rule between
// them instead of a box in a box.
const flat: CSSProperties = {
  border: "none",
  borderTop: "1px solid var(--border-subtle)",
  borderRadius: 0,
  background: "transparent",
  padding: "12px 2px 4px",
  marginTop: 0,
};

// The provider accounts the cards read, shared with the rest of the office
// through the store. Both cards of the tab mount this; the read is cheap.
// Reads nothing while enabled is false: a pack without environment read.
export function useProviderAccounts(enabled: boolean) {
  const { providerAccounts } = useAppState();
  const dispatch = useDispatch();
  const { t } = useI18n();
  const alive = useAlive();
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    providerAccounts.length > 0 ? "loaded" : "loading",
  );
  const [refreshing, setRefreshing] = useState(false);
  // Counts Refresh clicks, so the OpenCode section reads again too.
  const [refreshes, setRefreshes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The state starts as "loading", so the mount read sets nothing before its
  // answer; Refresh marks the read itself.
  const read = (refresh: boolean) =>
    apiFetch<ProviderAccountsWire>(
      refresh ? "POST" : "GET",
      refresh
        ? "/api/me/provider-accounts/refresh"
        : "/api/me/provider-accounts",
    )
      .then((result) => {
        dispatch({
          type: "provider_accounts_updated",
          accounts: result.accounts,
        });
        if (alive.current) setState("loaded");
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        setState("failed");
        setError(
          caught instanceof ApiError
            ? caught.message
            : t("settings.connections.checkFailed"),
        );
      })
      .finally(() => {
        if (alive.current) setRefreshing(false);
      });

  function refresh() {
    setRefreshes((n) => n + 1);
    setRefreshing(true);
    setState("loading");
    setError(null);
    void read(true);
  }

  useEffect(() => {
    if (enabled) void read(false);
    // Once per mount or enable; Refresh reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // A saved variable or secret can change the OPENAI_API_KEY the Codex card
  // names.
  useEffect(() => {
    if (!enabled) return;
    const reread = () => void read(false);
    const offEnv = onManagedEnvSaved(reread);
    const offConnections = onConnectionsChanged(reread);
    return () => {
      offEnv();
      offConnections();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    accounts: providerAccounts,
    loaded: state !== "loading",
    refreshing,
    refreshes,
    error,
    refresh,
    update: (next: ProviderAccountWire[]) =>
      dispatch({ type: "provider_accounts_updated", accounts: next }),
  };
}

const OPENCODE_KEY = "OPENCODE_API_KEY";

export function ProvidersSection({
  target,
  role,
  accounts,
  onGoToOtherCard,
  onGone,
}: {
  target: Target;
  role: Role;
  accounts: ReturnType<typeof useProviderAccounts>;
  onGoToOtherCard?: () => void;
  // The member left the office while the card showed them.
  onGone?: () => void;
}) {
  const list = useMyConnections();
  if (target.kind === "member")
    return <MemberProviders target={target} role={role} onGone={onGone} />;
  const scope = target.kind === "office" ? "office" : "personal";
  const scopes = [scope] as const;
  return (
    <>
      {accounts.error && target.kind === "office" && (
        <p role="alert" style={errorText}>
          {accounts.error}
        </p>
      )}
      {(["codex", "claude"] as const).map((provider) => (
        <ProviderSignInCard
          key={provider}
          provider={provider}
          accounts={accounts.accounts}
          loaded={accounts.loaded}
          canCancelSharedLogin={role === "owner"}
          canChangeOffice={role === "owner"}
          onAccounts={accounts.update}
          scopes={scopes}
          onGoToOtherHalf={onGoToOtherCard}
          style={flat}
          pageLook
        />
      ))}
      <OpenCodeSection
        target={target}
        role={role}
        refreshes={accounts.refreshes}
        keySet={
          list
            ? list.variables.some(
                (variable) =>
                  variable.scope === scope && variable.name === OPENCODE_KEY,
              )
            : null
        }
      />
      {target.kind === "office" && role === "owner" && (
        <MemberUsageCard style={flat} />
      )}
    </>
  );
}

// A member's Claude and Codex status, for an owner, and their OpenCode key
// (OpenCodeSection.tsx): whether the member has
// their own sign-in (the same probe as their own sign-in card), never the
// account. Read from the owner-only names route. Without a personal sign-in
// the member's agents use an API key variable or the office account, which
// this route cannot tell apart, so the row says only what it knows.
function MemberProviders({
  target,
  role,
  onGone,
}: {
  target: Target & { kind: "member" };
  role: Role;
  onGone?: () => void;
}) {
  const username = target.username;
  const { t } = useI18n();
  const alive = useAlive();
  const [providers, setProviders] = useState<MemberProviderStatus[] | null>(
    null,
  );
  const [names, setNames] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<UserEnvNamesRes>(
      "GET",
      `/api/users/${encodeURIComponent(username)}/env/names`,
    )
      .then((result) => {
        if (!alive.current) return;
        if (Array.isArray(result?.providers)) {
          setProviders(result.providers);
          setNames(Array.isArray(result.names) ? result.names : []);
        } else setFailed(true);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        setFailed(true);
        if (isGone(caught, target)) onGone?.();
      });
    // Keyed by the member: a switch mounts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed)
    return (
      <p role="alert" style={errorText}>
        {t("settings.memberConnections.loadFailed")}
      </p>
    );
  // Until the read answers, the rows hold their places and say so.
  const rows: {
    provider: MemberProviderStatus["provider"];
    status: MemberProviderStatus["status"] | null;
  }[] = providers ?? [
    { provider: "claude", status: null },
    { provider: "codex", status: null },
  ];
  return (
    <div data-member-providers aria-busy={!providers}>
      {rows.map(({ provider, status }) => {
        const label = provider === "claude" ? "Claude" : "Codex";
        return (
          <ItemRow
            key={provider}
            data-member-provider={provider}
            logo={<ProviderMark provider={provider} size={28} />}
            title={label}
            status={
              status === null ? (
                <Pill tone="neutral">{t("common.loading")}</Pill>
              ) : (
                <Pill
                  tone={
                    status === "connected"
                      ? "green"
                      : status === "not_connected"
                        ? "neutral"
                        : "orange"
                  }
                >
                  {t(
                    status === "connected"
                      ? "settings.signIn.connected"
                      : status === "not_connected"
                        ? "integrations.providers.noPersonal"
                        : "settings.memberConnections.unknown",
                  )}
                </Pill>
              )
            }
          />
        );
      })}
      <OpenCodeSection
        target={target}
        role={role}
        refreshes={0}
        keySet={providers ? names.includes(OPENCODE_KEY) : null}
      />
      <Empty>{t("integrations.providers.memberSignsIn")}</Empty>
    </div>
  );
}
