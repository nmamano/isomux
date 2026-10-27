// The Model providers tab: the Claude and Codex sign-ins agents run on, and
// OpenCode. The sign-in cards are the ones the Connections panes had (Nil:
// that part worked well), laid flat inside the page's cards. An owner who
// looks at another member sees that member's status only: the sign-in is the
// member's own CLI login, which nobody else can start (Lead, ruling 3).
//
// OpenCode has no sign-in here: it ships with Isomux, its free models need
// no key (the default model, OPENCODE_DEFAULT_MODEL, is one), and a key for
// the paid ones is the OPENCODE_API_KEY variable. So its block shows whether
// that variable is set, from the variable names the page already reads.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
import { ProviderFallbackCard } from "../components/ProviderFallbackCard.tsx";
import { Reserved } from "../components/Reserved.tsx";
import {
  Btn,
  Data,
  Empty,
  ItemRow,
  Pill,
  errorText,
  hintText,
} from "./kit.tsx";
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
export function useProviderAccounts() {
  const { providerAccounts } = useAppState();
  const dispatch = useDispatch();
  const { t } = useI18n();
  const alive = useAlive();
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    providerAccounts.length > 0 ? "loaded" : "loading",
  );
  const [refreshing, setRefreshing] = useState(false);
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
    setRefreshing(true);
    setState("loading");
    setError(null);
    void read(true);
  }

  useEffect(() => {
    void read(false);
    // Once per mount; Refresh reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A saved variable or secret can change the OPENAI_API_KEY the Codex card
  // names.
  useEffect(() => {
    const reread = () => void read(false);
    const offEnv = onManagedEnvSaved(reread);
    const offConnections = onConnectionsChanged(reread);
    return () => {
      offEnv();
      offConnections();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    accounts: providerAccounts,
    loaded: state !== "loading",
    refreshing,
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
  onVariables,
}: {
  target: Target;
  role: Role;
  accounts: ReturnType<typeof useProviderAccounts>;
  onGoToOtherCard?: () => void;
  // The member left the office while the card showed them.
  onGone?: () => void;
  // Opens the Variables tab on the same member.
  onVariables: () => void;
}) {
  const list = useMyConnections();
  if (target.kind === "member")
    return (
      <MemberProviders
        target={target}
        onGone={onGone}
        onVariables={onVariables}
      />
    );
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
      <OpenCodeBlock
        office={target.kind === "office"}
        keySet={
          list
            ? list.variables.some(
                (variable) =>
                  variable.scope === scope && variable.name === OPENCODE_KEY,
              )
            : null
        }
        onVariables={onVariables}
      />
      {target.kind === "office" && role === "owner" && (
        <>
          <MemberUsageCard style={flat} />
          <ProviderFallbackCard style={flat} />
        </>
      )}
    </>
  );
}

// A member's Claude and Codex status, for an owner: whether the member has
// their own sign-in (the same probe as their own sign-in card), never the
// account. Read from the owner-only names route. Without a personal sign-in
// the member's agents use an API key variable or the office account, which
// this route cannot tell apart, so the row says only what it knows.
function MemberProviders({
  target,
  onGone,
  onVariables,
}: {
  target: Target & { kind: "member" };
  onGone?: () => void;
  onVariables: () => void;
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
      <Empty>{t("integrations.providers.memberSignsIn")}</Empty>
      <OpenCodeBlock
        office={false}
        keySet={providers ? names.includes(OPENCODE_KEY) : null}
        onVariables={onVariables}
      />
    </div>
  );
}

// OpenCode on one card: that it ships with Isomux (the office card), and
// whether the card's OPENCODE_API_KEY is set. `keySet` null: the names are
// not read (yet), so the block says nothing about the key and holds the
// space of the line.
function OpenCodeBlock({
  office,
  keySet,
  onVariables,
}: {
  office: boolean;
  keySet: boolean | null;
  onVariables: () => void;
}) {
  const { t, rich } = useI18n();
  const { unavailableEngines } = useAppState();
  const unavailable = unavailableEngines.opencode !== undefined;
  const variablesLink = (chunk: ReactNode) => (
    <Btn kind="link" onClick={onVariables} data-go-variables>
      {chunk}
    </Btn>
  );
  const keyLine = (set: boolean | null) => (
    <p
      data-opencode-key={set === null ? undefined : set ? "set" : "none"}
      style={{ ...hintText, margin: 0 }}
    >
      {set
        ? rich("integrations.providers.opencode.keySet", {
            code: (chunk) => <Data>{chunk}</Data>,
          })
        : office
          ? rich("integrations.providers.opencode.noKeyOffice", {
              code: (chunk) => <Data>{chunk}</Data>,
              link: variablesLink,
            })
          : rich("integrations.providers.opencode.noKeyPersonal", {
              code: (chunk) => <Data>{chunk}</Data>,
              link: variablesLink,
            })}
    </p>
  );
  return (
    <section data-provider-block="opencode" style={{ ...flat, marginTop: 14 }}>
      <h5
        style={{
          margin: "0 0 8px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <ProviderMark provider="opencode" />
        OpenCode
        {unavailable && (
          <Pill tone="orange" data-opencode-unavailable="">
            {t("dialogs.agent.engineNeedsLinux")}
          </Pill>
        )}
      </h5>
      {office && (
        <p style={{ ...hintText, margin: "0 0 4px" }}>
          {t("integrations.providers.opencode.bundled")}
        </p>
      )}
      {keySet === null ? (
        // The no-key line, the usual one.
        <Reserved>{keyLine(null)}</Reserved>
      ) : (
        keyLine(keySet)
      )}
    </section>
  );
}
