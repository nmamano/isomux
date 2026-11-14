import { useState } from "react";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
} from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { cardStyle, hint } from "../components/access-shared.tsx";
import {
  dialogSaveBtn,
  filledSecondaryBtn,
} from "../components/dialog-styles.ts";
import { ProviderMark } from "../components/ProviderMark.tsx";
import { ProviderSignInCard } from "../components/ProviderSignInCard.tsx";

// The sign-in card under a chat entry, for the agent's owner only. That is
// why the viewer's effective account (ProviderAccountWire.effective) is the
// agent's own.
export type ChatSignInCardProps = {
  agentId: string;
  accounts: ProviderAccountWire[];
  // Only an office owner signs the office account in or out.
  canChangeOffice: boolean;
} & (
  | {
      // The agent's own engine needs a sign-in: one sign-in, the others
      // collapsed.
      kind: "ownEngine";
      provider: ProviderAccountProvider;
      onStartNewConversation?: () => Promise<void>;
    }
  | {
      // The OpenCode free limit on an office free model: a row per engine to
      // switch the agent to.
      kind: "freeLimit";
      providers: readonly ProviderAccountProvider[];
    }
);

export function ChatSignInCard(props: ChatSignInCardProps) {
  return props.kind === "ownEngine" ? (
    <OwnEngineCard {...props} />
  ) : (
    <FreeLimitCard {...props} />
  );
}

const providerName = (provider: ProviderAccountProvider) =>
  provider === "codex" ? "Codex" : "Claude";

function effectiveAccount(
  accounts: ProviderAccountWire[],
  provider: ProviderAccountProvider,
): ProviderAccountWire | undefined {
  return accounts.find(
    (account) => account.provider === provider && account.effective === true,
  );
}

// The sign-in that makes the agent work: the account it uses now, except
// the office one for a member who cannot sign the office in. A browser
// sign-in of their own moves their agents to it, unless they set their own
// account directory: there it does not, so they keep the office sign-in and
// its ask-the-owner line. An office on Claude through Bedrock or Vertex also
// keeps a member on the office account, but no wire says so: it is left, as
// such an office reads connected and its agents do not fail a sign-in.
function primaryScope(
  accounts: ProviderAccountWire[],
  provider: ProviderAccountProvider,
  canChangeOffice: boolean,
): ProviderAccountScope {
  if (effectiveAccount(accounts, provider)?.scope === "personal")
    return "personal";
  if (canChangeOffice) return "office";
  const personal = accounts.find(
    (account) => account.provider === provider && account.scope === "personal",
  );
  return personal?.explicitDirectory ? "office" : "personal";
}

function OwnEngineCard({
  accounts,
  canChangeOffice,
  provider,
  onStartNewConversation,
}: Extract<ChatSignInCardProps, { kind: "ownEngine" }>) {
  const { t } = useI18n();
  const [others, setOthers] = useState(false);
  const primary = primaryScope(accounts, provider, canChangeOffice);
  const other: ProviderAccountScope =
    primary === "office" ? "personal" : "office";
  return (
    <div data-chat-sign-in="ownEngine">
      <ProviderSignInCard
        provider={provider}
        accounts={accounts}
        showTitle={false}
        compact
        scopes={others ? [primary, other] : [primary]}
        apiKeyNote={others}
        canChangeOffice={canChangeOffice}
        onStartNewConversation={onStartNewConversation}
        footer={
          !others && (
            <button
              type="button"
              data-other-sign-in-options
              onClick={() => setOthers(true)}
              style={smallButton}
            >
              {t("logView.signIn.otherOptions")}
            </button>
          )
        }
      />
    </div>
  );
}

const smallButton = {
  ...filledSecondaryBtn,
  marginTop: 12,
  padding: "3px 10px",
  fontSize: 12,
} as const;

function FreeLimitCard({
  agentId,
  accounts,
  canChangeOffice,
  providers,
}: Extract<ChatSignInCardProps, { kind: "freeLimit" }>) {
  const { t } = useI18n();
  // Until the accounts arrive, the rows hold their place, in the order given,
  // with their controls disabled and no state claimed.
  const loaded = accounts.length > 0;
  const [switching, setSwitching] = useState<ProviderAccountProvider | null>(
    null,
  );
  const [failed, setFailed] = useState<{
    provider: ProviderAccountProvider;
    reason: string;
  } | null>(null);
  const [signingIn, setSigningIn] = useState<ProviderAccountProvider | null>(
    null,
  );
  // An engine is signed in only when the account the agent would use on it
  // is connected: a connected office account does not help an agent that
  // uses an expired personal one.
  const signedIn = (provider: ProviderAccountProvider) =>
    effectiveAccount(accounts, provider)?.accountStatus === "connected";
  const rows = loaded
    ? [...providers].sort((a, b) => Number(signedIn(b)) - Number(signedIn(a)))
    : providers;

  // The server starts the new conversation on the engine's default model.
  async function switchTo(provider: ProviderAccountProvider) {
    setSwitching(provider);
    setFailed(null);
    try {
      await apiFetch("PATCH", `/api/agents/${agentId}`, {
        agentType: provider,
      });
    } catch (caught) {
      setFailed({
        provider,
        reason:
          caught instanceof ApiError && caught.message
            ? caught.message
            : t("logView.freeLimit.switchFailed", {
                provider: providerName(provider),
              }),
      });
    } finally {
      setSwitching(null);
    }
  }

  return (
    <section
      data-chat-sign-in="freeLimit"
      style={{ ...cardStyle, marginTop: 14 }}
    >
      <p style={{ ...hint, margin: "0 0 4px" }}>
        {t("logView.freeLimit.lead")}
      </p>
      {rows.map((provider) => {
        const ready = loaded && signedIn(provider);
        const busy = switching !== null;
        return (
          <div
            key={provider}
            data-chat-sign-in-row={provider}
            data-row-state={
              !loaded ? "loading" : ready ? "signedIn" : "notSignedIn"
            }
            style={{
              borderTop: "1px solid var(--border-subtle)",
              marginTop: 8,
              paddingTop: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <ProviderMark provider={provider} size={18} />
              <strong style={{ fontSize: 13 }}>{providerName(provider)}</strong>
              <span style={{ ...hint, flex: 1, minWidth: 90 }}>
                {!loaded
                  ? t("settings.signIn.checking")
                  : ready
                    ? t("settings.signIn.connected")
                    : t("settings.signIn.notConnected")}
              </span>
              {ready ? (
                <button
                  type="button"
                  data-switch-engine={provider}
                  disabled={busy}
                  onClick={() => void switchTo(provider)}
                  style={dialogSaveBtn}
                >
                  {switching === provider
                    ? t("logView.freeLimit.switching")
                    : t("logView.freeLimit.switchTo", {
                        provider: providerName(provider),
                      })}
                </button>
              ) : (
                signingIn !== provider && (
                  <button
                    type="button"
                    data-row-sign-in={provider}
                    disabled={!loaded}
                    onClick={() => setSigningIn(provider)}
                    style={{
                      ...filledSecondaryBtn,
                    }}
                  >
                    {t("settings.signIn.signIn")}
                  </button>
                )
              )}
            </div>
            {failed?.provider === provider && (
              <p
                role="alert"
                data-switch-error={provider}
                style={{
                  color: "var(--red-text)",
                  fontSize: 12,
                  margin: "6px 0 0",
                }}
              >
                {failed.reason}
              </p>
            )}
            {!ready && signingIn === provider && (
              <ProviderSignInCard
                provider={provider}
                accounts={accounts}
                showTitle={false}
                compact
                scopes={[primaryScope(accounts, provider, canChangeOffice)]}
                canChangeOffice={canChangeOffice}
                style={{ marginTop: 8 }}
              />
            )}
          </div>
        );
      })}
      {rows.some(signedIn) && (
        <p style={{ ...hint, margin: "8px 0 0" }}>
          {t("logView.freeLimit.switchHint")}
        </p>
      )}
    </section>
  );
}
