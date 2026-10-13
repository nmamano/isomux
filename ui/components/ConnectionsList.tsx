import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ConnectionScope,
  ConnectionsListRes,
  ConnectionTestRes,
  ConnectionTestResult,
  McpServerStatus,
} from "../../shared/contract-shapes.ts";
import type { ProviderAccountsWire } from "../../shared/types.ts";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { cardStyle, hint } from "./access-shared.tsx";
import {
  connectionRows,
  normalizeConnectionsList,
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

// What a Test shows: the server's answer, or for a sign-in, the account
// check's.
type TestOutcome =
  | ConnectionTestResult
  | { ok: true; kind: "signIn"; account: string | null }
  | { ok: false; kind: "signIn" };

type TestState =
  | { state: "running" }
  | { state: "done"; outcome: TestOutcome }
  | { state: "failed" };

function testPath(
  row: ConnectionRow & { kind: "secret" | "mcpServer" },
  username: string,
): string {
  const base =
    row.scope === "office"
      ? "/api/office"
      : `/api/users/${encodeURIComponent(username)}`;
  const family = row.kind === "secret" ? "secrets" : "mcp-servers";
  return `${base}/${family}/${encodeURIComponent(row.name)}/test`;
}

const resultStyle = (ok: boolean): CSSProperties => ({
  fontSize: 12,
  margin: "4px 0 0",
  color: ok ? "var(--green-text)" : "var(--red-text)",
  overflowWrap: "anywhere",
});

export function ConnectionsList({
  username,
  half,
  canTestOffice,
  onGoToOtherHalf,
}: {
  username: string;
  half: ConnectionScope;
  // Office secrets and MCP servers are tested by owners only, as they are
  // edited.
  canTestOffice: boolean;
  onGoToOtherHalf?: () => void;
}) {
  const { t, tn, rich } = useI18n();
  const { providerAccounts } = useAppState();
  const [list, setList] = useState<ConnectionsListRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Kept by row key while the list stays mounted, across both halves.
  const [tests, setTests] = useState<Record<string, TestState>>({});

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
        const normalized = normalizeConnectionsList(result);
        setList(normalized);
        setError(normalized ? null : t("settings.connections.list.loadFailed"));
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

  function setTest(key: string, state: TestState) {
    setTests((current) => ({ ...current, [key]: state }));
  }

  async function runTest(row: ConnectionRow) {
    if (tests[row.key]?.state === "running") return;
    setTest(row.key, { state: "running" });
    try {
      if (row.kind === "signIn") {
        // The account check the sign-in card's Refresh runs.
        const { accounts } = await apiFetch<ProviderAccountsWire>(
          "POST",
          "/api/me/provider-accounts/refresh",
        );
        const account = accounts?.find(
          (entry) => entry.provider === row.engine && entry.scope === row.scope,
        );
        setTest(row.key, {
          state: "done",
          outcome:
            account?.accountStatus === "connected"
              ? {
                  ok: true,
                  kind: "signIn",
                  account: account.accountLabel?.trim() || null,
                }
              : { ok: false, kind: "signIn" },
        });
        return;
      }
      if (row.kind !== "secret" && row.kind !== "mcpServer") return;
      const { result } = await apiFetch<ConnectionTestRes>(
        "POST",
        testPath(row, username),
      );
      setTest(
        row.key,
        result && typeof result.ok === "boolean"
          ? { state: "done", outcome: result }
          : { state: "failed" },
      );
    } catch {
      setTest(row.key, { state: "failed" });
    }
  }

  // The row's Test button, or why it has none. Claude's own rows show the
  // status Claude reported instead.
  function testSlot(row: ConnectionRow) {
    const noTest = (text: string) => (
      <span data-connection-no-test style={{ ...hint, margin: 0 }}>
        {text}
      </span>
    );
    switch (row.kind) {
      case "variable":
        return noTest(t("settings.connections.test.none"));
      case "secret":
        if (row.scope === "office" && !canTestOffice)
          return noTest(t("settings.connections.test.ownersOnly"));
        if (!row.test) return noTest(t("settings.connections.test.noHostTest"));
        break;
      case "mcpServer":
        if (row.scope === "office" && !canTestOffice)
          return noTest(t("settings.connections.test.ownersOnly"));
        if (row.problem) return noTest(t("settings.connections.test.none"));
        break;
      case "signIn":
        break;
      default:
        return null;
    }
    const running = tests[row.key]?.state === "running";
    return (
      <button
        type="button"
        data-connection-test
        style={{ ...linkStyle, fontSize: 12 }}
        disabled={running}
        onClick={() => void runTest(row)}
      >
        {running
          ? t("settings.connections.test.running")
          : t("settings.connections.test.button")}
      </button>
    );
  }

  function failureText(outcome: Exclude<TestOutcome, { ok: true }>): string {
    if ("kind" in outcome) return t("settings.connections.test.signedOut");
    const host = outcome.host ?? "";
    switch (outcome.reason) {
      case "refused":
        return t("settings.connections.test.refused", { host });
      case "forbidden":
        return t("settings.connections.test.forbidden", { host });
      case "no_credential":
        return t("settings.connections.test.noCredential", { host });
      case "status":
        return t("settings.connections.test.status", {
          host,
          status: String(outcome.status ?? ""),
        });
      case "redirect":
        return t("settings.connections.test.redirect", { host });
      case "timeout":
        return t("settings.connections.test.timeout", { host });
      case "unreachable":
        return t("settings.connections.test.unreachable", { host });
      case "needs_oauth":
        return t("settings.connections.test.needsOauth", { host });
      case "not_testable":
        return t("settings.connections.test.none");
      default:
        return t("settings.connections.test.unexpected", { host });
    }
  }

  function testLine(row: ConnectionRow) {
    const test = tests[row.key];
    if (!test || test.state === "running") return null;
    if (test.state === "failed")
      return (
        <div data-connection-test-result="error" style={resultStyle(false)}>
          {t("settings.connections.test.requestFailed")}
        </div>
      );
    const { outcome } = test;
    if (!outcome.ok)
      return (
        <div data-connection-test-result="failed" style={resultStyle(false)}>
          {failureText(outcome)}
        </div>
      );
    // Service-authored names: rendered as text only.
    const parts = [t("settings.connections.test.works")];
    if (outcome.kind === "mcp") {
      if (outcome.server) parts.push(outcome.server);
      parts.push(tn("settings.connections.test.tools", outcome.tools));
    } else if (outcome.account) parts.push(outcome.account);
    return (
      <div data-connection-test-result="ok" style={resultStyle(true)}>
        {parts.join(" · ")}
      </div>
    );
  }

  function statusText(status: McpServerStatus | null): string {
    switch (status) {
      case "connected":
        return t("settings.connections.status.connected");
      case "failed":
        return t("settings.connections.status.failed");
      case "needs-auth":
        return t("settings.connections.status.needsAuth");
      case "disabled":
        return t("settings.connections.status.disabled");
      default:
        return t("settings.connections.status.pending");
    }
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
          : where.place === "secrets"
            ? t("settings.secrets.title")
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
          // Account-authored names: rendered as text only. A name with no
          // status read yet is pending.
          detail: row.names
            .map((name) =>
              t("settings.connections.list.nameStatus", {
                name,
                status: statusText(
                  row.statuses.find((entry) => entry.name === name)?.status ??
                    null,
                ),
              }),
            )
            .join(", "),
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
                : row.problem === "sign_in"
                  ? t("settings.connections.list.mcpSignIn")
                  : row.problem === "sign_in_again"
                    ? t("settings.connections.list.mcpSignInAgain")
                    : row.oauth
                      ? t("settings.connections.list.mcpOAuth")
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
          detail: [
            row.where.kind === "claudeFile" && row.where.folder !== null
              ? t("settings.connections.list.engineMcpFolder", {
                  folder: row.where.folder,
                })
              : t("settings.connections.list.engineMcpUser"),
            statusText(row.status),
          ].join(" · "),
        };
      case "secret":
        return {
          name: <code>{row.name}</code>,
          kind: t("settings.connections.list.kindSecret"),
          detail: row.hosts.join(", "),
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
                  <span style={{ marginLeft: "auto" }}>{testSlot(row)}</span>
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
                {(row.kind === "variable" ||
                  row.kind === "secret" ||
                  row.kind === "mcpServer") &&
                  row.note && (
                    <div
                      data-connection-note
                      aria-label={t("settings.connections.note")}
                      title={t("settings.connections.note")}
                      style={{
                        fontSize: 12,
                        margin: "6px 0 0",
                        padding: "2px 0 2px 8px",
                        borderLeft: "2px solid var(--border)",
                        color: "var(--text-secondary)",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.note}
                    </div>
                  )}
                {testLine(row)}
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
      {rows.some((row) => row.kind === "variable") && (
        <p data-variables-no-test style={{ ...hint, margin: "8px 0 0" }}>
          {t("settings.connections.test.variablesHint")}
        </p>
      )}
    </section>
  );
}
