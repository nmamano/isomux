// The token exchange of a secret (task 124eb47e): a switch, closed by
// default, that opens the fields of the exchange. A preset fills them. The
// server checks every field (shared/secret-hosts.ts, checkSecretExchange);
// this form only collects them.

import {
  SECRET_EXCHANGE_PRESETS,
  type ExchangeSpec,
} from "../../shared/secret-hosts.ts";
import { useI18n } from "../i18n.tsx";
import { Choice, Field, hintText, input, mono } from "./kit.tsx";

type BodyChoice = "basic" | "body" | "json";

// The fields as the member types them.
export interface ExchangeDraft {
  on: boolean;
  preset: string;
  url: string;
  id: string;
  body: BodyChoice;
  idField: string;
  secretField: string;
  // One name=value per line.
  params: string;
  tokenField: string;
  expiryField: string;
}

const OTHER = "other";

export function exchangeDraft(exchange?: ExchangeSpec): ExchangeDraft {
  if (!exchange)
    return {
      on: false,
      preset: OTHER,
      url: "",
      id: "",
      body: "basic",
      idField: "",
      secretField: "",
      params: "",
      tokenField: "access_token",
      expiryField: "expires_in",
    };
  return {
    on: true,
    preset: OTHER,
    url: exchange.url,
    id: exchange.id,
    body: exchange.body.kind === "json" ? "json" : exchange.body.clientAuth,
    idField: exchange.body.kind === "json" ? exchange.body.idField : "",
    secretField: exchange.body.kind === "json" ? exchange.body.secretField : "",
    params: Object.entries(exchange.params)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    tokenField: exchange.tokenField,
    expiryField: exchange.expiryField,
  };
}

// The exchange to send, or null when the switch is off. Lines without "="
// are dropped; the server refuses what it does not accept.
export function exchangeOf(draft: ExchangeDraft): ExchangeSpec | null {
  if (!draft.on) return null;
  const params: Record<string, string> = {};
  for (const line of draft.params.split("\n")) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    params[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return {
    url: draft.url.trim(),
    body:
      draft.body === "json"
        ? {
            kind: "json",
            idField: draft.idField.trim(),
            secretField: draft.secretField.trim(),
          }
        : { kind: "oauth", clientAuth: draft.body },
    id: draft.id.trim(),
    params,
    tokenField: draft.tokenField.trim() || "access_token",
    expiryField: draft.expiryField.trim() || "expires_in",
  };
}

// Whether the fields that have no default are filled.
export function exchangeFilled(draft: ExchangeDraft): boolean {
  if (!draft.on) return true;
  if (!draft.url.trim() || !draft.id.trim()) return false;
  return (
    draft.body !== "json" ||
    (draft.idField.trim().length > 0 && draft.secretField.trim().length > 0)
  );
}

// A token address's host, or null while the address is not a URL yet.
export function tokenHostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname || null;
  } catch {
    return null;
  }
}

export function ExchangeFields({
  value,
  onChange,
  onPreset,
}: {
  value: ExchangeDraft;
  onChange: (value: ExchangeDraft) => void;
  // A preset with hosts and a name: the form adds them where it can.
  onPreset?: (preset: { name: string; hosts: string[] }) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ExchangeDraft>) =>
    onChange({ ...value, ...patch });

  function pick(id: string) {
    const preset = SECRET_EXCHANGE_PRESETS.find((p) => p.id === id);
    if (!preset) return set({ preset: OTHER });
    const { exchange } = preset;
    onChange({
      ...value,
      preset: id,
      url: exchange.url,
      body: exchange.body.kind === "json" ? "json" : exchange.body.clientAuth,
      idField: exchange.body.kind === "json" ? exchange.body.idField : "",
      secretField:
        exchange.body.kind === "json" ? exchange.body.secretField : "",
      params: Object.entries(exchange.params)
        .map(([key, v]) => `${key}=${v}`)
        .join("\n"),
      tokenField: exchange.tokenField,
      expiryField: exchange.expiryField,
    });
    onPreset?.({ name: preset.name, hosts: preset.hosts });
  }

  return (
    <div data-secret-exchange style={{ marginTop: 12 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          data-secret-exchange-switch
          checked={value.on}
          onChange={(e) => set({ on: e.target.checked })}
          style={{ cursor: "pointer", margin: 0 }}
        />
        {t("integrations.secrets.exchange")}
      </label>
      <span style={{ ...hintText, display: "block", marginTop: 4 }}>
        {t("integrations.secrets.exchangeHint")}
      </span>
      {value.on && (
        <>
          <Field label={t("settings.secrets.preset")}>
            <Choice
              label={t("settings.secrets.preset")}
              value={value.preset}
              onChange={pick}
              options={[
                ...SECRET_EXCHANGE_PRESETS.map((p) => ({
                  value: p.id,
                  label: p.label,
                })),
                { value: OTHER, label: t("settings.secrets.presetCustom") },
              ]}
            />
          </Field>
          <Field label={t("integrations.secrets.exchangeUrl")}>
            <input
              data-secret-exchange-url
              style={{ ...input, ...mono }}
              value={value.url}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://auth.example.com/oauth/token"
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          <Field label={t("integrations.secrets.exchangeId")}>
            <input
              data-secret-exchange-id
              style={{ ...input, ...mono }}
              value={value.id}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set({ id: e.target.value })}
            />
          </Field>
          <Field label={t("integrations.secrets.exchangeBody")}>
            <Choice
              label={t("integrations.secrets.exchangeBody")}
              value={value.body}
              onChange={(body) => set({ body })}
              options={[
                {
                  value: "basic",
                  label: t("integrations.secrets.exchangeBasic"),
                },
                {
                  value: "body",
                  label: t("integrations.secrets.exchangeForm"),
                },
                {
                  value: "json",
                  label: t("integrations.secrets.exchangeJson"),
                },
              ]}
            />
            {value.body === "json" && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input
                  data-secret-exchange-id-field
                  aria-label={t("integrations.secrets.exchangeIdField")}
                  placeholder={t("integrations.secrets.exchangeIdField")}
                  style={{ ...input, ...mono }}
                  value={value.idField}
                  spellCheck={false}
                  onChange={(e) => set({ idField: e.target.value })}
                />
                <input
                  data-secret-exchange-secret-field
                  aria-label={t("integrations.secrets.exchangeSecretField")}
                  placeholder={t("integrations.secrets.exchangeSecretField")}
                  style={{ ...input, ...mono }}
                  value={value.secretField}
                  spellCheck={false}
                  onChange={(e) => set({ secretField: e.target.value })}
                />
              </div>
            )}
          </Field>
          <Field label={t("integrations.secrets.exchangeParams")}>
            <textarea
              data-secret-exchange-params
              rows={2}
              spellCheck={false}
              style={{ ...input, ...mono, minHeight: 40, resize: "vertical" }}
              value={value.params}
              placeholder="scope=read"
              onChange={(e) => set({ params: e.target.value })}
            />
          </Field>
          <Field label={t("integrations.secrets.exchangeReply")}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                data-secret-exchange-token-field
                aria-label={t("integrations.secrets.exchangeTokenField")}
                placeholder="access_token"
                style={{ ...input, ...mono }}
                value={value.tokenField}
                spellCheck={false}
                onChange={(e) => set({ tokenField: e.target.value })}
              />
              <input
                data-secret-exchange-expiry-field
                aria-label={t("integrations.secrets.exchangeExpiryField")}
                placeholder="expires_in"
                style={{ ...input, ...mono }}
                value={value.expiryField}
                spellCheck={false}
                onChange={(e) => set({ expiryField: e.target.value })}
              />
            </div>
          </Field>
        </>
      )}
    </div>
  );
}
