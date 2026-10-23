// What Claude itself gives Claude agents, on the MCP servers tab: the
// claude.ai connectors of a Claude sign-in, and the MCP servers set in
// Claude's own files. Both come from the caller's connections list, so the
// page shows them on the office card and under "You" only (ruling 3).
//
// Claude's own files, by where they apply (Lead, 2026-10-13): a folder's
// .mcp.json belongs to the folder, so it shows on the office card; user and
// local settings live in the Claude config directory of a sign-in, so they
// show on that sign-in's card. A server from a directory neither sign-in
// uses now is left out.

import type {
  ConnectionScope,
  McpServerStatus,
} from "../../shared/contract-shapes.ts";
import { CLAUDE_CONNECTORS_URL } from "../connection-rows.ts";
import { useI18n } from "../i18n.tsx";
import {
  Data,
  HelpTip,
  ItemRow,
  Pill,
  hintText,
  mono,
  type Tone,
} from "./kit.tsx";
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
// The tool count shows with Connected only (Lead, 2026-10-13).
function ClaudeStatus({
  status,
  tools,
}: {
  status: McpServerStatus | null;
  tools?: number;
}) {
  const { t, tn } = useI18n();
  const shown = STATUS[status ?? "pending"];
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <Pill tone={shown.tone} data-claude-status={status ?? "pending"}>
        {t(shown.key)}
      </Pill>
      {status === "connected" && tools !== undefined && (
        <span
          data-claude-tools={String(tools)}
          style={{ ...hintText, fontSize: 11.5, marginLeft: 6 }}
        >
          {tn("settings.connections.test.tools", tools)}
        </span>
      )}
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
          ? rich("integrations.connectors.title", {
              account: <Data>{account}</Data>,
            })
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
                  tools={
                    connectors.statuses?.find((entry) => entry.name === name)
                      ?.tools
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

// The MCP servers set in Claude's own files that apply on one card, as the
// caller's own Claude sessions last reported them. Read-only: the page cannot
// open those files.
export function EngineMcpList({ scope }: { scope: ConnectionScope }) {
  const { t, rich } = useI18n();
  const list = useMyConnections();
  const servers = (list?.engineMcpServers ?? []).filter((server) =>
    server.source === "project" ? scope === "office" : server.signIn === scope,
  );
  if (servers.length === 0) return null;
  return (
    <div data-engine-mcp-servers={scope}>
      {/* Title and subtitle on one line, the subtitle under it when it
          does not fit. */}
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "10px 2px 0",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          columnGap: 10,
          rowGap: 2,
        }}
      >
        <div
          style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}
        >
          {t("integrations.engineMcp.title")}
        </div>
        <div style={{ ...hintText, fontSize: 11.5 }}>
          {t("integrations.engineMcp.source")}
        </div>
      </div>
      {servers.map((server) => (
        <ItemRow
          key={`${server.source}:${server.folder ?? ""}:${server.name}`}
          data-engine-mcp={server.name}
          data-engine-mcp-source={server.source}
          // Names from the member's own files: rendered as text only.
          title={<span style={mono}>{server.name}</span>}
          detail={
            server.source === "user" ? (
              <>
                {t("settings.connections.list.setInClaudeUser")}
                {" · "}
                {t("settings.connections.list.engineMcpUser")}
              </>
            ) : server.source === "local" ? (
              rich("settings.connections.list.setInClaudeLocal", {
                folder: <Data>{server.folder ?? ""}</Data>,
              })
            ) : (
              rich("settings.connections.list.setInProject", {
                file: <Data>{`${server.folder ?? ""}/.mcp.json`}</Data>,
              })
            )
          }
          status={
            <ClaudeStatus status={server.status ?? null} tools={server.tools} />
          }
        />
      ))}
    </div>
  );
}
