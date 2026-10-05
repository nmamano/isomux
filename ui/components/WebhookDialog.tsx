// Create or edit a webhook: name, sender, target and rules. Modeled on
// CronjobDialog. The server validates every field; this form only shapes the
// request. See internal-docs/webhooks-design.md sections 2 to 4 and 8.

import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  disabledLook,
} from "./dialog-styles.ts";
import type {
  WebhookCreateReq,
  WebhookUpdateReq,
} from "../../shared/contract-shapes.ts";
import type {
  WebhookRule,
  WebhookScheme,
  WebhookTarget,
  WebhookWire,
} from "../../shared/types.ts";

// The server's limits (server/webhooks/match.ts, design section 3); the form
// stops offering rows past them.
const MAX_RULES = 20;
const MAX_PAIRS = 10;
const NOTE_MAX = 1000;

// Code, not words: these stay out of the catalogs.
const PLACEHOLDER = {
  name: "pr-review",
  event: "pull_request",
  path: "pull_request.base.ref",
  value: "main",
  arg: "pr",
  template: "{{payload.pull_request.number}}",
  signatureHeader: "X-Signature",
};

interface Pair {
  key: number;
  name: string;
  value: string;
}
interface RuleDraft {
  key: number;
  event: string;
  match: Pair[];
  args: Pair[];
}

let nextKey = 1;
const pairsOf = (record: Record<string, string> | undefined): Pair[] =>
  Object.entries(record ?? {}).map(([name, value]) => ({
    key: nextKey++,
    name,
    value,
  }));
const draftOf = (rule: WebhookRule): RuleDraft => ({
  key: nextKey++,
  event: rule.event,
  match: pairsOf(rule.match),
  args: pairsOf(rule.args),
});

// Rows left fully blank are dropped; anything else goes to the server as it
// is, so its message names what is wrong.
const recordOf = (pairs: Pair[]): Record<string, string> | undefined => {
  const kept = pairs.filter((p) => p.name.trim() !== "" || p.value !== "");
  if (kept.length === 0) return undefined;
  return Object.fromEntries(kept.map((p) => [p.name.trim(), p.value]));
};
export function rulesOf(drafts: RuleDraft[]): WebhookRule[] {
  return drafts.map((d) => {
    const match = recordOf(d.match);
    const args = recordOf(d.args);
    return {
      event: d.event.trim(),
      ...(match ? { match } : {}),
      ...(args ? { args } : {}),
    };
  });
}

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

export function WebhookDialog({
  webhook,
  onClose,
  onDeleted,
}: {
  webhook?: WebhookWire;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { isMobile, agents, cronjobs } = useAppState();
  const { t } = useI18n();
  const isEdit = webhook !== undefined;

  const [name, setName] = useState(webhook?.name ?? "");
  const [scheme, setScheme] = useState<WebhookScheme>(
    webhook?.scheme ?? "github-hmac-sha256",
  );
  const [signatureHeader, setSignatureHeader] = useState(
    webhook?.signatureHeader ?? "",
  );
  const [eventHeader, setEventHeader] = useState(webhook?.eventHeader ?? "");
  const [deliveryHeader, setDeliveryHeader] = useState(
    webhook?.deliveryHeader ?? "",
  );
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [targetKind, setTargetKind] = useState<WebhookTarget["kind"]>(
    webhook?.target.kind ?? "agent",
  );
  // Each kind keeps its own choice, so switching kinds and back loses nothing.
  const [agentId, setAgentId] = useState(
    webhook?.target.kind === "agent" ? webhook.target.agentId : "",
  );
  const [note, setNote] = useState(
    webhook?.target.kind === "agent" ? (webhook.target.note ?? "") : "",
  );
  const [cronjobId, setCronjobId] = useState(
    webhook?.target.kind === "cronjob" ? webhook.target.cronjobId : "",
  );
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    webhook ? webhook.rules.map(draftOf) : [draftOf({ event: "pull_request" })],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // A target the viewer cannot pick (gone, or out of reach) stays selected,
  // shown as unavailable, until the member picks another.
  const agentOptions = agents.map((a) => ({ id: a.id, label: a.name }));
  if (agentId && !agentOptions.some((o) => o.id === agentId)) {
    agentOptions.unshift({
      id: agentId,
      label: t("webhooks.target.unavailable", { id: agentId }),
    });
  }
  const cronjobOptions = cronjobs
    .filter((c) => c.canManage)
    .map((c) => ({ id: c.id, label: c.name }));
  if (cronjobId && !cronjobOptions.some((o) => o.id === cronjobId)) {
    cronjobOptions.unshift({
      id: cronjobId,
      label: t("webhooks.target.unavailable", { id: cronjobId }),
    });
  }

  const target = (): WebhookTarget =>
    targetKind === "agent"
      ? {
          kind: "agent",
          agentId,
          ...(note.trim() ? { note: note.trim() } : {}),
        }
      : { kind: "cronjob", cronjobId };

  const fields = () => ({
    name: name.trim(),
    signatureHeader: scheme === "hmac-sha256" ? orNull(signatureHeader) : null,
    eventHeader: scheme === "hmac-sha256" ? orNull(eventHeader) : null,
    deliveryHeader: scheme === "hmac-sha256" ? orNull(deliveryHeader) : null,
    rules: rulesOf(rules),
    target: target(),
    enabled,
  });

  const baselineRef = useRef<string | null>(null);
  if (baselineRef.current === null) {
    baselineRef.current = JSON.stringify({ scheme, ...fields() });
  }
  const isDirty = () =>
    JSON.stringify({ scheme, ...fields() }) !== baselineRef.current;

  const noteHasBrackets = /[<>]/.test(note);
  const targetChosen =
    targetKind === "agent" ? agentId !== "" : cronjobId !== "";
  const canSave = !saving && targetChosen && !noteHasBrackets;

  function requestClose() {
    if (isDirty()) setConfirmDiscard(true);
    else onClose();
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (saving) return;
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const next = fields();
    let req: Promise<unknown>;
    if (webhook) {
      // Only what changed; never the scheme, which the server refuses on PATCH.
      const before: Record<string, unknown> = {
        name: webhook.name,
        signatureHeader: webhook.signatureHeader,
        eventHeader: webhook.eventHeader,
        deliveryHeader: webhook.deliveryHeader,
        rules: webhook.rules,
        target: webhook.target,
        enabled: webhook.enabled,
      };
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next)) {
        if (JSON.stringify(value) !== JSON.stringify(before[key])) {
          body[key] = value;
        }
      }
      if (Object.keys(body).length === 0) {
        setSaving(false);
        onClose();
        return;
      }
      req = apiFetch(
        "PATCH",
        `/api/webhooks/${encodeURIComponent(webhook.id)}`,
        body as WebhookUpdateReq,
      );
    } else {
      const body: WebhookCreateReq = { scheme, ...next };
      req = apiFetch("POST", "/api/webhooks", body);
    }
    req
      .then(() => onClose())
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : t("common.saveFailed")),
      )
      .finally(() => setSaving(false));
  }

  function handleDelete() {
    if (!webhook) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    apiFetch("DELETE", `/api/webhooks/${encodeURIComponent(webhook.id)}`)
      .then(() => {
        onClose();
        onDeleted?.();
      })
      .catch((e) => {
        setConfirmDelete(false);
        setError(e instanceof ApiError ? e.message : t("common.saveFailed"));
      })
      .finally(() => setSaving(false));
  }

  const updateRule = (key: number, change: (r: RuleDraft) => RuleDraft) =>
    setRules((all) => all.map((r) => (r.key === key ? change(r) : r)));
  const moveRule = (index: number, by: -1 | 1) =>
    setRules((all) => {
      const next = [...all];
      const [rule] = next.splice(index, 1);
      next.splice(index + by, 0, rule);
      return next;
    });

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        role="dialog"
        data-webhook-dialog=""
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: isMobile ? "none" : "1px solid var(--border-light)",
          borderRadius: isMobile ? 0 : 16,
          display: "flex",
          flexDirection: "column",
          width: isMobile ? "100%" : 520,
          height: isMobile ? "calc(100dvh - var(--banner-h, 0px))" : undefined,
          maxHeight: isMobile
            ? "calc(100dvh - var(--banner-h, 0px))"
            : "calc(90vh - var(--banner-h, 0px))",
          boxShadow: isMobile ? "none" : "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <div
          style={{
            overflowY: "auto",
            flex: 1,
            padding: isMobile
              ? "max(24px, env(safe-area-inset-top)) 20px 0"
              : "24px 28px 0",
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>
            {isEdit
              ? t("webhooks.dialog.editTitle")
              : t("webhooks.dialog.newTitle")}
          </h2>

          <label style={labelStyle}>{t("webhooks.dialog.name")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={PLACEHOLDER.name}
            style={inputStyle}
            data-field="name"
          />
          <p style={hintStyle}>{t("webhooks.dialog.nameHint")}</p>

          <label style={{ ...labelStyle, marginTop: 14 }}>
            {t("webhooks.dialog.scheme")}
          </label>
          <select
            value={scheme}
            disabled={isEdit}
            onChange={(e) => setScheme(e.target.value as WebhookScheme)}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
            data-field="scheme"
          >
            <option value="github-hmac-sha256">
              {t("webhooks.dialog.schemeGithub")}
            </option>
            <option value="hmac-sha256">
              {t("webhooks.dialog.schemeGeneric")}
            </option>
          </select>
          {isEdit && (
            <p style={hintStyle}>{t("webhooks.dialog.schemeFixed")}</p>
          )}
          {scheme === "hmac-sha256" && (
            <>
              <label style={{ ...labelStyle, marginTop: 10 }}>
                {t("webhooks.setup.signatureHeader")}
              </label>
              <input
                value={signatureHeader}
                onChange={(e) => setSignatureHeader(e.target.value)}
                placeholder={PLACEHOLDER.signatureHeader}
                style={inputStyle}
                data-field="signatureHeader"
              />
              <label style={{ ...labelStyle, marginTop: 10 }}>
                {t("webhooks.dialog.eventHeader")}
              </label>
              <input
                value={eventHeader}
                onChange={(e) => setEventHeader(e.target.value)}
                style={inputStyle}
                data-field="eventHeader"
              />
              <label style={{ ...labelStyle, marginTop: 10 }}>
                {t("webhooks.dialog.deliveryHeader")}
              </label>
              <input
                value={deliveryHeader}
                onChange={(e) => setDeliveryHeader(e.target.value)}
                style={inputStyle}
                data-field="deliveryHeader"
              />
            </>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>
            {t("webhooks.target.title")}
          </label>
          <div style={{ display: "flex", gap: 14, marginBottom: 6 }}>
            {(["agent", "cronjob"] as const).map((kind) => (
              <label
                key={kind}
                style={{
                  fontSize: 12,
                  display: "flex",
                  gap: 5,
                  alignItems: "center",
                }}
              >
                <input
                  type="radio"
                  name="webhook-target-kind"
                  checked={targetKind === kind}
                  onChange={() => setTargetKind(kind)}
                  data-target-kind={kind}
                />
                {kind === "agent"
                  ? t("webhooks.dialog.targetAgent")
                  : t("webhooks.dialog.targetCronjob")}
              </label>
            ))}
          </div>
          {targetKind === "agent" ? (
            <>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                data-field="agentId"
              >
                <option value="">{t("webhooks.dialog.pickAgent")}</option>
                {agentOptions.map((o) => (
                  <option key={o.id} value={o.id} {...noTranslate()}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label style={{ ...labelStyle, marginTop: 10 }}>
                {t("webhooks.dialog.note")}
              </label>
              <textarea
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: "vertical" }}
                data-field="note"
              />
              <p
                style={{
                  ...hintStyle,
                  color: noteHasBrackets ? "var(--red-text)" : hintStyle.color,
                }}
              >
                {noteHasBrackets
                  ? t("webhooks.dialog.noteBrackets")
                  : t("webhooks.dialog.noteHint")}
              </p>
            </>
          ) : cronjobOptions.length === 0 ? (
            <p style={hintStyle}>{t("webhooks.dialog.noCronjobs")}</p>
          ) : (
            <>
              <select
                value={cronjobId}
                onChange={(e) => setCronjobId(e.target.value)}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                data-field="cronjobId"
              >
                <option value="">{t("webhooks.dialog.pickCronjob")}</option>
                {cronjobOptions.map((o) => (
                  <option key={o.id} value={o.id} {...noTranslate()}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p style={hintStyle}>{t("webhooks.dialog.cronjobHint")}</p>
            </>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>
            {t("webhooks.rules.title")}
          </label>
          <p style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>
            {t("webhooks.dialog.rulesHint")}
          </p>
          {rules.map((rule, index) => (
            <div
              key={rule.key}
              data-rule-card={index}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, flex: 1 }}>
                  {t("webhooks.rules.ruleN", { n: index + 1 })}
                </span>
                <button
                  type="button"
                  title={t("webhooks.dialog.moveUp")}
                  disabled={index === 0}
                  onClick={() => moveRule(index, -1)}
                  style={iconBtn(index === 0)}
                >
                  <Chevron up />
                </button>
                <button
                  type="button"
                  title={t("webhooks.dialog.moveDown")}
                  disabled={index === rules.length - 1}
                  onClick={() => moveRule(index, 1)}
                  style={iconBtn(index === rules.length - 1)}
                >
                  <Chevron />
                </button>
                <button
                  type="button"
                  title={t("webhooks.dialog.removeRule")}
                  onClick={() =>
                    setRules((all) => all.filter((r) => r.key !== rule.key))
                  }
                  style={iconBtn(false)}
                >
                  <Cross />
                </button>
              </div>
              <div style={subLabel}>{t("webhooks.rules.event")}</div>
              <input
                value={rule.event}
                placeholder={PLACEHOLDER.event}
                onChange={(e) =>
                  updateRule(rule.key, (r) => ({ ...r, event: e.target.value }))
                }
                style={inputStyle}
                data-rule-event={index}
              />
              <PairRows
                label={t("webhooks.rules.match")}
                addLabel={t("webhooks.dialog.addMatch")}
                pairs={rule.match}
                namePlaceholder={PLACEHOLDER.path}
                valuePlaceholder={PLACEHOLDER.value}
                onChange={(match) =>
                  updateRule(rule.key, (r) => ({ ...r, match }))
                }
              />
              <PairRows
                label={t("webhooks.rules.args")}
                addLabel={t("webhooks.dialog.addArg")}
                pairs={rule.args}
                namePlaceholder={PLACEHOLDER.arg}
                valuePlaceholder={PLACEHOLDER.template}
                onChange={(args) =>
                  updateRule(rule.key, (r) => ({ ...r, args }))
                }
              />
            </div>
          ))}
          {rules.length < MAX_RULES && (
            <button
              type="button"
              onClick={() =>
                setRules((all) => [...all, draftOf({ event: "" })])
              }
              style={addBtn}
              data-add-rule=""
            >
              {t("webhooks.dialog.addRule")}
            </button>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              marginTop: 14,
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("webhooks.enabled")}
          </label>

          {error && (
            <p
              style={{
                fontSize: 11,
                color: "var(--red-text)",
                margin: "10px 0 0",
              }}
              data-webhook-dialog-error=""
            >
              {error}
            </p>
          )}
          <div style={{ height: 16 }} />
        </div>

        <div
          style={{
            padding: isMobile
              ? "16px 20px max(16px, env(safe-area-inset-bottom))"
              : "16px 28px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {confirmDiscard && (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 10,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-input)",
              }}
            >
              <span
                style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}
              >
                {t("common.discardPrompt")}
              </span>
              <button onClick={onClose} style={dangerBtn}>
                {t("common.discard")}
              </button>
              <button
                onClick={() => setConfirmDiscard(false)}
                style={dialogCancelBtn}
              >
                {t("common.cancel")}
              </button>
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: isEdit ? "space-between" : "flex-end",
              gap: 8,
            }}
          >
            {isEdit && (
              <button
                onClick={handleDelete}
                onBlur={() => setConfirmDelete(false)}
                disabled={saving}
                data-webhook-delete=""
                style={{
                  padding: "7px 16px",
                  borderRadius: 8,
                  border: `1px solid ${confirmDelete ? "var(--red)" : "var(--border)"}`,
                  background: confirmDelete ? "var(--red-text)" : "transparent",
                  color: confirmDelete ? "var(--bg-base)" : "var(--red-text)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {confirmDelete
                  ? t("common.confirmQuestion")
                  : t("common.delete")}
              </button>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={requestClose}
                style={dialogCancelBtn}
                disabled={saving}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                style={
                  canSave
                    ? dialogSaveBtn
                    : { ...dialogSaveBtn, ...disabledLook }
                }
                data-webhook-save=""
              >
                {saving
                  ? t("common.saving")
                  : isEdit
                    ? t("common.save")
                    : t("webhooks.dialog.create")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PairRows({
  label,
  addLabel,
  pairs,
  namePlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  addLabel: string;
  pairs: Pair[];
  namePlaceholder: string;
  valuePlaceholder: string;
  onChange: (pairs: Pair[]) => void;
}) {
  const { t } = useI18n();
  const set = (key: number, change: Partial<Pair>) =>
    onChange(pairs.map((p) => (p.key === key ? { ...p, ...change } : p)));
  return (
    <div style={{ marginTop: 8 }}>
      <div style={subLabel}>{label}</div>
      {pairs.map((p) => (
        <div key={p.key} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <input
            value={p.name}
            placeholder={namePlaceholder}
            onChange={(e) => set(p.key, { name: e.target.value })}
            style={{ ...inputStyle, flex: 1, minWidth: 0 }}
          />
          <input
            value={p.value}
            placeholder={valuePlaceholder}
            onChange={(e) => set(p.key, { value: e.target.value })}
            style={{ ...inputStyle, flex: 1.3, minWidth: 0 }}
          />
          <button
            type="button"
            title={t("webhooks.dialog.removeRow")}
            onClick={() => onChange(pairs.filter((q) => q.key !== p.key))}
            style={iconBtn(false)}
          >
            <Cross />
          </button>
        </div>
      ))}
      {pairs.length < MAX_PAIRS && (
        <button
          type="button"
          onClick={() =>
            onChange([...pairs, { key: nextKey++, name: "", value: "" }])
          }
          style={addBtn}
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: up ? "rotate(180deg)" : undefined }}
    >
      <path d="M2.5 4.5 L6 8 L9.5 4.5" />
    </svg>
  );
}

function Cross() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M3 3 L9 9 M9 3 L3 9" />
    </svg>
  );
}

const labelStyle: React.CSSProperties = dialogLabel;
const inputStyle: React.CSSProperties = dialogInput;
const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-ghost)",
  margin: "3px 0 0",
};
const subLabel: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  marginBottom: 4,
};
const addBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "2px 0",
  color: "var(--accent-text)",
  fontSize: 11,
  cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--red)",
  background: "var(--red-text)",
  color: "var(--bg-base)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-ghost)" : "var(--text-dim)",
    cursor: disabled ? "default" : "pointer",
    padding: 0,
    flexShrink: 0,
  };
}
