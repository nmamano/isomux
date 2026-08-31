import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
  ProviderLoginStartRes,
} from "../../shared/types.ts";
import { cardStyle, hint } from "./access-shared.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";

export function ProviderSignInCard({
  provider,
  accounts,
  onAccounts,
  onStartNewConversation,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccountWire[];
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
}) {
  const [scope, setScope] = useState<ProviderAccountScope>("office");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [claudeCode, setClaudeCode] = useState("");
  const account = accounts.find(
    (candidate) => candidate.provider === provider && candidate.scope === scope,
  );
  const title = provider === "codex" ? "Codex" : "Claude";

  async function refresh(): Promise<void> {
    const result = await apiFetch<{ accounts: ProviderAccountWire[] }>(
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
      onAccounts?.(
        accounts.map((current) =>
          current.provider === provider && current.scope === scope
            ? result.account
            : current,
        ),
      );
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

  const status =
    account?.accountStatus === "connected"
      ? `Connected${account.accountLabel ? ` as ${account.accountLabel}` : ""}`
      : account?.loginStatus === "waiting_external"
        ? "Waiting for provider…"
        : "Not connected";
  const personalRefused = scope === "personal" && !account?.canBrowserLogin;

  return (
    <section style={{ ...cardStyle, marginTop: 14 }}>
      <h5 style={{ margin: "0 0 4px" }}>{title}</h5>
      <p style={{ ...hint, marginTop: 0 }}>{status}</p>
      <fieldset
        style={{ border: 0, padding: 0, margin: "12px 0" }}
        aria-label="Who should use this account?"
      >
        <legend style={{ fontSize: 12, fontWeight: 650, marginBottom: 8 }}>
          Who should use this account?
        </legend>
        <label style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
          <input
            type="radio"
            name={`${provider}-account-scope`}
            checked={scope === "office"}
            onChange={() => setScope("office")}
          />{" "}
          Every agent in this office
          <span style={{ ...hint, display: "block", marginLeft: 20 }}>
            Use the office account for agents that anyone spawns.
          </span>
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          <input
            type="radio"
            name={`${provider}-account-scope`}
            checked={scope === "personal"}
            onChange={() => setScope("personal")}
          />{" "}
          Only agents I spawn
          <span style={{ ...hint, display: "block", marginLeft: 20 }}>
            Use a separate account for your agents.
          </span>
        </label>
      </fieldset>

      {scope === "office" && account?.shared && (
        <p style={hint}>
          {provider === "codex"
            ? "This signs in the Codex account that the whole office shares."
            : "This signs in the Claude account that the whole office shares."}
        </p>
      )}
      {personalRefused && account?.error && (
        <p style={{ color: "var(--red)", fontSize: 12 }}>{account.error}</p>
      )}
      {!personalRefused && account?.error && (
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
              style={{ ...dialogSaveBtn, marginRight: 8 }}
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
        account?.canBrowserLogin && (
          <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            <button
              style={dialogSaveBtn}
              title="Use browser sign-in when you can open the provider page in this browser."
              onClick={() => void connect("browser")}
              disabled={pending}
            >
              {`Connect ${title}`}
            </button>
            {provider === "codex" && (
              <button
                style={dialogCancelBtn}
                title="Use a one-time code when Isomux runs on a remote or headless computer."
                onClick={() => void connect("device")}
                disabled={pending}
              >
                Use a one-time code
              </button>
            )}
          </div>
        )
      )}
      {deviceCode && (
        <p style={hint}>
          Enter this one-time code on the OpenAI page:{" "}
          <strong>{deviceCode}</strong>
        </p>
      )}
      {account?.loginStatus === "succeeded" && onStartNewConversation && (
        <div style={{ margin: "12px 0" }}>
          <p style={hint}>
            Connected. Start a new conversation to use this account.
          </p>
          <button
            style={dialogSaveBtn}
            onClick={() => void onStartNewConversation()}
          >
            Start a new conversation
          </button>
        </div>
      )}
    </section>
  );
}
