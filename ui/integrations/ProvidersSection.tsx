// The Model providers tab: the Claude and Codex sign-ins agents run on, and
// OpenCode. The sign-in cards are the ones the Connections panes had (Nil:
// that part worked well), laid flat inside the page's cards. An owner who
// picks another member signs that member in to or out of their own accounts,
// so IT can set them up (Nil, 2026-11-14).
//
// OpenCode has no sign-in here: it ships with Isomux, its free models need
// no key (the default model, OPENCODE_DEFAULT_MODEL, is one), and a key for
// the paid ones is the OPENCODE_API_KEY variable (OpenCodeSection.tsx).

import { useEffect, useRef, useState } from "react";
import type { UserEnvNamesRes } from "../../shared/contract-shapes.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
} from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import {
  ProviderSignInCard,
  type MemberSignIns,
} from "../components/ProviderSignInCard.tsx";
import { MemberUsageCard } from "../components/MemberUsageCard.tsx";
import { OpenCodeSection } from "./OpenCodeSection.tsx";
import { errorText, flatCard } from "./kit.tsx";
import { useMyConnections } from "./my-connections.tsx";
import {
  onConnectionsChanged,
  onManagedEnvSaved,
} from "../connections-events.ts";
import { useAlive } from "./use-alive.ts";
import { isGone, type Role, type Target } from "./target.ts";

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
        // The refresh route pushes what it read, and its answer can be older
        // than a push that overtook it: only the GET, which pushes nothing,
        // fills the store.
        if (!refresh)
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
          scopes={scopes}
          onGoToOtherHalf={onGoToOtherCard}
          style={flatCard}
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
        <MemberUsageCard style={flatCard} />
      )}
    </>
  );
}

// A member's own Claude and Codex sign-ins, for an owner who sets them up
// (task f183fac3): the same cards as the member's, on the member's routes,
// and their OpenCode key (OpenCodeSection.tsx), from the owner-only names
// route. No push reaches the owner, so the cards read again while a sign-in
// waits for the member's account.
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
  const [names, setNames] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const signIns = useMemberSignIns(target, onGone);

  useEffect(() => {
    apiFetch<UserEnvNamesRes>(
      "GET",
      `/api/users/${encodeURIComponent(username)}/env/names`,
    )
      .then((result) => {
        if (!alive.current) return;
        if (Array.isArray(result?.names)) setNames(result.names);
        else setFailed(true);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        setFailed(true);
        if (isGone(caught, target)) onGone?.();
      });
    // Keyed by the member: a switch mounts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed || signIns.failed)
    return (
      <p role="alert" style={errorText}>
        {t("settings.memberConnections.loadFailed")}
      </p>
    );
  return (
    <>
      {(["codex", "claude"] as const).map((provider) => (
        <ProviderSignInCard
          key={provider}
          provider={provider}
          accounts={signIns.accounts ?? []}
          loaded={signIns.accounts !== null}
          scopes={["personal"]}
          member={signIns.member}
          style={flatCard}
          pageLook
        />
      ))}
      <OpenCodeSection
        target={target}
        role={role}
        refreshes={0}
        keySet={names ? names.includes(OPENCODE_KEY) : null}
      />
    </>
  );
}

// How often the owner's card reads a member's sign-in that waits for the
// member's account.
const MEMBER_SIGN_IN_POLL_MS = 2000;

// A member's sign-ins, as their owner's card reads them. Every read is
// numbered and only the latest one started may land, so a read sent before
// an action never undoes what the action's own read showed.
function useMemberSignIns(
  target: Target & { kind: "member" },
  onGone?: () => void,
) {
  const username = target.username;
  const alive = useAlive();
  const [accounts, setAccounts] = useState<ProviderAccountWire[] | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  // A read that fails after the first one leaves the cards as they were.
  const loaded = useRef(false);
  const path = `/api/users/${encodeURIComponent(username)}/provider-accounts`;

  const read = (): Promise<void> => {
    const mine = ++latest.current;
    const current = () => alive.current && mine === latest.current;
    return apiFetch<ProviderAccountsWire>("GET", path)
      .then((result) => {
        if (!current()) return;
        if (Array.isArray(result?.accounts)) {
          loaded.current = true;
          setAccounts(result.accounts);
        } else if (!loaded.current) setFailed(true);
      })
      .catch((caught: unknown) => {
        if (!current()) return;
        if (!loaded.current) setFailed(true);
        if (isGone(caught, target)) onGone?.();
      });
  };

  useEffect(() => {
    void read();
    // Keyed by the member: a switch mounts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waiting = (accounts ?? []).some(
    (account) =>
      account.scope === "personal" &&
      (account.login?.phase === "waiting" ||
        account.login?.phase === "verifying"),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void read(), MEMBER_SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const member: MemberSignIns = {
    username,
    base: path,
    started: (account) => {
      // A read sent before the start must not land after it.
      latest.current++;
      setAccounts((current) => [
        ...(current ?? []).filter(
          (entry) =>
            !(
              entry.provider === account.provider &&
              entry.scope === account.scope
            ),
        ),
        account,
      ]);
    },
    reread: read,
  };
  return { accounts, failed, member };
}
