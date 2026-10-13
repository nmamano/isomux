// What Claude itself gives Claude agents, on the MCP servers tab: the
// claude.ai connectors of a Claude sign-in, and the MCP servers set in
// Claude's own files. Both come from the caller's connections list, so the
// page shows them on the office card and under "You" only (ruling 3).

import type {
  ConnectionScope,
  McpServerStatus,
} from "../../shared/contract-shapes.ts";
import { CLAUDE_CONNECTORS_URL } from "../connection-rows.ts";
import { useI18n } from "../i18n.tsx";
import { HelpTip, ItemRow, Pill, hintText, mono, type Tone } from "./kit.tsx";
import { useMyConnections } from "./my-connections.tsx";

const STATUS: Record<
  McpServerStatus,
  {
    key:
      | "integrations.status.connected"
      | "integrations.status.pending"
      | "integrations.status.needsAuth"
      | "integrations.status.failed"
      | "integrations.status.off";
    tone: Tone;
  }
> = {
  connected: { key: "integrations.status.connected", tone: "green" },
  pending: { key: "integrations.status.pending", tone: "neutral" },
  "needs-auth": { key: "integrations.status.needsAuth", tone: "orange" },
  failed: { key: "integrations.status.failed", tone: "red" },
  disabled: { key: "integrations.status.off", tone: "neutral" },
};

// A status Claude reported, or Pending for a name with none read yet. Pending
// carries a (?) that says why (Nil, 2026-10-13).
export function ClaudeStatus({ status }: { status: McpServerStatus | null }) {
  const { t } = useI18n();
  const shown = STATUS[status ?? "pending"];
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <Pill tone={shown.tone} data-claude-status={status ?? "pending"}>
        {t(shown.key)}
      </Pill>
      {(status ?? "pending") === "pending" && (
        <HelpTip text={t("integrations.connectors.pendingHelp")} />
      )}
    </span>
  );
}

// The claude.ai connectors of the Claude sign-in of one scope: a bullet list,
// the name in the body style and the status as a pill, so the two never look
// alike (Nil, 2026-10-13).
export function ConnectorList({ scope }: { scope: ConnectionScope }) {
  const { t, rich } = useI18n();
  const list = useMyConnections();
  const connectors = list?.claudeConnectors.find((c) => c.scope === scope);
  if (!connectors) return null;
  // A sign-in that really has none shows nothing.
  if (connectors.seenAt !== null && connectors.names.length === 0) return null;
  const account = list?.signIns.find(
    (signIn) => signIn.scope === scope && signIn.engine === "claude",
  )?.account;
  return (
    <div
      data-claude-connectors={scope}
      style={{
        borderTop: "1px solid var(--border-subtle)",
        padding: "10px 2px",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>
        {account
          ? t("integrations.connectors.title", { account })
          : t("integrations.connectors.titleNoAccount")}
      </div>
      {connectors.seenAt === null ? (
        <div
          data-connectors-unknown
          style={{ ...hintText, fontSize: 11.5, marginTop: 3 }}
        >
          {t("integrations.connectors.unknown")}
        </div>
      ) : (
        <>
          <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
            {connectors.names.map((name) => (
              <li
                key={name}
                data-claude-connector={name}
                style={{ fontSize: 12.5, margin: "3px 0" }}
              >
                {/* Account-authored names: rendered as text only. */}
                <span style={{ marginRight: 8 }}>{name}</span>
                <ClaudeStatus
                  status={
                    connectors.statuses?.find((entry) => entry.name === name)
                      ?.status ?? null
                  }
                />
              </li>
            ))}
          </ul>
          <div style={{ ...hintText, fontSize: 11.5 }}>
            {rich("integrations.connectors.hint", {
              link: (chunk) => (
                <a
                  data-connection-link="claude"
                  href={CLAUDE_CONNECTORS_URL}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent-text)" }}
                >
                  {chunk}
                </a>
              ),
            })}
          </div>
        </>
      )}
    </div>
  );
}

// The MCP servers set in Claude's own files, as the caller's own Claude
// sessions last reported them. Read-only: the page cannot open those files.
export function EngineMcpList() {
  const { t } = useI18n();
  const list = useMyConnections();
  const servers = list?.engineMcpServers ?? [];
  if (servers.length === 0) return null;
  return (
    <div data-engine-mcp-servers>
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "10px 2px 0",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-dim)",
        }}
      >
        {t("integrations.engineMcp.title")}
      </div>
      {servers.map((server) => (
        <ItemRow
          key={`${server.source}:${server.folder ?? ""}:${server.name}`}
          data-engine-mcp={server.name}
          // Names from the member's own files: rendered as text only.
          title={<span style={mono}>{server.name}</span>}
          detail={[
            server.source === "user"
              ? t("settings.connections.list.setInClaudeUser")
              : server.source === "local"
                ? t("settings.connections.list.setInClaudeLocal", {
                    folder: server.folder ?? "",
                  })
                : t("settings.connections.list.setInProject", {
                    file: `${server.folder ?? ""}/.mcp.json`,
                  }),
            server.folder !== null
              ? t("settings.connections.list.engineMcpFolder", {
                  folder: server.folder,
                })
              : t("settings.connections.list.engineMcpUser"),
          ].join(" · ")}
          status={<ClaudeStatus status={server.status ?? null} />}
        />
      ))}
    </div>
  );
}
