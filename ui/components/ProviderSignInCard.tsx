import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
  ProviderAccountsWire,
  ProviderLoginStartRes,
} from "../../shared/types.ts";
import { cardStyle, hint } from "./access-shared.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";

export function signOutButtonLabel(pending: boolean): string {
  return pending ? "Signing out…" : "Confirm sign out";
}

export function ProviderSignInCard({
  provider,
  accounts,
  onAccounts,
  onStartNewConversation,
  showTitle = true,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccountWire[];
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
  showTitle?: boolean;
}) {
  const title = provider === "codex" ? "Codex" : "Claude";
  return (
    <section style={{ ...cardStyle, marginTop: 14 }}>
      {showTitle && <h5 style={{ margin: "0 0 12px" }}>{title}</h5>}
      {(["office", "personal"] as const).map((scope) => (
        <ProviderScopeConnection
          key={scope}
          provider={provider}
          scope={scope}
          account={accounts.find(
            (candidate) =>
              candidate.provider === provider && candidate.scope === scope,
          )}
          onAccounts={onAccounts}
          onStartNewConversation={onStartNewConversation}
        />
      ))}
    </section>
  );
}

function ProviderScopeConnection({
  provider,
  scope,
  account,
  onAccounts,
  onStartNewConversation,
}: {
  provider: ProviderAccountProvider;
  scope: ProviderAccountScope;
  account?: ProviderAccountWire;
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [claudeCode, setClaudeCode] = useState("");
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const title = provider === "codex" ? "Codex" : "Claude";
  const scopeTitle =
    scope === "office"
      ? "Option 1: Sign in for every agent in this office"
      : "Option 2: Sign in for agents I spawn";
  const scopeHint =
    scope === "office"
      ? "This subscription is used for every agent in the office except for those spawned by an office member that has set up its own."
      : "Use a separate account for your agents.";

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
      style={{
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 14,
        marginTop: 14,
      }}
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

      {account?.loginStatus === "waiting_external" ? (
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
          <div style={{ margin: "12px 0" }}>
            <p style={{ ...hint, margin: "0 0 8px" }}>
              {provider === "codex"
                ? "Signing in gives you a one-time code to enter on OpenAI's page. The page opens in a new tab; you can also open it on any other device."
                : "Claude opens in your browser. After you sign in, paste the code here."}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={dialogSaveBtn}
                onClick={() =>
                  void connect(provider === "codex" ? "device" : "browser")
                }
                disabled={pending}
              >
                Sign in
              </button>
            </div>
          </div>
        )
      )}
      {deviceCode && account?.loginStatus === "waiting_external" && (
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
        <div style={{ marginTop: 12 }}>
          {externalWarning && (
            <p style={{ ...hint, color: "var(--red)", margin: "0 0 8px" }}>
              {externalWarning}
            </p>
          )}
          {!confirmingSignOut ? (
            <button
              style={{ ...dialogCancelBtn, color: "var(--red)" }}
              onClick={() => setConfirmingSignOut(true)}
              disabled={pending}
            >
              Sign out
            </button>
          ) : (
            <div role="dialog" aria-label={`Sign out ${title}`}>
              <div style={{ display: "flex", gap: 8 }}>
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
            </div>
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
