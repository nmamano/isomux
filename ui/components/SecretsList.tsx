import { useEffect, useState } from "react";

import type {
  SecretListRes,
  SecretWire,
} from "../../shared/contract-shapes.ts";
import { SECRET_PRESETS, type SecretForm } from "../../shared/secret-hosts.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
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

// The Secrets list (internal-docs/secrets-design.md, section 1), next to the
// variables on both halves of the connections settings. Values are
// write-only: the list shows names, hosts, the form and when the value was
// set, and a value field is always empty when it opens and is cleared after a
// save or a cancel.

type Mode =
  | { kind: "idle" }
  | { kind: "add" }
  | { kind: "rotate"; name: string }
  | { kind: "edit"; name: string }
  | { kind: "delete"; name: string };

interface Draft {
  preset: string;
  name: string;
  value: string;
  hosts: string;
  formKind: SecretForm["kind"];
  header: string;
}

const EMPTY_DRAFT: Draft = {
  preset: "",
  name: "",
  value: "",
  hosts: "",
  formKind: "authorization",
  header: "",
};

function formOf(draft: Draft): SecretForm {
  return draft.formKind === "header"
    ? { kind: "header", header: draft.header.trim() }
    : { kind: "authorization" };
}

function hostsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean);
}

interface SecretsListProps {
  // /api/office/secrets or /api/users/<name>/secrets.
  path: string;
  // False for a member on the office half: office secrets are owner-only.
  canEdit: boolean;
}

// The settings view keeps one instance across the two halves and changes
// only the path. A new scope must get a new instance: an open form, a typed
// value or a late list from the other scope must never carry over.
export function SecretsList(props: SecretsListProps) {
  return <ScopeSecrets key={props.path} {...props} />;
}

function ScopeSecrets({ path, canEdit }: SecretsListProps) {
  const { t, language } = useI18n();
  const [secrets, setSecrets] = useState<SecretWire[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    apiFetch<SecretListRes>("GET", path)
      .then((result) => setSecrets(result.secrets))
      .catch(() => setError(t("settings.secrets.loadFailed")));

  useEffect(() => {
    if (canEdit) void load();
    // The path is the complete identity of this scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canEdit]);

  // The MCP server editor can add a secret.
  useEffect(
    () =>
      onConnectionsChanged(() => {
        if (canEdit) void load();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, canEdit],
  );

  function open(next: Mode, from?: SecretWire) {
    setError(null);
    setMode(next);
    setDraft(
      from
        ? {
            ...EMPTY_DRAFT,
            name: from.name,
            hosts: from.hosts.join("\n"),
            formKind: from.form.kind,
            header: from.form.kind === "header" ? from.form.header : "",
          }
        : EMPTY_DRAFT,
    );
  }

  function close() {
    setMode({ kind: "idle" });
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  function errorText(caught: unknown): string {
    if (!(caught instanceof ApiError)) return t("settings.secrets.saveFailed");
    const detail = caught.detail ?? {};
    if (caught.code === "host_not_allowed")
      return t("settings.secrets.error.neverListed", {
        host: typeof detail.host === "string" ? detail.host : "",
      });
    if (caught.code === "secret_exists")
      return t("settings.secrets.error.exists");
    if (caught.code === "invalid_secret") {
      if (detail.field === "name")
        return detail.reason === "reserved"
          ? t("settings.secrets.error.reservedName")
          : t("settings.secrets.error.name");
      if (detail.field === "value") return t("settings.secrets.error.value");
      if (detail.field === "hosts") return t("settings.secrets.error.hosts");
      if (detail.field === "form") return t("settings.secrets.error.header");
    }
    return t("settings.secrets.saveFailed");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === "add")
        await apiFetch("POST", path, {
          name: draft.name.trim(),
          value: draft.value.trim(),
          hosts: hostsOf(draft.hosts),
          form: formOf(draft),
        });
      else if (mode.kind === "rotate")
        await apiFetch(
          "PUT",
          `${path}/${encodeURIComponent(mode.name)}/value`,
          { value: draft.value.trim() },
        );
      else if (mode.kind === "edit")
        await apiFetch("PATCH", `${path}/${encodeURIComponent(mode.name)}`, {
          hosts: hostsOf(draft.hosts),
          form: formOf(draft),
        });
      else if (mode.kind === "delete")
        await apiFetch("DELETE", `${path}/${encodeURIComponent(mode.name)}`);
      close();
      await load();
      notifyConnectionsChanged();
    } catch (caught) {
      // The value stays out of the error, and the field keeps it only so the
      // member can fix another field and save again.
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const formLabel = (form: SecretForm) =>
    form.kind === "header"
      ? t("settings.secrets.formHeaderNamed", { header: form.header })
      : t("settings.secrets.formAuthorization");

  const valueField = (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={dialogLabel}>{t("settings.secrets.value")}</span>
      <input
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={draft.value}
        placeholder={t("settings.secrets.valuePlaceholder")}
        style={dialogInput}
        onChange={(event) =>
          setDraft((d) => ({ ...d, value: event.target.value }))
        }
      />
    </label>
  );

  const hostsAndForm = (
    <>
      <label style={{ display: "block", marginBottom: 4 }}>
        <span style={dialogLabel}>{t("settings.secrets.hosts")}</span>
        <textarea
          rows={3}
          spellCheck={false}
          value={draft.hosts}
          placeholder="api.example.com"
          style={{
            ...dialogInput,
            fontFamily: "monospace",
            resize: "vertical",
          }}
          onChange={(event) =>
            setDraft((d) => ({ ...d, hosts: event.target.value }))
          }
        />
      </label>
      <p style={{ ...hint, margin: "0 0 8px" }}>
        {t("settings.secrets.vouch")}
      </p>
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
            {t("settings.secrets.formAuthorization")}
          </option>
          <option value="header">{t("settings.secrets.formHeader")}</option>
        </select>
      </label>
      {draft.formKind === "header" && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={dialogLabel}>{t("settings.secrets.headerName")}</span>
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
    <section data-secrets-path={path} style={{ ...cardStyle, marginTop: 14 }}>
      <h5 style={{ margin: "0 0 8px" }}>{t("settings.secrets.title")}</h5>
      {!canEdit ? (
        <p style={{ ...hint, margin: 0 }}>
          {t("settings.secrets.ownerManaged")}
        </p>
      ) : (
        <>
          <p style={{ ...hint, margin: "0 0 10px" }}>
            {t("settings.secrets.hint")}
          </p>
          {secrets === null && !error && (
            <p style={hint}>{t("common.loading")}</p>
          )}
          {secrets?.length === 0 && mode.kind !== "add" && (
            <p style={hint}>{t("settings.secrets.empty")}</p>
          )}
          {secrets?.map((secret) => (
            <div
              key={secret.name}
              data-secret-name={secret.name}
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
                  <code style={{ fontWeight: 650 }}>{secret.name}</code>
                  <div style={hint}>
                    {secret.hosts.join(", ")} · {formLabel(secret.form)}
                  </div>
                  <div style={hint}>
                    {t("settings.secrets.setOn", {
                      date: formatDateTime(language, secret.valueSetAt, "date"),
                    })}
                  </div>
                </div>
                {mode.kind === "idle" && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={dialogCancelBtn}
                      onClick={() =>
                        open({ kind: "rotate", name: secret.name })
                      }
                    >
                      {t("settings.secrets.rotate")}
                    </button>
                    <button
                      type="button"
                      style={dialogCancelBtn}
                      onClick={() =>
                        open({ kind: "edit", name: secret.name }, secret)
                      }
                    >
                      {t("settings.secrets.edit")}
                    </button>
                    <button
                      type="button"
                      style={dialogCancelBtn}
                      onClick={() =>
                        open({ kind: "delete", name: secret.name })
                      }
                    >
                      {t("settings.secrets.delete")}
                    </button>
                  </div>
                )}
              </div>
              {mode.kind === "rotate" && mode.name === secret.name && (
                <div style={{ marginTop: 8 }}>
                  {valueField}
                  {actions(t("settings.secrets.saveValue"))}
                </div>
              )}
              {mode.kind === "edit" && mode.name === secret.name && (
                <div style={{ marginTop: 8 }}>
                  {hostsAndForm}
                  {actions(t("common.save"))}
                </div>
              )}
              {mode.kind === "delete" && mode.name === secret.name && (
                <div style={{ marginTop: 8 }}>
                  <p style={{ ...hint, margin: "0 0 8px" }}>
                    {t("settings.secrets.deleteConfirm", { name: secret.name })}
                  </p>
                  {actions(t("settings.secrets.delete"))}
                </div>
              )}
            </div>
          ))}
          {mode.kind === "add" ? (
            <div
              style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}
            >
              <label style={{ display: "block", marginBottom: 8 }}>
                <span style={dialogLabel}>{t("settings.secrets.preset")}</span>
                <select
                  value={draft.preset}
                  style={dialogInput}
                  onChange={(event) => {
                    const preset = SECRET_PRESETS.find(
                      (p) => p.id === event.target.value,
                    );
                    setDraft((d) =>
                      preset
                        ? {
                            ...d,
                            preset: preset.id,
                            name: preset.name,
                            hosts: preset.hosts.join("\n"),
                            formKind: preset.form.kind,
                            header:
                              preset.form.kind === "header"
                                ? preset.form.header
                                : "",
                          }
                        : { ...d, preset: "" },
                    );
                  }}
                >
                  <option value="">{t("settings.secrets.presetCustom")}</option>
                  {SECRET_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "block", marginBottom: 8 }}>
                <span style={dialogLabel}>{t("settings.secrets.name")}</span>
                <input
                  value={draft.name}
                  placeholder="GH_TOKEN"
                  spellCheck={false}
                  autoComplete="off"
                  style={dialogInput}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, name: event.target.value }))
                  }
                />
              </label>
              {valueField}
              {hostsAndForm}
              {actions(t("common.save"))}
            </div>
          ) : (
            mode.kind === "idle" && (
              <button
                type="button"
                style={{ ...dialogCancelBtn, marginTop: 6 }}
                onClick={() => open({ kind: "add" })}
              >
                {t("settings.secrets.add")}
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
