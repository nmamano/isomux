import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ConnectionScope,
  ConnectionsListRes,
} from "../../shared/contract-shapes.ts";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { cardStyle, hint } from "./access-shared.tsx";
import {
  connectionRows,
  type ConnectionRow,
  type ConnectionRowWhere,
} from "../connection-rows.ts";
import {
  onConnectionsChanged,
  onManagedEnvSaved,
} from "../connections-events.ts";

// The integrations list (task 911c9bbb): every connection the viewer's agents
// can use, read-only, above the editors that set them. Both halves of the
// Connections page mount it with the same rows, so the page reads as one list
// and each row's tag says who gets it.

// A link into the other half: the selector waits here until that half mounts.
let pendingScroll: string | null = null;

function holdScroll(selector: string): void {
  pendingScroll = selector;
}

function takeScroll(): string | null {
  const selector = pendingScroll;
  pendingScroll = null;
  return selector;
}

function scrollToPlace(selector: string): void {
  document
    .querySelector(selector)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const tagStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
};

const linkStyle: CSSProperties = {
  font: "inherit",
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent-text)",
  cursor: "pointer",
  textDecoration: "underline",
};

export function ConnectionsList({
  username,
  half,
  onGoToOtherHalf,
}: {
  username: string;
  half: ConnectionScope;
  onGoToOtherHalf?: () => void;
}) {
  const { t, rich } = useI18n();
  const { providerAccounts } = useAppState();
  const [list, setList] = useState<ConnectionsListRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  // A sign-in or sign-out changes the list: reload when the accounts the
  // pane keeps fresh change, not on every identical update.
  const accountsKey = providerAccounts
    .map(
      (account) =>
        `${account.provider}:${account.scope}:${account.accountStatus}:${account.accountLabel ?? ""}`,
    )
    .join("|");

  useEffect(() => onManagedEnvSaved(() => setReloads((n) => n + 1)), []);
  useEffect(() => onConnectionsChanged(() => setReloads((n) => n + 1)), []);

  useEffect(() => {
    let live = true;
    apiFetch<ConnectionsListRes>("GET", "/api/me/connections")
      .then((result) => {
        if (!live) return;
        // A server without this route (the UI built before a restart) or a
        // stub answers with another shape: show the load failure, not a crash
        // that takes the whole settings page down.
        if (
          !Array.isArray(result?.variables) ||
          !Array.isArray(result?.signIns) ||
          !Array.isArray(result?.claudeConnectors)
        ) {
          setList(null);
          setError(t("settings.connections.list.loadFailed"));
          return;
        }
        // The MCP fields came later (A2): a server from before them has none,
        // and a field of another shape loses only its own rows.
        setList({
          ...result,
          mcpServers: Array.isArray(result.mcpServers) ? result.mcpServers : [],
          engineMcpServers: Array.isArray(result.engineMcpServers)
            ? result.engineMcpServers
            : [],
        });
        setError(null);
      })
      .catch((caught) => {
        if (!live) return;
        setError(
          caught instanceof ApiError
            ? caught.message
            : t("settings.connections.list.loadFailed"),
        );
      });
    return () => {
      live = false;
    };
    // The catalog lookup is stable for the life of a language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, reloads]);

  // Both halves reuse this mounted list, so a move to the other half shows
  // up as a change of `half`.
  useEffect(() => {
    if (!list) return;
    const selector = takeScroll();
    if (selector) requestAnimationFrame(() => scrollToPlace(selector));
  }, [list, half]);

  const rows = useMemo(
    () => (list ? connectionRows(list, username) : []),
    [list, username],
  );

  function go(where: ConnectionRowWhere & { kind: "page" }) {
    if (where.half === half) {
      scrollToPlace(where.selector);
      return;
    }
    holdScroll(where.selector);
    onGoToOtherHalf?.();
  }

  function setIn(where: ConnectionRowWhere) {
    if (where.kind === "claudeFile")
      return where.source === "user"
        ? t("settings.connections.list.setInClaudeUser")
        : where.source === "local"
          ? t("settings.connections.list.setInClaudeLocal", {
              folder: where.folder ?? "",
            })
          : t("settings.connections.list.setInProject", {
              file: `${where.folder ?? ""}/.mcp.json`,
            });
    if (where.kind === "claude")
      return rich("settings.connections.list.setIn", {
        place: "claude.ai",
        link: (chunk) => (
          <a
            data-connection-link="claude"
            href={where.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent-text)" }}
          >
            {chunk}
          </a>
        ),
      });
    const place =
      where.place === "variables"
        ? t("settings.connections.envTitle")
        : where.place === "mcpServers"
          ? t("settings.mcpServers.title")
          : t("settings.connections.list.placeSignIn", {
              provider: where.engine === "codex" ? "Codex" : "Claude",
            });
    return rich("settings.connections.list.setIn", {
      place,
      link: (chunk) => (
        <button
          type="button"
          data-connection-link="page"
          style={linkStyle}
          onClick={() => go(where)}
        >
          {chunk}
        </button>
      ),
    });
  }

  function describe(row: ConnectionRow) {
    switch (row.kind) {
      case "variable":
        return {
          name: <code>{row.name}</code>,
          kind: t("settings.connections.list.kindVariable"),
          detail: t("settings.connections.list.accountUnknown"),
        };
      case "signIn":
        return {
          name: row.engine === "codex" ? "Codex" : "Claude",
          kind: t("settings.connections.list.kindSignIn"),
          detail: row.account ?? t("settings.connections.list.accountUnknown"),
        };
      case "connectors":
        return {
          name: t("settings.connections.list.claudeConnectors"),
          kind: t("settings.connections.list.kindManagedInClaude"),
          // Account-authored names: rendered as text only.
          detail: row.names.join(", "),
        };
      case "connectorsPending":
        return {
          name: t("settings.connections.list.claudeConnectors"),
          kind: t("settings.connections.list.kindManagedInClaude"),
          detail: t("settings.connections.list.connectorsPendingHint"),
        };
      case "mcpServer":
        return {
          name: <code>{row.name}</code>,
          kind: t("settings.connections.list.kindMcpServer"),
          detail: [
            row.host,
            row.problem === "secret_missing"
              ? t("settings.connections.list.mcpSecretMissing")
              : row.problem === "secret_host"
                ? t("settings.connections.list.mcpSecretHost", {
                    host: row.host,
                  })
                : row.secret
                  ? t("settings.connections.list.mcpCredentialNamed", {
                      name: row.secret,
                    })
                  : row.credential
                    ? t("settings.connections.list.mcpCredential")
                    : t("settings.connections.list.mcpNoCredential"),
          ].join(" · "),
        };
      case "engineMcp":
        return {
          // Names from the member's own files: rendered as text only.
          name: <code>{row.name}</code>,
          kind: t("settings.connections.list.kindMcpInClaude"),
          detail:
            row.where.kind === "claudeFile" && row.where.folder !== null
              ? t("settings.connections.list.engineMcpFolder", {
                  folder: row.where.folder,
                })
              : t("settings.connections.list.engineMcpUser"),
        };
    }
  }

  return (
    <section data-connections-list style={{ ...cardStyle, marginTop: 14 }}>
      <h5 style={{ margin: "0 0 4px" }}>
        {t("settings.connections.list.title")}
      </h5>
      <p style={{ ...hint, margin: "0 0 10px" }}>
        {t("settings.connections.list.legend")}
      </p>
      {error ? (
        <p role="alert" style={{ color: "var(--red-text)", fontSize: 12 }}>
          {error}
        </p>
      ) : !list ? (
        <p style={{ ...hint, margin: 0 }}>{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <p style={{ ...hint, margin: 0 }}>
          {t("settings.connections.list.empty")}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row, index) => {
            const { name, kind, detail } = describe(row);
            return (
              <li
                key={row.key}
                data-connection-row={row.kind}
                data-connection-scope={row.scope}
                style={{
                  padding: "8px 0",
                  borderTop:
                    index === 0 ? "none" : "1px solid var(--border-subtle)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <strong
                    data-connection-name
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {name}
                  </strong>
                  <span style={{ ...hint, margin: 0 }}>{kind}</span>
                  {/* Office-wide and Individual are Isomux's scopes. A server
                      set in Claude reaches whoever its Claude file reaches,
                      which its detail says. */}
                  {row.kind !== "engineMcp" && (
                    <span data-connection-tag={row.scope} style={tagStyle}>
                      {row.scope === "office"
                        ? t("settings.connections.list.scopeOffice")
                        : t("settings.connections.list.scopePersonal")}
                    </span>
                  )}
                </div>
                <div style={{ ...hint, margin: "4px 0 0" }}>
                  <span
                    data-connection-detail
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {detail}
                  </span>
                  {" · "}
                  {setIn(row.where)}
                </div>
                {row.kind === "mcpServer" && row.overridden && (
                  <div
                    data-mcp-overridden
                    style={{ ...hint, margin: "4px 0 0" }}
                  >
                    {t("settings.connections.list.mcpOverridden")}
                  </div>
                )}
                {(row.kind === "connectors" ||
                  row.kind === "connectorsPending") &&
                  row.scope === "office" && (
                    <div
                      data-every-claude-agent
                      style={{ ...hint, margin: "4px 0 0" }}
                    >
                      {t("settings.connections.list.everyClaudeAgent")}
                    </div>
                  )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
