// An agent's request for a value, as an ask (server/secret-requests.ts): a
// secret, a variable or an MCP server (task c71cb60f), or a Discord bot
// token (task c92d60f4), whose save connects the bot. For a secret the
// member types the value in a masked field here, so it never enters the
// chat, and can edit the hosts. A request for an app has no hosts: the app
// reads the value from its environment. A variable's field is masked when
// its name is a key. For an MCP server the member sets the URL and the
// sign-in: OAuth, a secret of the target scope, or none; an OAuth save then
// starts the sign-in, as the Integrations page does. The server sends the ask only to the
// member who may answer it (the agent's manager or the member the request
// names, or an office owner for an office request). A save or a decline
// closes it; the typed value lives in this component's state only.

import { useEffect, useState } from "react";

import {
  knownValueRequest,
  type AskMemberWire,
  type SecretAskRequest,
} from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n, type UiTranslator } from "../i18n.tsx";
import { useAppState, useDispatch } from "../store.tsx";
import { isModelKeySecretName } from "../../shared/secret-hosts.ts";
import { mcpServerHost } from "../../shared/mcp-servers.ts";
import { looksLikeKey } from "../integrations/VariablesSection.tsx";
import { useMcpErrorText } from "../integrations/McpSection.tsx";
import {
  DISCORD_CONNECT_ERROR,
  DiscordAppSteps,
  DiscordSteps,
  InviteLink,
} from "../integrations/DiscordSection.tsx";
import { DISCORD_BOTS_MAX } from "../../shared/discord.ts";
import { Choice } from "../integrations/kit.tsx";
import { startMcpSignIn } from "../integrations/sign-in-return.ts";
import type { Target } from "../integrations/target.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import {
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  filledSecondaryBtn,
} from "../components/dialog-styles.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";
import { AskAboutButton } from "./AskAboutButton.tsx";
import { AskIdChip } from "./AskIdChip.tsx";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { noTranslate } from "../no-translate.ts";
import { outsideLinkFor } from "../../shared/office-links.ts";
import { OutsideLinkButton } from "./OutsideLink.tsx";

// The card's title, which the collapsed stack shows too.
export function valueAskTitle(
  t: UiTranslator["t"],
  secret: SecretAskRequest,
): string {
  const { name } = secret;
  if (!knownValueRequest(secret))
    return t("cards.secretRequest.unsupportedTitle", { name });
  if (secret.kind === "variable")
    return t("cards.secretRequest.variableTitle", { name });
  if (secret.kind === "mcp-server")
    return t("cards.secretRequest.mcpServerTitle", { name });
  if (secret.kind === "discord-bot")
    return t("cards.secretRequest.discordBotTitle");
  return t("cards.secretRequest.title", { name });
}

const hintStyle = {
  fontSize: 12,
  color: "var(--text-secondary)",
  margin: "0 0 8px",
} as const;

export function SecretAskCard({
  entry,
  secret,
  isMobile,
  onFocusAgent,
  onChatAgent,
}: {
  entry: AskMemberWire;
  secret: SecretAskRequest;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
  onChatAgent?: (agentId: string) => void;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const { users, sessionContext } = useAppState();
  const [hosts, setHosts] = useState(secret.hosts.join("\n"));
  const [value, setValue] = useState("");
  const [url, setUrl] = useState(
    secret.kind === "mcp-server" ? (secret.url ?? "") : "",
  );
  const [picked, setPicked] = useState(
    secret.kind === "mcp-server" ? (secret.secret ?? "") : "",
  );
  // An MCP server's sign-in, from the agent's proposal.
  const [auth, setAuth] = useState<"oauth" | "saved" | "none">(
    secret.kind !== "mcp-server"
      ? "none"
      : secret.oauth
        ? "oauth"
        : secret.secret
          ? "saved"
          : "none",
  );
  // The target scope's secrets, for an MCP server's credential choice.
  const [choices, setChoices] = useState<{ name: string; hosts: string[] }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const app = secret.kind === undefined ? secret.app?.name : undefined;
  const host = mcpServerHost(url.trim());
  const mcpErrorText = useMcpErrorText(host);
  // The member whose connections get the value: the owner, else (an older
  // request) the member it is for.
  const ownerId = secret.ownerUserId ?? entry.memberUserId;
  // The users map is keyed by lowercase name.
  const ownerName = ownerId
    ? [...users.values()].find((user) => user.id === ownerId)?.name
    : undefined;
  const secretsPath =
    secret.scope === "office"
      ? "/api/office/secrets"
      : ownerName
        ? `/api/users/${encodeURIComponent(ownerName)}/secrets`
        : null;
  // Whose MCP servers, for the sign-in after an OAuth save.
  const target: Target | null =
    secret.scope === "office"
      ? { kind: "office" }
      : ownerName
        ? {
            kind: ownerId === sessionContext?.userId ? "self" : "member",
            username: ownerName,
          }
        : null;
  const isMcp = secret.kind === "mcp-server";
  // Secrets that list the URL's host (all of them while it has none), as on
  // the Integrations page. The proposed one stays a choice.
  const usable = choices
    .filter((choice) => !host || choice.hosts.includes(host))
    .map((choice) => choice.name);
  const secretChoices = [...new Set([...usable, ...(picked ? [picked] : [])])];
  const known = knownValueRequest(secret);
  useEffect(() => {
    if (!isMcp || !secretsPath) return;
    let alive = true;
    apiFetch<{ secrets?: { name: string; hosts: string[] }[] }>(
      "GET",
      secretsPath,
    )
      .then((result) => {
        if (alive)
          setChoices(
            (result?.secrets ?? []).map(({ name, hosts }) => ({
              name,
              hosts,
            })),
          );
      })
      // No list: the member can still save with no secret.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isMcp, secretsPath]);

  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const base = `/api/agents/${encodeURIComponent(entry.agentId)}/secret-requests/${encodeURIComponent(secret.requestId)}`;

  function errorText(caught: unknown, kind: "save" | "decline"): string {
    if (kind === "save" && secret.kind === "mcp-server")
      return mcpErrorText(caught);
    if (kind === "save" && secret.kind === "discord-bot") {
      if (!(caught instanceof ApiError))
        return t("settings.secrets.saveFailed");
      if (caught.code === "forbidden")
        return t("cards.secretRequest.forbidden");
      if (caught.code === "bots_max")
        return t("integrations.discord.error.botsMax", {
          max: DISCORD_BOTS_MAX,
        });
      const key = DISCORD_CONNECT_ERROR[caught.code];
      return key ? t(key) : t("settings.secrets.saveFailed");
    }
    if (kind === "save" && secret.kind === "variable")
      return caught instanceof ApiError && caught.code === "variable_exists"
        ? t("integrations.variables.exists")
        : caught instanceof ApiError && caught.code === "forbidden"
          ? t("cards.secretRequest.forbidden")
          : t("settings.env.saveFailed");
    const failed =
      kind === "save"
        ? t("settings.secrets.saveFailed")
        : t("cards.secretRequest.declineFailed");
    if (!(caught instanceof ApiError)) return failed;
    const detail = caught.detail ?? {};
    if (caught.code === "forbidden") return t("cards.secretRequest.forbidden");
    if (caught.code === "app_gone") return t("cards.secretRequest.appGone");
    if (caught.code === "host_not_allowed")
      return t("settings.secrets.error.neverListed", {
        host: typeof detail.host === "string" ? detail.host : "",
      });
    if (caught.code === "secret_exists")
      return t("settings.secrets.error.exists");
    if (caught.code === "invalid_secret") {
      if (detail.field === "value") return t("settings.secrets.error.value");
      if (detail.field === "hosts") return t("settings.secrets.error.hosts");
    }
    return failed;
  }

  function saveBody(): Record<string, unknown> {
    if (secret.kind === "variable" || secret.kind === "discord-bot")
      return { value: value.trim() };
    if (secret.kind === "mcp-server")
      return auth === "oauth"
        ? { url: url.trim(), secret: null, oauth: true }
        : {
            url: url.trim(),
            secret: auth === "saved" && picked !== "" ? picked : null,
          };
    return {
      value: value.trim(),
      ...(app
        ? {}
        : {
            hosts: hosts
              .split(/[\s,]+/)
              .map((host) => host.trim())
              .filter(Boolean),
          }),
    };
  }

  async function answer(kind: "save" | "decline") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "save") await apiFetch("POST", `${base}/save`, saveBody());
      else await apiFetch("POST", `${base}/decline`);
      setValue("");
      dispatch({ type: "ask_removed", id: entry.id });
      // The save closed the ask, so the card can be gone by now: nothing
      // here waits on it. A sign-in that does not start leaves the server
      // signed out, and its Integrations row offers the sign-in.
      if (kind === "save" && isMcp && auth === "oauth" && target)
        startMcpSignIn(target, secret.name).catch(() => {});
    } catch (caught) {
      // 404: the request closed elsewhere (another owner, the agent's
      // withdraw); the push removes it too.
      if (caught instanceof ApiError && caught.status === 404) {
        setValue("");
        dispatch({ type: "ask_removed", id: entry.id });
        return;
      }
      setError(errorText(caught, kind));
      setBusy(false);
    }
  }

  const form =
    secret.form.kind === "header"
      ? t("settings.secrets.formHeaderNamed", { header: secret.form.header })
      : t("settings.secrets.formAuthorization");
  const fontSize = isMobile ? 14 : 13;

  return (
    <div
      data-ask={entry.id}
      data-secret-request={secret.requestId}
      style={{
        padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-light)",
        borderLeft: "3px solid var(--orange)",
        marginBottom: 6,
        fontFamily: "var(--font-ui)",
        fontSize,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 650,
            color: "var(--text-primary)",
            marginBottom: 4,
            overflowWrap: "break-word",
          }}
        >
          {valueAskTitle(t, secret)}
        </div>
        {!isMobile && <AskIdChip id={entry.id} isMobile={isMobile} />}
        {/* On mobile the id goes under the age, so the title keeps its
            width. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          <span
            style={{ color: "var(--text-ghost)", fontSize: isMobile ? 12 : 11 }}
          >
            {age}
          </span>
          {isMobile && <AskIdChip id={entry.id} isMobile={isMobile} />}
        </div>
      </div>
      <p style={hintStyle} {...noTranslate()}>
        <InlineMarkdown content={secret.reason} code colors />
      </p>
      {outsideLinkFor(secret.link) && (
        <div style={{ margin: "0 0 8px" }}>
          <OutsideLinkButton link={secret.link} isMobile={isMobile} />
        </div>
      )}
      {!known ? (
        // A kind from a later release: only the decline is offered here.
        <p style={hintStyle}>{t("cards.secretRequest.unsupported")}</p>
      ) : secret.kind === "variable" ? (
        <>
          <p style={hintStyle}>
            {secret.scope === "office"
              ? t("cards.secretRequest.variableOffice")
              : t("cards.secretRequest.variablePersonal")}
          </p>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>{t("settings.secrets.value")}</span>
            {isModelKeySecretName(secret.name) || looksLikeKey(secret.name) ? (
              <MaskedInput
                value={value}
                placeholder={t("settings.secrets.valuePlaceholder")}
                style={dialogInput}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <input
                type="text"
                value={value}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                style={dialogInput}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
          <p style={hintStyle}>{t("cards.secretRequest.variableHint")}</p>
        </>
      ) : secret.kind === "discord-bot" ? (
        <>
          <p style={hintStyle}>
            {secret.applicationId ? (
              <DiscordAppSteps applicationId={secret.applicationId} />
            ) : (
              <DiscordSteps />
            )}
          </p>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>{t("integrations.discord.token")}</span>
            <MaskedInput
              value={value}
              style={dialogInput}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <p style={hintStyle}>{t("cards.secretRequest.discordBotHint")}</p>
          {secret.applicationId && (
            // The member can add the bot before the save closes the card.
            <div style={{ margin: "0 0 8px" }}>
              <InviteLink botId={secret.applicationId} />
            </div>
          )}
        </>
      ) : secret.kind === "mcp-server" ? (
        <>
          <p style={hintStyle}>
            {secret.scope === "office"
              ? t("cards.secretRequest.mcpServerOffice")
              : t("cards.secretRequest.mcpServerPersonal")}
          </p>
          <label style={{ display: "block", marginBottom: 4 }}>
            <span style={dialogLabel}>{t("integrations.mcp.url")}</span>
            <input
              type="text"
              value={url}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              placeholder="https://mcp.example.com/mcp"
              style={{ ...dialogInput, fontFamily: "monospace" }}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <div style={{ marginBottom: 8 }}>
            <span style={dialogLabel}>{t("integrations.mcp.auth")}</span>
            <Choice
              label={t("integrations.mcp.auth")}
              value={auth}
              onChange={setAuth}
              options={[
                { value: "oauth", label: t("integrations.mcp.authOauth") },
                ...(secretChoices.length > 0
                  ? [
                      {
                        value: "saved" as const,
                        label: t("integrations.mcp.authSaved"),
                      },
                    ]
                  : []),
                { value: "none", label: t("integrations.mcp.authNone") },
              ]}
            />
          </div>
          {auth === "oauth" && (
            <p style={hintStyle}>{t("integrations.mcp.oauthHint")}</p>
          )}
          {auth === "saved" && (
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={dialogLabel}>
                {t("integrations.mcp.savedSecret")}
              </span>
              <select
                value={picked}
                disabled={busy}
                style={{ ...dialogInput, fontFamily: "monospace" }}
                onChange={(event) => setPicked(event.target.value)}
              >
                <option value="" disabled>
                  {t("integrations.mcp.pickSecret")}
                </option>
                {secretChoices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <span style={{ ...hintStyle, display: "block", marginTop: 4 }}>
                {t("cards.secretRequest.mcpServerSecretHint")}
              </span>
            </label>
          )}
          <p style={hintStyle}>{t("cards.secretRequest.mcpServerHint")}</p>
        </>
      ) : (
        <>
          {app ? (
            <p style={hintStyle}>
              {secret.scope === "office"
                ? t("cards.secretRequest.appOffice", { app })
                : t("cards.secretRequest.app", { app })}
            </p>
          ) : (
            <>
              <p style={hintStyle}>
                {secret.scope === "office"
                  ? t("cards.secretRequest.office")
                  : t("cards.secretRequest.personal")}{" "}
                {form}
              </p>
              <label style={{ display: "block", marginBottom: 4 }}>
                <span style={dialogLabel}>{t("settings.secrets.hosts")}</span>
                <textarea
                  rows={Math.min(4, Math.max(2, secret.hosts.length))}
                  spellCheck={false}
                  value={hosts}
                  disabled={busy}
                  style={{
                    ...dialogInput,
                    fontFamily: "monospace",
                    resize: "vertical",
                  }}
                  onChange={(event) => setHosts(event.target.value)}
                />
              </label>
              <p style={hintStyle}>{t("settings.secrets.vouch")}</p>
            </>
          )}
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={dialogLabel}>{t("settings.secrets.value")}</span>
            <MaskedInput
              value={value}
              placeholder={t("settings.secrets.valuePlaceholder")}
              style={dialogInput}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <p style={hintStyle}>
            {t(
              app ? "cards.secretRequest.appHint" : "cards.secretRequest.hint",
            )}
          </p>
        </>
      )}
      {error && (
        <p role="alert" style={{ ...hintStyle, color: "var(--red-text)" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {known && (
          <button
            type="button"
            style={dialogSaveBtn}
            disabled={
              busy ||
              (isMcp
                ? url.trim() === "" || (auth === "saved" && picked === "")
                : value.trim() === "")
            }
            onClick={() => void answer("save")}
          >
            {busy
              ? t("common.saving")
              : isMcp && auth === "oauth" && target
                ? t("integrations.mcp.saveAndSignIn")
                : t("cards.secretRequest.save")}
          </button>
        )}
        <button
          type="button"
          style={filledSecondaryBtn}
          disabled={busy}
          onClick={() => void answer("decline")}
        >
          {t("cards.secretRequest.decline")}
        </button>
        <AskAboutButton
          entry={entry}
          style={filledSecondaryBtn}
          disabled={busy}
          onFocusAgent={onFocusAgent}
          onChatAgent={onChatAgent}
        />
      </div>
    </div>
  );
}
