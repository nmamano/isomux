import { createContext, useContext, useState } from "react";

import type { SecretRequestPayload } from "../../shared/types.ts";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import {
  dialogCancelBtn,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
} from "../components/dialog-styles.ts";

// The outcome of each settled secret request in the transcript, keyed by
// request id. ChatTranscript reads it from the system entries that close a
// request (metadata.secretRequestSettled), so a reload shows a settled card.
export const SecretRequestOutcomes = createContext<
  ReadonlyMap<string, "saved" | "declined">
>(new Map());

type Outcome = "saved" | "declined" | "closed";

const hintStyle = {
  fontSize: 12,
  color: "var(--text-secondary)",
  margin: "0 0 8px",
} as const;

// An agent's request for a secret (secrets loop, B4). The member types the
// value in a masked field here, so it never enters the chat. The field is
// cleared after a save, a decline or a failure that closes the request.
export function SecretRequestCard({
  payload,
  agentId,
}: {
  payload: SecretRequestPayload;
  agentId: string;
}) {
  const { t } = useI18n();
  const settled = useContext(SecretRequestOutcomes).get(payload.requestId);
  const { sessionContext, agents, serverBootId } = useAppState();
  // Open requests live in the server's memory: a card from an earlier boot
  // has nothing left to answer. Open only when both ids are present and
  // equal, so an older client or server never shows a form that cannot save.
  const fromEarlierBoot =
    payload.bootId === undefined ||
    serverBootId === null ||
    payload.bootId !== serverBootId;
  // The server decides; this only spares a form that would get 403. The
  // agent's manager answers a personal request, an owner an office one.
  const managerId = agents.find((agent) => agent.id === agentId)?.userId;
  const canAnswer =
    sessionContext !== null &&
    (payload.scope === "office"
      ? sessionContext.role === "owner"
      : managerId === sessionContext.userId);
  const [hosts, setHosts] = useState(payload.hosts.join("\n"));
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<Outcome | null>(null);
  const outcome = settled ?? local ?? (fromEarlierBoot ? "closed" : null);

  const base = `/api/agents/${encodeURIComponent(agentId)}/secret-requests/${encodeURIComponent(payload.requestId)}`;

  function errorText(caught: unknown): string {
    if (!(caught instanceof ApiError)) return t("settings.secrets.saveFailed");
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
    return t("settings.secrets.saveFailed");
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
      setLocal(kind === "save" ? "saved" : "declined");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setValue("");
        setLocal("closed");
      } else setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const form =
    payload.form.kind === "header"
      ? t("settings.secrets.formHeaderNamed", { header: payload.form.header })
      : t("settings.secrets.formAuthorization");

  return (
    <div
      data-secret-request={payload.requestId}
      style={{
        margin: "8px 0",
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        maxWidth: 520,
      }}
    >
      <div style={{ fontWeight: 650, marginBottom: 4 }}>
        {t("cards.secretRequest.title", { name: payload.name })}
      </div>
      <p style={{ ...hintStyle, whiteSpace: "pre-wrap" }}>{payload.reason}</p>
      <p style={hintStyle}>
        {payload.scope === "office"
          ? t("cards.secretRequest.office")
          : t("cards.secretRequest.personal")}{" "}
        {form}
      </p>
      {!outcome && !canAnswer && (
        <p style={{ ...hintStyle, margin: 0 }} data-outcome="read-only">
          {payload.scope === "office"
            ? t("cards.secretRequest.ownerAnswers")
            : t("cards.secretRequest.managerAnswers")}
        </p>
      )}
      {!outcome && !canAnswer ? null : outcome ? (
        <p style={{ ...hintStyle, margin: 0 }} data-outcome={outcome}>
          {outcome === "saved"
            ? t("cards.secretRequest.saved")
            : outcome === "declined"
              ? t("cards.secretRequest.declined")
              : t("cards.secretRequest.closed")}
        </p>
      ) : (
        <>
          <label style={{ display: "block", marginBottom: 4 }}>
            <span style={dialogLabel}>{t("settings.secrets.hosts")}</span>
            <textarea
              rows={Math.min(4, Math.max(2, payload.hosts.length))}
              spellCheck={false}
              value={hosts}
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
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
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
        </>
      )}
    </div>
  );
}
