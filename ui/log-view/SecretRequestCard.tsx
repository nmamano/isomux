import { createContext, useContext } from "react";

import type { SecretRequestPayload } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";

// The outcome of each settled secret request in the transcript, keyed by
// request id. ChatTranscript reads it from the system entries that close a
// request (metadata.secretRequestSettled).
export const SecretRequestOutcomes = createContext<
  ReadonlyMap<string, "saved" | "declined">
>(new Map());

const hintStyle = {
  fontSize: 12,
  color: "var(--text-secondary)",
  margin: "0 0 8px",
} as const;

// A secret request card from a server before secret requests became asks
// (SecretAskCard). Every such request was opened in an earlier boot and
// cannot be answered, so the card is read-only: its outcome, else closed.
export function SecretRequestCard({
  payload,
}: {
  payload: SecretRequestPayload;
}) {
  const { t } = useI18n();
  const outcome =
    useContext(SecretRequestOutcomes).get(payload.requestId) ?? "closed";
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
      <p style={{ ...hintStyle, margin: 0 }} data-outcome={outcome}>
        {outcome === "saved"
          ? t("cards.secretRequest.saved")
          : outcome === "declined"
            ? t("cards.secretRequest.declined")
            : t("cards.secretRequest.closed")}
      </p>
    </div>
  );
}
