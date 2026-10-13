// The remote MCP servers of one card on the MCP servers tab (integrations
// loop, A2): Isomux gives them to Claude, Codex and OpenCode agents. A token
// is a secret of the same scope that lists the server's host: one pasted
// here, or one already saved. Sign in with the service runs the MCP
// authorization flow (A2b). Rows show the host only: the path of some hosted
// servers carries a token.

import { useEffect, useState } from "react";
import type {
  ConnectionScope,
  McpServerListRes,
  McpServerProblem,
  McpServerSignInRes,
  McpServerWire,
  SecretListRes,
  SecretWire,
} from "../../shared/contract-shapes.ts";
import { mcpServerHost, oauthSecretNames } from "../../shared/mcp-servers.ts";
import type { SecretForm } from "../../shared/secret-hosts.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import {
  notifyConnectionsChanged,
  onConnectionsChanged,
} from "../connections-events.ts";
import { ConnectionNoteField } from "../components/ConnectionNoteField.tsx";
import {
  AddRow,
  Btn,
  Choice,
  Empty,
  Field,
  FormButtons,
  ItemRow,
  Logo,
  NoteLine,
  Panel,
  Pill,
  errorText,
  hintText,
  input,
  mono,
  type Tone,
} from "./kit.tsx";
import {
  TestButton,
  TestResult,
  useConnectionTest,
} from "./ConnectionTest.tsx";
import {
  Confirm,
  HowSent,
  MoreOptions,
  useSecretErrorText,
} from "./SecretsSection.tsx";
import { useMyConnections } from "./my-connections.tsx";
import { rememberSignIn } from "./sign-in-return.ts";
import { useAlive } from "./use-alive.ts";
import {
  basePath,
  canEdit,
  isGone,
  summaryOnly,
  whose,
  type Role,
  type Target,
} from "./target.ts";
import type { Translator } from "../../shared/i18n/translate.ts";

// A row as the list shows it. A member reading the office's servers gets the
// name, the host and the note only.
type McpRow = {
  name: string;
  host: string;
  note: string | null;
  server?: McpServerWire;
};

type Mode =
  | { kind: "idle" }
  | { kind: "add" }
  | { kind: "edit"; name: string }
  | { kind: "remove"; name: string };

type Auth = "oauth" | "token" | "saved" | "none";

function rowsOf(result: unknown): McpRow[] | null {
  const servers = (result as Partial<McpServerListRes> | null)?.servers;
  if (!Array.isArray(servers)) return null;
  return servers
    .filter((server) => typeof server?.name === "string")
    .map((server) => {
      const full = server as Partial<McpServerWire> & { host?: unknown };
      const note =
        typeof full.note === "string" && full.note ? full.note : null;
      if (typeof full.url === "string")
        return {
          name: server.name,
          host: mcpServerHost(full.url),
          note,
          server,
        };
      return {
        name: server.name,
        host: typeof full.host === "string" ? full.host : "",
        note,
      };
    });
}

// Why a server is left out of agent sessions, from its own list and the
// secrets of its scope. The caller's connections list knows one more reason
// (sign_in_again), and the page prefers it where it has it.
function problemOf(
  server: McpServerWire,
  secrets: SecretWire[],
): McpServerProblem | null {
  if (server.oauth) return server.oauth.signedIn ? null : "sign_in";
  if (!server.secret) return null;
  const secret = secrets.find((s) => s.name === server.secret);
  if (!secret) return "secret_missing";
  return secret.hosts.includes(mcpServerHost(server.url))
    ? null
    : "secret_host";
}

function problemText(
  t: Translator["t"],
  problem: McpServerProblem,
  host: string,
): string {
  switch (problem) {
    case "secret_missing":
      return t("settings.connections.list.mcpSecretMissing");
    case "secret_host":
      return t("settings.connections.list.mcpSecretHost", { host });
    case "sign_in":
      return t("settings.connections.list.mcpSignIn");
    default:
      return t("settings.connections.list.mcpSignInAgain");
  }
}

// A sign-in failure: a fixed code from the server, never its own text.
export function signInErrorText(
  t: Translator["t"],
  reason: unknown,
  name: string | null,
): string {
  switch (reason) {
    case "client_needed":
      return t("settings.mcpServers.signInError.clientNeeded");
    case "redirect_refused":
      return t("settings.mcpServers.signInError.redirectRefused");
    case "discovery_failed":
    case "resource_mismatch":
    case "issuer_mismatch":
    case "insecure_endpoint":
      return t("settings.mcpServers.signInError.metadata");
    case "secret_exists":
      return name
        ? t("settings.mcpServers.signInError.secretExists", {
            name: oauthSecretNames(name).refreshToken,
          })
        : t("settings.secrets.error.exists");
    case "state_unknown":
    case "state_expired":
      return t("settings.mcpServers.signInError.expired");
    case "wrong_member":
      return t("settings.mcpServers.signInError.wrongMember");
    case "denied":
      return t("settings.mcpServers.signInError.denied");
  }
  return t("settings.mcpServers.signInFailed");
}

// The secret a pasted token is saved as: LINEAR_TOKEN for "linear".
export function tokenSecretName(server: string): string {
  const base = server.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!base.replace(/_/g, "")) return "";
  return /^[A-Z]/.test(base) ? `${base}_TOKEN` : `MCP_${base}_TOKEN`;
}

// An MCP server route's refusal, a fixed sentence per code. `host` is the
// server's host, for the secret that does not list it.
export function useMcpErrorText(host: string) {
  const { t } = useI18n();
  const secretError = useSecretErrorText();
  return (caught: unknown): string => {
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
        if (detail.field === "note")
          return t("settings.connections.error.note");
        return t("settings.mcpServers.saveFailed");
      case "invalid_secret":
        if (detail.field === "hosts") return t("settings.mcpServers.error.url");
        return secretError(caught);
      case "secret_exists":
      case "host_not_allowed":
        return secretError(caught);
    }
    return t("settings.mcpServers.saveFailed");
  };
}

function scopeOf(target: Target): ConnectionScope | null {
  return target.kind === "office"
    ? "office"
    : target.kind === "self"
      ? "personal"
      : null;
}

export function McpSection({
  target,
  role,
  onGone,
}: {
  target: Target;
  role: Role;
  // The member left the office while the card showed them.
  onGone?: () => void;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const base = basePath(target);
  const path = `${base}/mcp-servers`;
  const secretsPath = `${base}/secrets`;
  const editable = canEdit(target, role);
  const summary = summaryOnly(target, role);
  const mine = useMyConnections();
  const scope = scopeOf(target);
  const [rows, setRows] = useState<McpRow[] | null>(null);
  const [secrets, setSecrets] = useState<SecretWire[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([
      apiFetch<McpServerListRes>("GET", path),
      editable && !summary
        ? apiFetch<SecretListRes>("GET", secretsPath)
        : Promise.resolve({ secrets: [] }),
    ])
      .then(([serverList, secretList]) => {
        if (!alive.current) return;
        const next = rowsOf(serverList);
        // A server from before this list answers with another shape: show
        // the load failure, not a crash.
        if (next === null || !Array.isArray(secretList?.secrets)) {
          setLoadError(true);
          return;
        }
        setRows(next);
        setSecrets(secretList.secrets);
        setLoadError(false);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        setLoadError(true);
        if (isGone(caught, target)) onGone?.();
      });

  useEffect(() => {
    void load();
    // The section is keyed by its target; the paths never change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A secret added or removed on the Secrets tab changes the choices here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onConnectionsChanged(() => void load()), []);

  const close = () => {
    setMode({ kind: "idle" });
    setError(null);
  };
  const changed = async () => {
    close();
    await load();
    notifyConnectionsChanged();
  };

  // The browser goes to the authorization server and comes back to the page.
  async function signIn(name: string) {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await apiFetch<McpServerSignInRes>(
        "POST",
        `${path}/${encodeURIComponent(name)}/sign-in`,
      );
      rememberSignIn({ server: name, target });
      window.location.assign(authorizationUrl);
    } catch (caught) {
      if (!alive.current) return;
      setError(
        caught instanceof ApiError
          ? signInErrorText(t, caught.detail?.reason, name)
          : t("settings.mcpServers.signInFailed"),
      );
      setBusy(false);
    }
  }

  return (
    <div data-mcp-servers-path={path}>
      {loadError ? (
        <p role="alert" style={errorText}>
          {t("settings.mcpServers.loadFailed")}
        </p>
      ) : rows === null ? (
        <Empty>{t("common.loading")}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{t("integrations.mcp.empty")}</Empty>
      ) : (
        rows.map((row) => {
          const listed = scope
            ? mine?.mcpServers.find(
                (entry) => entry.scope === scope && entry.name === row.name,
              )
            : undefined;
          const problem = row.server
            ? listed
              ? listed.problem
              : problemOf(row.server, secrets)
            : null;
          return (
            <McpItem
              key={row.name}
              row={row}
              path={`${path}/${encodeURIComponent(row.name)}`}
              target={target}
              editable={editable && !summary && !!row.server}
              problem={problem}
              overridden={target.kind === "office" && !!listed?.overridden}
              busy={busy}
              mode={mode}
              setMode={(next) => {
                setError(null);
                setMode(next);
              }}
              onSignIn={() => void signIn(row.name)}
              secrets={secrets}
              secretsPath={secretsPath}
              onChanged={changed}
            />
          );
        })
      )}
      {editable &&
        !summary &&
        rows !== null &&
        !loadError &&
        (mode.kind === "add" ? (
          <McpEditor
            target={target}
            path={path}
            secretsPath={secretsPath}
            secrets={secrets}
            onCancel={close}
            onSaved={changed}
            onSignIn={(name) => void signIn(name)}
          />
        ) : (
          // One open form per card: a click elsewhere never drops a typed
          // token or client secret.
          mode.kind === "idle" && (
            <AddRow
              label={t("settings.mcpServers.add")}
              onClick={() => {
                setError(null);
                setMode({ kind: "add" });
              }}
            />
          )
        ))}
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </div>
  );
}

function statusOf(server: McpServerWire): { key: StatusKey; tone: Tone } {
  if (server.oauth)
    return server.oauth.signedIn
      ? { key: "integrations.mcp.status.signedIn", tone: "green" }
      : { key: "integrations.mcp.status.needsSignIn", tone: "orange" };
  if (server.secret)
    return { key: "integrations.mcp.status.token", tone: "green" };
  return { key: "integrations.mcp.status.none", tone: "neutral" };
}

type StatusKey =
  | "integrations.mcp.status.signedIn"
  | "integrations.mcp.status.needsSignIn"
  | "integrations.mcp.status.token"
  | "integrations.mcp.status.none";

function McpItem({
  row,
  path,
  target,
  editable,
  problem,
  overridden,
  busy,
  mode,
  setMode,
  onSignIn,
  secrets,
  secretsPath,
  onChanged,
}: {
  row: McpRow;
  path: string;
  target: Target;
  editable: boolean;
  problem: McpServerProblem | null;
  overridden: boolean;
  busy: boolean;
  mode: Mode;
  setMode: (mode: Mode) => void;
  onSignIn: () => void;
  secrets: SecretWire[];
  secretsPath: string;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const errorFor = useMcpErrorText(row.host);
  const { test, run } = useConnectionTest(path);
  const server = row.server;
  const status = server ? statusOf(server) : null;
  const here =
    (mode.kind === "edit" || mode.kind === "remove") && mode.name === row.name;
  const needsSignIn = !!server?.oauth && !server.oauth.signedIn;
  const credential = server
    ? server.oauth
      ? null
      : server.secret
        ? t("settings.connections.list.mcpCredentialNamed", {
            name: server.secret,
          })
        : null
    : null;
  return (
    <ItemRow
      data-mcp-server-name={row.name}
      logo={<Logo label={row.name} />}
      title={<span style={mono}>{row.name}</span>}
      detail={[row.host, credential].filter(Boolean).join(" · ")}
      status={status && <Pill tone={status.tone}>{t(status.key)}</Pill>}
      actions={
        editable && mode.kind === "idle" ? (
          <>
            {needsSignIn ? (
              <Btn
                small
                kind="primary"
                disabled={busy}
                onClick={onSignIn}
                data-mcp-sign-in
              >
                {t("settings.mcpServers.signIn")}
              </Btn>
            ) : (
              !problem && <TestButton test={test} run={() => void run()} />
            )}
            <Btn
              small
              onClick={() => setMode({ kind: "edit", name: row.name })}
              data-mcp-edit
            >
              {t("settings.secrets.edit")}
            </Btn>
            <Btn
              small
              kind="danger"
              onClick={() => setMode({ kind: "remove", name: row.name })}
              data-mcp-remove
            >
              {t("integrations.remove")}
            </Btn>
          </>
        ) : null
      }
    >
      <NoteLine note={row.note} />
      {problem && (
        <div data-mcp-problem={problem} style={errorText}>
          {problemText(t, problem, row.host)}
        </div>
      )}
      {overridden && (
        <div data-mcp-overridden style={{ ...hintText, marginTop: 4 }}>
          {t("settings.connections.list.mcpOverridden")}
        </div>
      )}
      <TestResult test={test} />
      {here && mode.kind === "edit" && server && (
        <McpEditor
          target={target}
          path={path.slice(0, path.lastIndexOf("/"))}
          secretsPath={secretsPath}
          secrets={secrets}
          editing={server}
          onCancel={() => setMode({ kind: "idle" })}
          onSaved={onChanged}
          onSignIn={onSignIn}
        />
      )}
      {here && mode.kind === "remove" && (
        <Confirm
          data-mcp-remove-panel=""
          heading={whose(t, "integrations.dialog.remove", target, {
            name: row.name,
          })}
          action={t("integrations.remove")}
          danger
          request={() => apiFetch("DELETE", path)}
          errorFor={errorFor}
          onCancel={() => setMode({ kind: "idle" })}
          onDone={onChanged}
        />
      )}
    </ItemRow>
  );
}

function McpEditor({
  target,
  path,
  secretsPath,
  secrets,
  editing,
  onCancel,
  onSaved,
  onSignIn,
}: {
  target: Target;
  // The list route, /api/.../mcp-servers.
  path: string;
  secretsPath: string;
  secrets: SecretWire[];
  editing?: McpServerWire;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onSignIn: (name: string) => void;
}) {
  const { t } = useI18n();
  const alive = useAlive();
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [auth, setAuth] = useState<Auth>(
    editing?.oauth ? "oauth" : editing?.secret ? "saved" : "none",
  );
  const [token, setToken] = useState("");
  const [tokenName, setTokenName] = useState<string | null>(null);
  const [form, setForm] = useState<SecretForm["kind"]>("authorization");
  const [header, setHeader] = useState("");
  const [saved, setSaved] = useState(editing?.secret ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = mcpServerHost(url.trim());
  const secretName = tokenName ?? tokenSecretName(name.trim());
  // Secrets that list the address's host; all of them while it has none. The
  // one the server uses now stays a choice even when it does not.
  const usable = secrets.filter((s) => !host || s.hosts.includes(host));
  const savedChoices =
    saved && !usable.some((s) => s.name === saved)
      ? [...usable.map((s) => s.name), saved]
      : usable.map((s) => s.name);

  const errorFor = useMcpErrorText(host);

  const ready =
    (editing || name.trim().length > 0) &&
    host.length > 0 &&
    (auth !== "token" || (token.trim().length > 0 && secretName.length > 0)) &&
    (auth !== "saved" || saved.length > 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // A pasted token is saved as a secret first. If the server then fails,
      // the secret stays on the Secrets tab, where it can be used or removed.
      let secret: string | null = null;
      if (auth === "token") {
        await apiFetch("POST", secretsPath, {
          name: secretName,
          value: token.trim(),
          hosts: [host],
          form:
            form === "header"
              ? { kind: "header", header: header.trim() }
              : { kind: "authorization" },
        });
        secret = secretName;
        if (alive.current) {
          setToken("");
          setAuth("saved");
          setSaved(secretName);
        }
      } else if (auth === "saved") secret = saved;
      const id = clientId.trim();
      const oauth = id
        ? {
            clientId: id,
            ...(clientSecret.trim()
              ? { clientSecret: clientSecret.trim() }
              : {}),
          }
        : {};
      if (!editing) {
        await apiFetch("POST", path, {
          name: name.trim(),
          url: url.trim(),
          secret,
          ...(auth === "oauth" ? { oauth } : {}),
          ...(note.trim() ? { note } : {}),
        });
      } else {
        await apiFetch("PATCH", `${path}/${encodeURIComponent(editing.name)}`, {
          url: url.trim(),
          secret,
          note,
          // The stored client stays unless a new one was typed.
          ...(auth === "oauth"
            ? editing.oauth && !id
              ? {}
              : { oauth }
            : editing.oauth
              ? { oauth: null }
              : {}),
        });
      }
      if (!alive.current) return;
      const signInNext =
        auth === "oauth" && (!editing?.oauth || !editing.oauth.signedIn);
      await onSaved();
      if (signInNext) onSignIn(editing?.name ?? name.trim());
    } catch (caught) {
      if (!alive.current) return;
      setError(errorFor(caught));
      // A secret made before the failure is listed now.
      notifyConnectionsChanged();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const authOptions: { value: Auth; label: string }[] = [
    { value: "oauth", label: t("integrations.mcp.authOauth") },
    { value: "token", label: t("integrations.mcp.authToken") },
    ...(savedChoices.length > 0
      ? [{ value: "saved" as const, label: t("integrations.mcp.authSaved") }]
      : []),
    { value: "none", label: t("integrations.mcp.authNone") },
  ];

  const heading = editing
    ? whose(t, "integrations.dialog.edit", target, { name: editing.name })
    : whose(t, "integrations.mcp.addHeading", target);

  return (
    <Panel
      heading={heading}
      {...(editing ? { "data-mcp-edit-panel": "" } : { "data-mcp-add": "" })}
    >
      {!editing && (
        <Field
          label={t("settings.mcpServers.name")}
          hint={t("integrations.mcp.nameHint")}
        >
          <input
            data-mcp-name
            style={{ ...input, ...mono }}
            value={name}
            spellCheck={false}
            autoComplete="off"
            placeholder="linear"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      <Field
        label={t("integrations.mcp.url")}
        hint={t("integrations.mcp.urlHint")}
      >
        <input
          data-mcp-url
          style={{ ...input, ...mono }}
          value={url}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://mcp.example.com/mcp"
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field label={t("integrations.mcp.auth")}>
        <Choice
          label={t("integrations.mcp.auth")}
          value={auth}
          onChange={setAuth}
          options={authOptions}
        />
      </Field>
      {auth === "token" && (
        <>
          <Field
            label={t("integrations.mcp.token")}
            hint={
              host
                ? t("integrations.mcp.tokenGoesTo", { host })
                : t("integrations.mcp.tokenNoHost")
            }
          >
            <input
              data-mcp-token
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              style={{ ...input, ...mono }}
              value={token}
              placeholder={t("settings.mcpServers.tokenPlaceholder")}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <MoreOptions>
            <Field
              label={t("integrations.mcp.tokenName")}
              hint={t("integrations.mcp.tokenNameHint")}
            >
              <input
                data-mcp-token-name
                style={{ ...input, ...mono }}
                value={secretName}
                spellCheck={false}
                autoComplete="off"
                placeholder="LINEAR_TOKEN"
                onChange={(e) => setTokenName(e.target.value)}
              />
            </Field>
            <HowSent
              form={form}
              header={header}
              onForm={setForm}
              onHeader={setHeader}
            />
          </MoreOptions>
        </>
      )}
      {auth === "saved" && (
        <Field label={t("integrations.mcp.savedSecret")}>
          <select
            data-mcp-credential
            style={{ ...input, ...mono }}
            value={saved}
            onChange={(e) => setSaved(e.target.value)}
          >
            <option value="" disabled>
              {t("integrations.mcp.pickSecret")}
            </option>
            {savedChoices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </Field>
      )}
      {auth === "oauth" && (
        <div data-mcp-oauth>
          <p style={{ ...hintText, margin: "8px 0 0" }}>
            {t("integrations.mcp.oauthHint")}
          </p>
          {editing?.oauth?.signedIn && (
            <div style={{ marginTop: 6 }}>
              <Btn
                kind="link"
                onClick={() => onSignIn(editing.name)}
                data-mcp-sign-in-again
              >
                {t("settings.mcpServers.signInAgain")}
              </Btn>
            </div>
          )}
          <MoreOptions>
            <p style={{ ...hintText, margin: "8px 0 0" }}>
              {t("integrations.mcp.clientHint")}
            </p>
            <Field label={t("settings.mcpServers.clientId")}>
              <input
                data-mcp-client-id
                style={{ ...input, ...mono }}
                value={clientId}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            <Field label={t("settings.mcpServers.clientSecret")}>
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                style={{ ...input, ...mono }}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </Field>
          </MoreOptions>
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <ConnectionNoteField value={note} onChange={setNote} />
      </div>
      <FormButtons
        ready={!!ready}
        busy={busy}
        saveLabel={
          auth === "oauth" && (!editing?.oauth || !editing.oauth.signedIn)
            ? t("integrations.mcp.saveAndSignIn")
            : t("common.save")
        }
        onCancel={onCancel}
        onSave={() => void save()}
      />
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </Panel>
  );
}
