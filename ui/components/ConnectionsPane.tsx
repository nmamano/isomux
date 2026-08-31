import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ProviderAccountWire,
  ProviderAccountsWire,
  ProviderLoginStartRes,
} from "../../shared/types.ts";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";
import { useAppState } from "../store.tsx";

export function ConnectionsPane() {
  const { providerAccounts: liveAccounts } = useAppState();
  const [loadedAccounts, setLoadedAccounts] = useState<ProviderAccountWire[]>(
    [],
  );
  const accounts = liveAccounts.length > 0 ? liveAccounts : loadedAccounts;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const load = (refresh = false) =>
    apiFetch<ProviderAccountsWire>(
      refresh ? "POST" : "GET",
      refresh
        ? "/api/me/provider-accounts/refresh"
        : "/api/me/provider-accounts",
    )
      .then((r) => setLoadedAccounts(r.accounts))
      .catch((e) =>
        setError(
          e instanceof ApiError
            ? e.message
            : "Could not check provider accounts.",
        ),
      );
  useEffect(() => {
    void apiFetch<ProviderAccountsWire>("GET", "/api/me/provider-accounts")
      .then((r) => setLoadedAccounts(r.accounts))
      .catch((e) =>
        setError(
          e instanceof ApiError
            ? e.message
            : "Could not check provider accounts.",
        ),
      );
  }, []);

  async function connect(method: "browser" | "device") {
    const popup = window.open("about:blank", "_blank");
    setPending("codex");
    setError(null);
    setDeviceCode(null);
    try {
      const result = await apiFetch<ProviderLoginStartRes>(
        "POST",
        "/api/me/provider-accounts/codex/login",
        { method },
      );
      if (result.authUrl) {
        if (popup) {
          popup.location.href = result.authUrl;
          popup.opener = null;
        } else window.open(result.authUrl, "_blank", "noopener,noreferrer");
      } else popup?.close();
      setDeviceCode(result.userCode ?? null);
      setLoadedAccounts((current) =>
        current.map((a) => (a.provider === "codex" ? result.account : a)),
      );
    } catch (e) {
      popup?.close();
      setError(
        e instanceof ApiError ? e.message : "Could not start Codex sign-in.",
      );
    } finally {
      setPending(null);
    }
  }

  async function cancel() {
    setPending("codex");
    try {
      await apiFetch("POST", "/api/me/provider-accounts/codex/cancel");
      await load(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not cancel sign-in.");
    } finally {
      setPending(null);
    }
  }
  const codex = accounts.find((a) => a.provider === "codex");
  const claude = accounts.find((a) => a.provider === "claude");
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
        <button style={dialogCancelBtn} onClick={() => void load(true)}>
          Refresh
        </button>
      </div>
      <p style={hint}>
        Connect the accounts your agents use. The provider stores the
        credentials.
      </p>
      {error && <p style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
      <ConnectionCard title="Codex" account={codex}>
        {codex?.shared && (
          <p style={hint}>
            This signs in the Codex account that the whole office shares.
          </p>
        )}
        {codex?.loginStatus === "waiting_external" ? (
          <button
            style={dialogCancelBtn}
            onClick={() => void cancel()}
            disabled={pending === "codex"}
          >
            Cancel sign-in
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={dialogSaveBtn}
              onClick={() => void connect("browser")}
              disabled={pending === "codex"}
            >
              Connect Codex
            </button>
            <button
              style={dialogCancelBtn}
              onClick={() => void connect("device")}
              disabled={pending === "codex"}
            >
              Use a one-time code
            </button>
          </div>
        )}
        {deviceCode && (
          <p style={hint}>
            Enter this one-time code on the OpenAI page:{" "}
            <strong>{deviceCode}</strong>
          </p>
        )}
      </ConnectionCard>
      <ConnectionCard title="Claude" account={claude}>
        <p style={hint}>
          {claude?.error ??
            "Claude browser sign-in is not available yet. Use the terminal instead."}
        </p>
        <code>claude</code>
      </ConnectionCard>
    </div>
  );
}

function ConnectionCard({
  title,
  account,
  children,
}: {
  title: string;
  account?: ProviderAccountWire;
  children: React.ReactNode;
}) {
  const status =
    account?.accountStatus === "connected"
      ? `Connected${account.accountLabel ? ` as ${account.accountLabel}` : ""}`
      : account?.loginStatus === "waiting_external"
        ? "Waiting for provider…"
        : "Not connected";
  return (
    <section style={{ ...cardStyle, marginTop: 14 }}>
      <h5 style={{ margin: "0 0 4px" }}>{title}</h5>
      <p style={{ ...hint, marginTop: 0 }}>{status}</p>
      {account?.error && title !== "Claude" && (
        <p style={{ color: "var(--red)", fontSize: 12 }}>{account.error}</p>
      )}
      {children}
    </section>
  );
}
