import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
  ProviderAccountsWire,
  ProviderLoginStartRes,
} from "../../shared/types.ts";
import { cardStyle, hint, SettingsLink } from "./access-shared.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";

export function signOutButtonLabel(pending: boolean): string {
  return pending ? "Signing out…" : "Confirm sign out";
}

// `scopes` picks which of the two sign-in scopes this card shows. The
// settings page renders one scope per pane (office sign-ins under Office,
// personal ones under You), while the log view's inline card still shows
// both, so the default stays the full pair.
export function ProviderSignInCard({
  provider,
  accounts,
  onAccounts,
  onStartNewConversation,
  showTitle = true,
  apiKeyNote = false,
  scopes = ["office", "personal"],
  onGoToOtherHalf,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccountWire[];
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
  showTitle?: boolean;
  apiKeyNote?: boolean;
  scopes?: readonly ProviderAccountScope[];
  // Moves the settings page to the other Connections section. Absent
  // wherever the card is mounted outside that page (the log view), where the
  // pointer stays plain text.
  onGoToOtherHalf?: () => void;
}) {
  const title = provider === "codex" ? "Codex" : "Claude";
  return (
    <section style={{ ...cardStyle, marginTop: 14 }}>
      {showTitle && <h5 style={{ margin: "0 0 12px" }}>{title}</h5>}
      {scopes.map((scope, index) => (
        <ProviderScopeConnection
          key={scope}
          provider={provider}
          scope={scope}
          hideTopBorder={index === 0 && !showTitle}
          account={accounts.find(
            (candidate) =>
              candidate.provider === provider && candidate.scope === scope,
          )}
          onAccounts={onAccounts}
          onStartNewConversation={onStartNewConversation}
          onGoToOtherHalf={onGoToOtherHalf}
        />
      ))}
      {apiKeyNote && (
        <p
          style={{
            ...hint,
            margin: "14px 0 0",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 14,
          }}
        >
          Do you want to use an API token? See Settings → You → Individual
          connections.
        </p>
      )}
    </section>
  );
}

function ProviderScopeConnection({
  provider,
  scope,
  account,
  onAccounts,
  onStartNewConversation,
  onGoToOtherHalf,
  hideTopBorder = false,
}: {
  provider: ProviderAccountProvider;
  scope: ProviderAccountScope;
  account?: ProviderAccountWire;
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
  onGoToOtherHalf?: () => void;
  hideTopBorder?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // Local mirror of "a sign-in is in flight". The wire's waiting_external
  // can lag or never reach this card (seen live in the chat card), and the
  // paste-code input must not depend on it.
  const [localWaiting, setLocalWaiting] = useState(false);
  const [claudeCode, setClaudeCode] = useState("");
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // The one-time code renders from local state the moment the login POST
  // returns - gating it on the pushed account status hid it whenever that
  // update lagged. Once the account reports connected, retire the code so
  // it cannot linger after a later sign-out.
  const connected = account?.accountStatus === "connected";
  useEffect(() => {
    if (connected) {
      setDeviceCode(null);
      setCodeCopied(false);
      setAuthUrl(null);
      setLinkCopied(false);
      setLocalWaiting(false);
    }
  }, [connected]);
  const title = provider === "codex" ? "Codex" : "Claude";
  const scopeTitle =
    scope === "office"
      ? "Office-wide: sign in for every agent in this office"
      : "Individual: sign in for agents I spawn";
  // The office scope's sentence names the other section, so it carries the
  // cross-link rather than plain words.
  const scopeHint =
    scope === "office" ? (
      <>
        This subscription is used for every agent in the office except for
        agents spawned by an office member who has set up{" "}
        <SettingsLink label="Individual connections" onGo={onGoToOtherHalf} />.
      </>
    ) : (
      "Use a separate account for your agents."
    );

  async function refresh(): Promise<void> {
    const result = await apiFetch<ProviderAccountsWire>(
      "POST",
      "/api/me/provider-accounts/refresh",
    );
    onAccounts?.(result.accounts);
  }

  async function connect(method: "browser" | "device") {
    const popup = window.open("about:blank", "_blank");
    setPending(true);
    setError(null);
    setDeviceCode(null);
    setCodeCopied(false);
    setAuthUrl(null);
    setLinkCopied(false);
    try {
      const result = await apiFetch<ProviderLoginStartRes>(
        "POST",
        `/api/me/provider-accounts/${provider}/login`,
        { method, scope },
      );
      if (result.authUrl) {
        if (popup) {
          popup.location.href = result.authUrl;
          popup.opener = null;
        } else window.open(result.authUrl, "_blank", "noopener,noreferrer");
      } else popup?.close();
      setDeviceCode(result.userCode ?? null);
      setAuthUrl(result.authUrl ?? null);
      setLocalWaiting(true);
      await refresh();
    } catch (caught) {
      popup?.close();
      setError(
        caught instanceof ApiError
          ? caught.message
          : `Could not start ${title} sign-in.`,
      );
    } finally {
      setPending(false);
    }
  }

  async function submitClaudeCode() {
    setPending(true);
    setError(null);
    try {
      await apiFetch("POST", "/api/me/provider-accounts/claude/callback", {
        scope,
        code: claudeCode,
      });
      setClaudeCode("");
      setLocalWaiting(false);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not submit the Claude code.",
      );
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);
    setError(null);
    try {
      await apiFetch("POST", `/api/me/provider-accounts/${provider}/cancel`, {
        scope,
      });
      setDeviceCode(null);
      setAuthUrl(null);
      setLocalWaiting(false);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not cancel sign-in.",
      );
    } finally {
      setPending(false);
    }
  }

  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<ProviderAccountsWire>(
        "POST",
        `/api/me/provider-accounts/${provider}/disconnect`,
        { scope },
      );
      onAccounts?.(result.accounts);
      setConfirmingSignOut(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : `Could not sign out ${title}.`,
      );
    } finally {
      setPending(false);
    }
  }

  const status = !account
    ? "Checking connection…"
    : account.loginStatus === "waiting_external"
      ? "Waiting for provider…"
      : account.accountStatus === "connected"
        ? account.accountLabel
          ? `Connected as ${account.accountLabel}`
          : "Connected"
        : account.accountStatus === "unavailable"
          ? "Connection unavailable"
          : "Not connected";
  const externalWarning = account?.externalCli
    ? `This signs out ${title} in this machine, even outside the office.`
    : account?.explicitDirectory
      ? "This removes the sign-in from the account directory you chose."
      : null;

  return (
    <div
      style={
        hideTopBorder
          ? {}
          : {
              borderTop: "1px solid var(--border-subtle)",
              paddingTop: 14,
              marginTop: 14,
            }
      }
    >
      <div style={{ fontSize: 12, fontWeight: 650 }}>{scopeTitle}</div>
      <p style={{ ...hint, margin: "8px 0 0" }}>{scopeHint}</p>
      <p style={{ ...hint, margin: "8px 0 0" }}>
        <strong>Status:</strong> {status}
      </p>
      {account?.error && (
        <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>
          {account.error}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>
          {error}
        </p>
      )}

      {account?.loginStatus === "waiting_external" ||
      (localWaiting && !connected) ? (
        <div style={{ margin: "12px 0" }}>
          {provider === "claude" && (
            <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
              Paste the code from Claude:
              <input
                value={claudeCode}
                onChange={(event) => setClaudeCode(event.target.value)}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
          )}
          {provider === "claude" && (
            <button
              style={{ ...dialogCancelBtn, marginRight: 8 }}
              onClick={() => void submitClaudeCode()}
              disabled={pending || !claudeCode.trim()}
            >
              Submit code
            </button>
          )}
          <button
            style={dialogCancelBtn}
            onClick={() => void cancel()}
            disabled={pending}
          >
            Cancel sign-in
          </button>
        </div>
      ) : (
        account?.canBrowserLogin &&
        account.accountStatus !== "connected" && (
          <div
            style={{
              margin: "12px 0",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <button
              style={{ ...dialogSaveBtn, flexShrink: 0 }}
              onClick={() =>
                void connect(provider === "codex" ? "device" : "browser")
              }
              disabled={pending}
            >
              {pending ? "Signing in…" : "Sign in"}
            </button>
            <p style={{ ...hint, margin: 0, flex: 1, minWidth: 180 }}>
              {provider === "codex"
                ? "Signing in gives you a one-time code to enter on OpenAI's page. The page opens in a new tab; you can also open it on any other device."
                : "Claude opens in your browser. After you sign in, paste the code here."}
            </p>
          </div>
        )
      )}
      {authUrl && !connected && (
        <p style={{ ...hint, margin: "12px 0 0" }}>
          Link didn&apos;t open?{" "}
          <button
            style={{ ...dialogCancelBtn, padding: "3px 10px" }}
            onClick={() =>
              void navigator.clipboard
                .writeText(authUrl)
                .then(() => setLinkCopied(true))
            }
          >
            {linkCopied ? "Link copied" : "Copy sign-in link"}
          </button>
        </p>
      )}
      {deviceCode && !connected && (
        <div style={{ margin: "12px 0" }}>
          <p style={{ ...hint, margin: "0 0 6px" }}>
            Enter this one-time code on the OpenAI page:
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: 2,
                color: "var(--accent)",
                background: "var(--bg-code)",
                border: "1px solid var(--accent)",
                borderRadius: 8,
                padding: "6px 12px",
              }}
            >
              {deviceCode}
            </span>
            <button
              style={dialogCancelBtn}
              onClick={() =>
                void navigator.clipboard
                  .writeText(deviceCode)
                  .then(() => setCodeCopied(true))
              }
            >
              {codeCopied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {account?.accountStatus === "connected" && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {!confirmingSignOut ? (
            <button
              style={{ ...dialogCancelBtn, color: "var(--red)", flexShrink: 0 }}
              onClick={() => setConfirmingSignOut(true)}
              disabled={pending}
            >
              Sign out
            </button>
          ) : (
            <div
              role="dialog"
              aria-label={`Sign out ${title}`}
              style={{ display: "flex", gap: 8, flexShrink: 0 }}
            >
              <button
                autoFocus
                style={dialogCancelBtn}
                onClick={() => setConfirmingSignOut(false)}
                disabled={pending}
              >
                Cancel
              </button>
              <button
                style={{ ...dialogCancelBtn, color: "var(--red)" }}
                onClick={() => void disconnect()}
                disabled={pending}
              >
                {signOutButtonLabel(pending)}
              </button>
            </div>
          )}
          {externalWarning && (
            <p
              style={{
                ...hint,
                color: "var(--red)",
                margin: 0,
                flex: 1,
                minWidth: 180,
              }}
            >
              {externalWarning}
            </p>
          )}
        </div>
      )}
      {account?.loginStatus === "succeeded" && onStartNewConversation && (
        <div style={{ margin: "12px 0" }}>
          <p style={hint}>
            Connected. Start a new conversation to use this account.
          </p>
          <button
            style={dialogCancelBtn}
            onClick={() => void onStartNewConversation()}
          >
            Start a new conversation
          </button>
        </div>
      )}
    </div>
  );
}
