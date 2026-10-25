// An agent's request for a secret, as an ask (server/secret-requests.ts):
// the member types the value in a masked field here, so it never enters the
// chat, and can edit the hosts. The server sends the ask only to the member
// who may answer it (the agent's manager, or an office owner for an office
// secret). A save or a decline closes it; the masked value lives in this
// component's state only.

import { useState } from "react";

import type { AskMemberWire, SecretAskRequest } from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useDispatch } from "../store.tsx";
import { timeSince } from "../../shared/i18n/time.ts";
import {
  dialogCancelBtn,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
} from "../components/dialog-styles.ts";
import { MaskedInput } from "../components/MaskedInput.tsx";
import { AskAboutButton } from "./AskAboutButton.tsx";

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
}: {
  entry: AskMemberWire;
  secret: SecretAskRequest;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const [hosts, setHosts] = useState(secret.hosts.join("\n"));
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const base = `/api/agents/${encodeURIComponent(entry.agentId)}/secret-requests/${encodeURIComponent(secret.requestId)}`;

  function errorText(caught: unknown, kind: "save" | "decline"): string {
    const failed =
      kind === "save"
        ? t("settings.secrets.saveFailed")
        : t("cards.secretRequest.declineFailed");
    if (!(caught instanceof ApiError)) return failed;
    const detail = caught.detail ?? {};
    if (caught.code === "forbidden") return t("cards.secretRequest.forbidden");
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

  async function answer(kind: "save" | "decline") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "save")
        await apiFetch("POST", `${base}/save`, {
          value: value.trim(),
          hosts: hosts
            .split(/[\s,]+/)
            .map((host) => host.trim())
            .filter(Boolean),
        });
      else await apiFetch("POST", `${base}/decline`);
      setValue("");
      dispatch({ type: "ask_removed", id: entry.id });
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
          {t("cards.secretRequest.title", { name: secret.name })}
        </div>
        <span
          style={{
            color: "var(--text-ghost)",
            fontSize: isMobile ? 12 : 11,
            flexShrink: 0,
          }}
        >
          {age}
        </span>
      </div>
      <p style={{ ...hintStyle, whiteSpace: "pre-wrap" }}>{secret.reason}</p>
      <div style={{ margin: "-4px 0 8px" }}>
        <AskAboutButton
          entry={entry}
          isMobile={isMobile}
          disabled={busy}
          onFocusAgent={onFocusAgent}
        />
      </div>
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
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={dialogLabel}>{t("settings.secrets.value")}</span>
        <MaskedInput
          value={value}
          placeholder={t("settings.secrets.valuePlaceholder")}
          style={dialogInput}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p style={hintStyle}>{t("cards.secretRequest.hint")}</p>
      {error && (
        <p role="alert" style={{ ...hintStyle, color: "var(--red-text)" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          style={dialogSaveBtn}
          disabled={busy || value.trim() === ""}
          onClick={() => void answer("save")}
        >
          {busy ? t("common.saving") : t("cards.secretRequest.save")}
        </button>
        <button
          type="button"
          style={dialogCancelBtn}
          disabled={busy}
          onClick={() => void answer("decline")}
        >
          {t("cards.secretRequest.decline")}
        </button>
      </div>
    </div>
  );
}
