import { useEffect, useState } from "react";

import type {
  McpServerListRes,
  McpServerWire,
  SecretListRes,
  SecretWire,
} from "../../shared/contract-shapes.ts";
import { mcpServerHost } from "../../shared/mcp-servers.ts";
import type { SecretForm } from "../../shared/secret-hosts.ts";
import { apiFetch, ApiError } from "../api.ts";
import { cardStyle, hint } from "./access-shared.tsx";
import {
  dialogCancelBtn,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import {
  notifyConnectionsChanged,
  onConnectionsChanged,
} from "../connections-events.ts";

// The remote MCP servers Isomux gives Claude, Codex and OpenCode agents
// (integrations loop, A2), next to the Secrets list on both halves of the
// connections settings. A credential is a secret of the same scope that lists
// the server's host: an existing one, or a new one made here. This list is the
// only place that shows a server's whole URL.

type Mode =
  | { kind: "idle" }
  | { kind: "add" }
  | { kind: "edit"; name: string }
  | { kind: "delete"; name: string };

// "" = no credential, NEW_SECRET = a new secret from the fields below,
// anything else = the name of an existing secret.
const NEW_SECRET = "\u0000new";

interface Draft {
  name: string;
  url: string;
  credential: string;
  secretName: string;
  value: string;
  formKind: SecretForm["kind"];
  header: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  url: "",
  credential: "",
  secretName: "",
  value: "",
  formKind: "authorization",
  header: "",
};

interface McpServersListProps {
  // /api/office/mcp-servers or /api/users/<name>/mcp-servers.
  path: string;
  // The Secrets path of the same scope.
  secretsPath: string;
  // False for a member on the office half: office servers are owner-only.
  canEdit: boolean;
}

// One instance per scope, as SecretsList: nothing typed carries over.
export function McpServersList(props: McpServersListProps) {
  return <ScopeMcpServers key={props.path} {...props} />;
}

function ScopeMcpServers({ path, secretsPath, canEdit }: McpServersListProps) {
  const { t, rich } = useI18n();
  const [servers, setServers] = useState<McpServerWire[] | null>(null);
  const [secrets, setSecrets] = useState<SecretWire[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      apiFetch<McpServerListRes>("GET", path),
      apiFetch<SecretListRes>("GET", secretsPath),
    ])
      .then(([serverList, secretList]) => {
        // A server from before this list (the UI built before a restart)
        // answers with another shape: show the load failure, not a crash.
        if (
          !Array.isArray(serverList?.servers) ||
          !Array.isArray(secretList?.secrets)
        ) {
          setError(t("settings.mcpServers.loadFailed"));
          return;
        }
        setServers(serverList.servers);
        setSecrets(secretList.secrets);
      })
      .catch(() => setError(t("settings.mcpServers.loadFailed")));

  useEffect(() => {
    if (canEdit) void load();
    // The path is the complete identity of this scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canEdit]);

  // A secret added or deleted in the Secrets list changes the choices here.
  useEffect(
    () =>
      onConnectionsChanged(() => {
        if (canEdit) void load();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, canEdit],
  );

  function open(next: Mode, from?: McpServerWire) {
    setError(null);
    setMode(next);
    setDraft(
      from
        ? {
            ...EMPTY_DRAFT,
            name: from.name,
            url: from.url,
            credential: from.secret ?? "",
          }
        : EMPTY_DRAFT,
    );
  }

  function close() {
    setMode({ kind: "idle" });
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  const host = mcpServerHost(draft.url.trim());

  function errorText(caught: unknown): string {
    if (!(caught instanceof ApiError))
      return t("settings.mcpServers.saveFailed");
    const detail = caught.detail ?? {};
    switch (caught.code) {
      case "mcp_server_exists":
        return t("settings.mcpServers.error.exists");
      case "secret_not_found":
        return t("settings.mcpServers.error.secretNotFound");
      case "secret_host_mismatch":
        return t("settings.mcpServers.error.secretHost", { host });
      case "invalid_mcp_server":
        if (detail.field === "name") return t("settings.mcpServers.error.name");
        if (detail.field === "url") return t("settings.mcpServers.error.url");
        return t("settings.mcpServers.saveFailed");
      // The new secret's own checks (SecretsList has the same texts).
      case "secret_exists":
        return t("settings.secrets.error.exists");
      case "host_not_allowed":
        return t("settings.secrets.error.neverListed", {
          host: typeof detail.host === "string" ? detail.host : "",
        });
      case "invalid_secret":
        if (detail.field === "name")
          return detail.reason === "reserved"
            ? t("settings.secrets.error.reservedName")
            : t("settings.secrets.error.name");
        if (detail.field === "value") return t("settings.secrets.error.value");
        if (detail.field === "hosts") return t("settings.mcpServers.error.url");
        if (detail.field === "form") return t("settings.secrets.error.header");
        return t("settings.secrets.saveFailed");
    }
    return t("settings.mcpServers.saveFailed");
  }

  // A new secret first, then the server. If the server fails, the secret
  // stays in the Secrets list, where the member can use or delete it.
  async function secretForDraft(): Promise<string | null> {
    if (draft.credential === "") return null;
    if (draft.credential !== NEW_SECRET) return draft.credential;
    const name = draft.secretName.trim();
    await apiFetch("POST", secretsPath, {
      name,
      value: draft.value.trim(),
      hosts: [host],
      form:
        draft.formKind === "header"
          ? { kind: "header", header: draft.header.trim() }
          : { kind: "authorization" },
    });
    setDraft((d) => ({ ...d, credential: name, value: "" }));
    return name;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === "delete") {
        await apiFetch("DELETE", `${path}/${encodeURIComponent(mode.name)}`);
      } else {
        const secret = await secretForDraft();
        if (mode.kind === "add")
          await apiFetch("POST", path, {
            name: draft.name.trim(),
            url: draft.url.trim(),
            secret,
          });
        else if (mode.kind === "edit")
          await apiFetch("PATCH", `${path}/${encodeURIComponent(mode.name)}`, {
            url: draft.url.trim(),
            secret,
          });
      }
      close();
      await load();
      notifyConnectionsChanged();
    } catch (caught) {
      setError(errorText(caught));
      // A secret made before the failure is listed now.
      notifyConnectionsChanged();
    } finally {
      setBusy(false);
    }
  }

  // Secrets that list the URL's host; all of them while the URL has none.
  const usable = secrets.filter(
    (secret) => !host || secret.hosts.includes(host),
  );

  const credentialFields = (
    <>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={dialogLabel}>{t("settings.mcpServers.credential")}</span>
        <select
          data-mcp-credential
          value={draft.credential}
          style={dialogInput}
          onChange={(event) =>
            setDraft((d) => ({ ...d, credential: event.target.value }))
          }
        >
          <option value="">{t("settings.mcpServers.credentialNone")}</option>
          {usable.map((secret) => (
            <option key={secret.name} value={secret.name}>
              {secret.name}
            </option>
          ))}
          {draft.credential &&
            draft.credential !== NEW_SECRET &&
            !usable.some((secret) => secret.name === draft.credential) && (
              <option value={draft.credential}>{draft.credential}</option>
            )}
          <option value={NEW_SECRET}>
            {t("settings.mcpServers.credentialNew")}
          </option>
        </select>
      </label>
      {draft.credential === NEW_SECRET && (
        <div data-mcp-new-secret>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>
              {t("settings.mcpServers.secretName")}
            </span>
            <input
              value={draft.secretName}
              placeholder="LINEAR_TOKEN"
              spellCheck={false}
              autoComplete="off"
              style={dialogInput}
              onChange={(event) =>
                setDraft((d) => ({ ...d, secretName: event.target.value }))
              }
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>{t("settings.secrets.value")}</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft.value}
              placeholder={t("settings.mcpServers.tokenPlaceholder")}
              style={dialogInput}
              onChange={(event) =>
                setDraft((d) => ({ ...d, value: event.target.value }))
              }
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>{t("settings.secrets.form")}</span>
            <select
              value={draft.formKind}
              style={dialogInput}
              onChange={(event) =>
                setDraft((d) => ({
                  ...d,
                  formKind: event.target.value as SecretForm["kind"],
                }))
              }
            >
              <option value="authorization">
                {t("settings.mcpServers.formBearer")}
              </option>
              <option value="header">{t("settings.secrets.formHeader")}</option>
            </select>
          </label>
          {draft.formKind === "header" && (
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={dialogLabel}>
                {t("settings.secrets.headerName")}
              </span>
              <input
                value={draft.header}
                placeholder="x-api-key"
                spellCheck={false}
                style={dialogInput}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, header: event.target.value }))
                }
              />
            </label>
          )}
          <p style={{ ...hint, margin: "0 0 8px" }}>
            {host
              ? t("settings.mcpServers.newSecretHost", { host })
              : t("settings.mcpServers.newSecretNoHost")}{" "}
            {t("settings.secrets.vouch")}
          </p>
        </div>
      )}
    </>
  );

  const urlField = (
    <>
      <label style={{ display: "block", marginBottom: 4 }}>
        <span style={dialogLabel}>{t("settings.mcpServers.url")}</span>
        <input
          value={draft.url}
          placeholder="https://mcp.example.com/mcp"
          spellCheck={false}
          autoComplete="off"
          style={dialogInput}
          onChange={(event) =>
            setDraft((d) => ({ ...d, url: event.target.value }))
          }
        />
      </label>
      <p style={{ ...hint, margin: "0 0 8px" }}>
        {t("settings.mcpServers.urlNote")}
      </p>
    </>
  );

  const actions = (saveLabel: string) => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button
        type="button"
        style={dialogSaveBtn}
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? t("common.saving") : saveLabel}
      </button>
      <button
        type="button"
        style={dialogCancelBtn}
        disabled={busy}
        onClick={close}
      >
        {t("common.cancel")}
      </button>
    </div>
  );

  return (
    <section
      data-mcp-servers-path={path}
      style={{ ...cardStyle, marginTop: 14 }}
    >
      <h5 style={{ margin: "0 0 8px" }}>{t("settings.mcpServers.title")}</h5>
      {!canEdit ? (
        <p style={{ ...hint, margin: 0 }}>
          {t("settings.mcpServers.ownerManaged")}
        </p>
      ) : (
        <>
          <p style={{ ...hint, margin: "0 0 10px" }}>
            {rich("settings.mcpServers.hint", {
              code: (chunk) => <code>{chunk}</code>,
            })}
          </p>
          {servers === null && !error && (
            <p style={hint}>{t("common.loading")}</p>
          )}
          {servers?.length === 0 && mode.kind !== "add" && (
            <p style={hint}>{t("settings.mcpServers.empty")}</p>
          )}
          {servers?.map((server) => (
            <div
              key={server.name}
              data-mcp-server-name={server.name}
              style={{
                borderTop: "1px solid var(--border)",
                padding: "8px 0",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <code style={{ fontWeight: 650 }}>{server.name}</code>
                  <div style={hint}>{server.url}</div>
                  <div style={hint}>
                    {server.secret
                      ? t("settings.connections.list.mcpCredentialNamed", {
                          name: server.secret,
                        })
                      : t("settings.connections.list.mcpNoCredential")}
                  </div>
                </div>
                {mode.kind === "idle" && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={dialogCancelBtn}
                      onClick={() =>
                        open({ kind: "edit", name: server.name }, server)
                      }
                    >
                      {t("settings.secrets.edit")}
                    </button>
                    <button
                      type="button"
                      style={dialogCancelBtn}
                      onClick={() =>
                        open({ kind: "delete", name: server.name })
                      }
                    >
                      {t("settings.secrets.delete")}
                    </button>
                  </div>
                )}
              </div>
              {mode.kind === "edit" && mode.name === server.name && (
                <div style={{ marginTop: 8 }}>
                  {urlField}
                  {credentialFields}
                  {actions(t("common.save"))}
                </div>
              )}
              {mode.kind === "delete" && mode.name === server.name && (
                <div style={{ marginTop: 8 }}>
                  <p style={{ ...hint, margin: "0 0 8px" }}>
                    {t("settings.secrets.deleteConfirm", { name: server.name })}
                  </p>
                  {actions(t("settings.secrets.delete"))}
                </div>
              )}
            </div>
          ))}
          {mode.kind === "add" ? (
            <div
              data-mcp-add
              style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}
            >
              <label style={{ display: "block", marginBottom: 8 }}>
                <span style={dialogLabel}>{t("settings.mcpServers.name")}</span>
                <input
                  value={draft.name}
                  placeholder="linear"
                  spellCheck={false}
                  autoComplete="off"
                  style={dialogInput}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, name: event.target.value }))
                  }
                />
              </label>
              {urlField}
              {credentialFields}
              {actions(t("common.save"))}
            </div>
          ) : (
            mode.kind === "idle" && (
              <button
                type="button"
                style={{ ...dialogCancelBtn, marginTop: 6 }}
                onClick={() => open({ kind: "add" })}
              >
                {t("settings.mcpServers.add")}
              </button>
            )
          )}
          {error && (
            <p role="alert" style={{ color: "var(--red-text)", fontSize: 12 }}>
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
