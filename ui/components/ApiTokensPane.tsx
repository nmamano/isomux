import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ApiTokenCreateRes,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../shared/contract-shapes.ts";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";

const EXPIRY_OPTIONS = [30, 365, null] as const;
type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number];

export function ApiTokensPane() {
  const [tokens, setTokens] = useState<ApiTokenWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryChoice>(30);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<ApiTokenListRes>("GET", "/api/me/api-tokens")
      .then((res) => setTokens(res.apiTokens))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : "Failed to load API tokens",
        ),
      )
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  function create() {
    if (!name.trim()) return;
    setPending(true);
    setError(null);
    setRawToken(null);
    apiFetch<ApiTokenCreateRes>("POST", "/api/me/api-tokens", {
      name: name.trim(),
      expiresInDays,
    })
      .then((res) => {
        setTokens((current) => [res.apiToken, ...current]);
        setRawToken(res.token);
        setName("");
      })
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : "Failed to create API token",
        ),
      )
      .finally(() => setPending(false));
  }

  function revoke(id: string) {
    setError(null);
    apiFetch<void>("DELETE", `/api/me/api-tokens/${encodeURIComponent(id)}`)
      .then(() =>
        setTokens((current) => current.filter((token) => token.id !== id)),
      )
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : "Failed to revoke API token",
        ),
      );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>API tokens</h4>
      <p style={hint}>
        Send messages to your visible agents from scripts and other devices.
        Tokens cannot manage your office or read conversations.
      </p>

      <div style={cardStyle}>
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Laptop script"
            maxLength={64}
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          />
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          Expires after
          <select
            value={expiresInDays === null ? "never" : expiresInDays}
            onChange={(event) =>
              setExpiresInDays(
                event.target.value === "never"
                  ? null
                  : (Number(event.target.value) as ExpiryChoice),
              )
            }
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          >
            {EXPIRY_OPTIONS.map((days) => (
              <option
                key={days === null ? "never" : days}
                value={days === null ? "never" : days}
              >
                {days === null ? "Unlimited" : `${days} days`}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={create}
          disabled={pending || !name.trim()}
          style={{
            ...dialogSaveBtn,
            marginTop: 12,
            opacity: pending ? 0.5 : 1,
          }}
        >
          {pending ? "Creating…" : "Create token"}
        </button>
      </div>

      {rawToken && (
        <div style={{ ...cardStyle, marginTop: 12 }}>
          <strong style={{ fontSize: 12 }}>Copy this token now</strong>
          <p style={hint}>It will not be shown again.</p>
          <code
            style={{
              display: "block",
              overflowWrap: "anywhere",
              userSelect: "all",
            }}
          >
            {rawToken}
          </code>
        </div>
      )}

      {error && <p style={{ color: "#ff6b6b", fontSize: 12 }}>{error}</p>}

      <div style={{ marginTop: 18 }}>
        {!loaded ? (
          <p style={hint}>Loading…</p>
        ) : tokens.length === 0 ? (
          <p style={hint}>No API tokens.</p>
        ) : (
          tokens.map((token) => (
            <div key={token.id} style={{ ...cardStyle, marginBottom: 8 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <strong style={{ fontSize: 13 }}>{token.name}</strong>
                  <div style={hint}>
                    {token.tokenPrefix}… ·{" "}
                    {token.expiresAt === null
                      ? "never expires"
                      : `expires ${new Date(token.expiresAt).toLocaleDateString()}`}
                  </div>
                  <div style={hint}>
                    Last authenticated request:{" "}
                    {token.lastUsedAt
                      ? `about ${new Date(token.lastUsedAt).toLocaleString()}`
                      : "never"}
                  </div>
                </div>
                <button
                  onClick={() => revoke(token.id)}
                  style={{ ...dialogSaveBtn, alignSelf: "start" }}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
