// The Webhooks tab of the Schedules page: the hook list, and one hook's detail
// (setup, rules, counters, dry run, delivery log). See
// internal-docs/webhooks-design.md sections 8 and 9.
//
// [the secret] It never enters the store. WebhookDetail holds it in state while
// it shows, and every way the view can stop showing it (Hide, close, another
// hook, a lost permission) also voids a read still in flight.

import { useEffect, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { StatusShape } from "./StatusShape.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { dialogInput } from "./dialog-styles.ts";
import { formatDateTime, timeSince } from "../../shared/i18n/time.ts";
import type { MessageKey, Translator } from "../../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import type {
  WebhookDeliveriesRes,
  WebhookDryRunRes,
  WebhookSecretRes,
} from "../../shared/contract-shapes.ts";
import type {
  WebhookCounterReason,
  WebhookDelivery,
  WebhookDeliveryOutcome,
  WebhookTarget,
  WebhookWire,
} from "../../shared/types.ts";
import {
  canHandleWebhookSecret,
  isLoopbackUrl,
  ruleEvents,
  webhookNeedsAttention,
} from "../webhook-helpers.ts";

const MONO = "'JetBrains Mono',monospace";

// The first page of the log, and the whole log (WEBHOOK_DELIVERY_LOG_MAX).
const DELIVERIES_PAGE = 50;
const DELIVERIES_ALL = 500;

// A list snapshot that a delta overtook is refused by the reducer; the fetch
// then runs again, at most this many times in a row.
const LIST_ATTEMPTS = 5;

export const OUTCOME_KEY: Record<
  WebhookDeliveryOutcome,
  Extract<MessageKey, `webhooks.outcome.${string}`>
> = {
  pending: "webhooks.outcome.pending",
  ping: "webhooks.outcome.ping",
  bad_payload: "webhooks.outcome.badPayload",
  no_match: "webhooks.outcome.noMatch",
  dispatch_limited: "webhooks.outcome.dispatchLimited",
  target_unavailable: "webhooks.outcome.targetUnavailable",
  dispatched: "webhooks.outcome.dispatched",
};

const OUTCOME_COLOR: Record<WebhookDeliveryOutcome, string> = {
  pending: "var(--text-muted)",
  ping: "var(--text-secondary)",
  bad_payload: "var(--red-text)",
  no_match: "var(--text-muted)",
  dispatch_limited: "var(--orange-text)",
  target_unavailable: "var(--orange-text)",
  dispatched: "var(--green-text)",
};

const COUNTER_KEY: Record<
  WebhookCounterReason,
  Extract<MessageKey, `webhooks.counter.${string}`>
> = {
  disabled: "webhooks.counter.disabled",
  method: "webhooks.counter.method",
  secret_missing: "webhooks.counter.secretMissing",
  rate_limited: "webhooks.counter.rateLimited",
  body_too_large: "webhooks.counter.bodyTooLarge",
  bad_signature: "webhooks.counter.badSignature",
};

function ago(
  language: SupportedLanguageCode,
  t: Translator["t"],
  ts: number,
): string {
  const since = timeSince(language, ts);
  return since.kind === "now" ? t("common.justNow") : since.text;
}

// Fetches the viewer's hooks into the store while `active`, again on every
// rehydration and on refresh(). Shared by the tab and by a webhook run's view,
// whose link to its hook must not depend on an earlier visit to the tab.
export function useWebhookList(active: boolean): {
  error: string | null;
  refresh: () => void;
} {
  const { webhooksRevision, hydrationEpoch } = useAppState();
  const dispatch = useDispatch();
  const { t } = useI18n();
  const revisionRef = useRef(webhooksRevision);
  useEffect(() => {
    revisionRef.current = webhooksRevision;
  }, [webhooksRevision]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async (attemptsLeft: number) => {
      // The revision AS OF THE REQUEST: a delta that lands while the GET is in
      // flight moves it, and the reducer refuses this older snapshot.
      const revision = revisionRef.current;
      try {
        const webhooks = await apiFetch<WebhookWire[]>("GET", "/api/webhooks");
        if (cancelled) return;
        dispatch({ type: "webhooks_loaded", webhooks, revision });
        setError(null);
        if (revision !== revisionRef.current && attemptsLeft > 1) {
          void load(attemptsLeft - 1);
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : t("webhooks.loadFailed"),
        );
      }
    };
    void load(LIST_ATTEMPTS);
    return () => {
      cancelled = true;
    };
  }, [active, hydrationEpoch, nonce, dispatch, t]);
  return { error, refresh: () => setNonce((n) => n + 1) };
}

// "Agent: name" / "Schedule: name", from what the viewer can see.
export function useTargetLabel(): (target: WebhookTarget) => {
  text: string;
  missing: boolean;
} {
  const { agents, cronjobs } = useAppState();
  const { t } = useI18n();
  return (target) => {
    if (target.kind === "agent") {
      const agent = agents.find((a) => a.id === target.agentId);
      return agent
        ? {
            text: t("webhooks.target.agent", { name: agent.name }),
            missing: false,
          }
        : {
            text: t("webhooks.target.agent", {
              name: t("webhooks.target.unavailable", { id: target.agentId }),
            }),
            missing: true,
          };
    }
    const job = cronjobs.find((c) => c.id === target.cronjobId);
    return job
      ? {
          text: t("webhooks.target.cronjob", { name: job.name }),
          missing: false,
        }
      : {
          text: t("webhooks.target.cronjob", {
            name: t("webhooks.target.unavailable", { id: target.cronjobId }),
          }),
          missing: true,
        };
  };
}

export function WebhooksView({
  openHookId,
  focusDeliveryId,
  focusSeq = 0,
  onOpenHook,
  onCloseHook,
  onEdit,
  onOpenRun,
  onFocusAgent,
}: {
  openHookId: string | null;
  // A delivery row to scroll to and mark, from a webhook run's link. focusSeq
  // moves on every link, so following the same link again refetches.
  focusDeliveryId: string | null;
  focusSeq?: number;
  onOpenHook: (id: string) => void;
  onCloseHook: () => void;
  onEdit: (hook: WebhookWire) => void;
  onOpenRun: (cronjobId: string, runId: string) => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { webhooks, webhooksLoaded, isMobile } = useAppState();
  const { t } = useI18n();
  const { error, refresh } = useWebhookList(true);

  if (openHookId !== null) {
    const hook = webhooks.find((w) => w.id === openHookId) ?? null;
    return (
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: isMobile ? "10px 12px 40px" : "16px 24px 48px",
        }}
      >
        <button
          type="button"
          onClick={onCloseHook}
          data-webhook-back=""
          style={linkBtn}
        >
          <BackArrow /> {t("webhooks.back")}
        </button>
        {hook ? (
          <WebhookDetail
            key={hook.id}
            hook={hook}
            focusDeliveryId={focusDeliveryId}
            focusSeq={focusSeq}
            onEdit={() => onEdit(hook)}
            onRefreshList={refresh}
            onOpenRun={onOpenRun}
            onFocusAgent={onFocusAgent}
          />
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {webhooksLoaded ? t("webhooks.notFound") : t("common.loadingDots")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p
          style={{
            color: "var(--red-text)",
            fontSize: 12,
            padding: "10px 20px 0",
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
      <WebhooksTable onOpen={onOpenHook} />
      {webhooksLoaded && (
        <div style={{ padding: "12px 20px", textAlign: "center" }}>
          <button type="button" onClick={refresh} style={smallBtn}>
            {t("webhooks.refresh")}
          </button>
        </div>
      )}
    </div>
  );
}

function WebhooksTable({ onOpen }: { onOpen: (id: string) => void }) {
  const { webhooks, webhooksLoaded, isMobile } = useAppState();
  const { t, language } = useI18n();
  const targetLabel = useTargetLabel();
  const cellPad = isMobile ? "8px 6px" : "10px 12px";
  const thStyle: React.CSSProperties = {
    padding: cellPad,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-muted)",
    fontFamily: MONO,
    letterSpacing: "0.05em",
    textAlign: "left",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border-subtle)",
  };

  if (webhooks.length === 0) {
    return (
      <div
        style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}
      >
        {webhooksLoaded ? t("webhooks.empty") : t("common.loadingDots")}
      </div>
    );
  }

  const toggle = (hook: WebhookWire) => {
    apiFetch("PATCH", `/api/webhooks/${encodeURIComponent(hook.id)}`, {
      enabled: !hook.enabled,
    }).catch(() => {});
  };

  const lastText = (hook: WebhookWire) =>
    hook.lastDelivery
      ? `${t(OUTCOME_KEY[hook.lastDelivery.outcome])} · ${ago(language, t, hook.lastDelivery.receivedAt)}`
      : t("webhooks.noDeliveries");

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ ...thStyle, width: 30 }}></th>
          <th style={thStyle}>{t("webhooks.col.name")}</th>
          {!isMobile && <th style={thStyle}>{t("webhooks.col.target")}</th>}
          {!isMobile && (
            <th style={thStyle}>{t("webhooks.col.lastDelivery")}</th>
          )}
          {!isMobile && <th style={thStyle}>{t("schedules.col.by")}</th>}
          <th style={{ ...thStyle, width: 30 }}></th>
        </tr>
      </thead>
      <tbody>
        {webhooks.map((hook) => {
          const target = targetLabel(hook.target);
          const attention = webhookNeedsAttention(hook);
          return (
            <tr
              key={hook.id}
              data-webhook-row={hook.id}
              onClick={() => onOpen(hook.id)}
              style={{
                cursor: "pointer",
                borderBottom: "1px solid var(--border-subtle)",
                color: hook.enabled ? undefined : "var(--text-hint)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <td
                style={{ padding: cellPad }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(hook);
                }}
              >
                <EnabledDot enabled={hook.enabled} />
              </td>
              <td style={{ padding: cellPad, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{hook.name}</div>
                {isMobile && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: MONO,
                      marginTop: 2,
                    }}
                  >
                    {!hook.enabled && `${t("schedules.paused")} · `}
                    {target.text}
                    {" · "}
                    {lastText(hook)}
                  </div>
                )}
              </td>
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 12,
                    color: target.missing
                      ? "var(--orange-text)"
                      : "var(--text-secondary)",
                  }}
                >
                  {target.text}
                </td>
              )}
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 11,
                    fontFamily: MONO,
                    color: hook.lastDelivery
                      ? OUTCOME_COLOR[hook.lastDelivery.outcome]
                      : "var(--text-muted)",
                  }}
                >
                  {lastText(hook)}
                </td>
              )}
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: MONO,
                  }}
                >
                  {hook.username ?? hook.createdBy}
                </td>
              )}
              <td
                style={{
                  padding: cellPad,
                  color: "var(--orange-text)",
                  fontSize: 14,
                }}
              >
                {attention && (
                  <span
                    data-webhook-attention=""
                    title={
                      hook.secretState === "missing"
                        ? t("webhooks.secretMissingShort")
                        : t("webhooks.rejectedShort")
                    }
                  >
                    <StatusShape kind="warning" />
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WebhookDetail({
  hook,
  focusDeliveryId,
  focusSeq,
  onEdit,
  onRefreshList,
  onOpenRun,
  onFocusAgent,
}: {
  hook: WebhookWire;
  focusDeliveryId: string | null;
  focusSeq: number;
  onEdit: () => void;
  onRefreshList: () => void;
  onOpenRun: (cronjobId: string, runId: string) => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { isMobile, hydrationEpoch } = useAppState();
  const { t, language } = useI18n();
  const targetLabel = useTargetLabel();
  const target = targetLabel(hook.target);

  // The delivery log. A link from a run asks for the whole log, so a row past
  // the first page is still found; every link (focusSeq) fetches it again,
  // also when this detail was already open.
  const [showAll, setShowAll] = useState(false);
  const limit =
    focusDeliveryId !== null || showAll ? DELIVERIES_ALL : DELIVERIES_PAGE;
  // The rows, with the request they answer: a row counts as gone from the log
  // only on the answer to the whole-log request for that focus.
  const [log, setLog] = useState<{
    rows: WebhookDelivery[];
    limit: number;
    focus: string | null;
    focusSeq: number;
  } | null>(null);
  const deliveries = log?.rows ?? null;
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch<WebhookDeliveriesRes>(
      "GET",
      `/api/webhooks/${encodeURIComponent(hook.id)}/deliveries?limit=${limit}`,
    )
      .then((res) => {
        if (cancelled) return;
        setLog({
          rows: res.deliveries,
          limit,
          focus: focusDeliveryId,
          focusSeq,
        });
        setDeliveriesError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setDeliveriesError(
          err instanceof ApiError
            ? err.message
            : t("webhooks.deliveries.failed"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hook.id, limit, focusDeliveryId, focusSeq, nonce, hydrationEpoch, t]);

  const refresh = () => {
    onRefreshList();
    setNonce((n) => n + 1);
  };

  const focusAnswered =
    focusDeliveryId !== null &&
    log !== null &&
    log.focus === focusDeliveryId &&
    log.focusSeq === focusSeq &&
    log.limit === DELIVERIES_ALL;
  const focusFound =
    focusAnswered && log.rows.some((d) => d.id === focusDeliveryId);
  useEffect(() => {
    if (!focusFound || focusDeliveryId === null) return;
    const row = [
      ...document.querySelectorAll<HTMLElement>("[data-delivery-row]"),
    ].find((el) => el.dataset.deliveryRow === focusDeliveryId);
    row?.scrollIntoView?.({ block: "center" });
  }, [focusFound, focusDeliveryId, focusSeq]);

  const github = hook.scheme === "github-hmac-sha256";
  const { events, everything } = ruleEvents(hook.rules);
  const counters = (Object.keys(COUNTER_KEY) as WebhookCounterReason[]).flatMap(
    (reason) => {
      const c = hook.counters[reason];
      return c && c.count > 0 ? [{ reason, ...c }] : [];
    },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 8,
        }}
      >
        <span
          style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO }}
          data-webhook-name=""
        >
          {hook.name}
        </span>
        <span
          style={{
            fontSize: 11,
            color: hook.enabled ? "var(--green-text)" : "var(--text-muted)",
            fontFamily: MONO,
          }}
        >
          {hook.enabled ? t("webhooks.enabled") : t("schedules.paused")}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={refresh} style={smallBtn}>
          {t("webhooks.refresh")}
        </button>
        <button
          type="button"
          onClick={onEdit}
          style={smallBtn}
          data-webhook-edit=""
        >
          {t("common.edit")}
        </button>
      </div>

      <Card
        title={
          github ? t("webhooks.setup.github") : t("webhooks.setup.generic")
        }
      >
        <Field label={t("webhooks.setup.url")}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <code style={codeBox} data-webhook-url="">
              {hook.url}
            </code>
            <CopyButton getText={() => hook.url} />
          </div>
          <p style={hintStyle}>
            {github
              ? t("webhooks.setup.reach")
              : t("webhooks.setup.reachGeneric")}
          </p>
          {isLoopbackUrl(hook.url) && (
            <p
              style={{ ...hintStyle, color: "var(--orange-text)" }}
              data-webhook-no-public=""
            >
              {t("webhooks.setup.noPublicAddress")}
            </p>
          )}
        </Field>
        {github ? (
          <Field label={t("webhooks.setup.contentType")}>
            <code style={codeBox}>application/json</code>
          </Field>
        ) : (
          <Field label={t("webhooks.setup.signatureHeader")}>
            <code style={codeBox}>{hook.signatureHeader}</code>
          </Field>
        )}
        <SecretField hook={hook} />
        <Field label={t("webhooks.setup.events")}>
          {events.length > 0 && github && (
            <p style={{ ...hintStyle, margin: "0 0 4px" }}>
              {t("webhooks.setup.eventsHint")}
            </p>
          )}
          {events.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {events.map((e) => (
                <code key={e} style={chip}>
                  {e}
                </code>
              ))}
            </div>
          )}
          {everything && (
            <p style={hintStyle}>{t("webhooks.setup.everything")}</p>
          )}
          {events.length === 0 && !everything && (
            <p style={hintStyle}>{t("webhooks.rules.none")}</p>
          )}
          <p style={hintStyle}>{t("webhooks.setup.unsigned")}</p>
        </Field>
      </Card>

      <Card title={t("webhooks.rules.title")}>
        <Field label={t("webhooks.target.title")}>
          <span
            style={{
              fontSize: 12,
              color: target.missing ? "var(--orange-text)" : undefined,
            }}
          >
            {target.text}
          </span>
          {hook.target.kind === "agent" && hook.target.note && (
            <p style={{ ...hintStyle, whiteSpace: "pre-wrap" }}>
              {t("webhooks.target.noteLine", { note: hook.target.note })}
            </p>
          )}
        </Field>
        {hook.rules.length === 0 ? (
          <p style={hintStyle}>{t("webhooks.rules.none")}</p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
            {hook.rules.map((rule, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <code style={{ fontFamily: MONO }}>{rule.event}</code>
                {Object.entries(rule.match ?? {}).map(([path, value]) => (
                  <div key={path} style={ruleLine}>
                    {path} = {JSON.stringify(value)}
                  </div>
                ))}
                {Object.entries(rule.args ?? {}).map(([name, tpl]) => (
                  <div key={name} style={ruleLine}>
                    {name} ← {tpl}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={t("webhooks.counters.title")}>
        {counters.length === 0 ? (
          <p style={hintStyle}>
            {t("webhooks.counters.none", {
              time: formatDateTime(
                language,
                hook.countersSince,
                "monthDayTime",
              ),
            })}
          </p>
        ) : (
          <>
            <p style={hintStyle}>
              {t("webhooks.counters.since", {
                time: formatDateTime(
                  language,
                  hook.countersSince,
                  "monthDayTime",
                ),
              })}
            </p>
            <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
              <tbody>
                {counters.map((c) => (
                  <tr key={c.reason} data-webhook-counter={c.reason}>
                    <td style={{ padding: "2px 12px 2px 0" }}>
                      {t(COUNTER_KEY[c.reason])}
                    </td>
                    <td style={{ padding: "2px 12px 2px 0", fontFamily: MONO }}>
                      {c.count}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      {t("webhooks.counters.last", {
                        time: ago(language, t, c.lastAt),
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <DryRun hook={hook} />

      <Card title={t("webhooks.deliveries.title")}>
        {deliveriesError && (
          <p style={{ ...hintStyle, color: "var(--red-text)" }}>
            {deliveriesError}
          </p>
        )}
        {focusAnswered && !focusFound && (
          <p
            style={{ ...hintStyle, color: "var(--orange-text)" }}
            data-delivery-missing=""
          >
            {t("webhooks.deliveries.missingRow")}
          </p>
        )}
        {deliveries === null ? (
          !deliveriesError && <p style={hintStyle}>{t("common.loadingDots")}</p>
        ) : deliveries.length === 0 ? (
          <p style={hintStyle}>{t("webhooks.deliveries.empty")}</p>
        ) : (
          <DeliveryRows
            rows={deliveries}
            focusId={focusDeliveryId}
            isMobile={isMobile}
            onOpenRun={onOpenRun}
            onFocusAgent={onFocusAgent}
          />
        )}
        {deliveries !== null &&
          limit < DELIVERIES_ALL &&
          deliveries.length >= limit && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              style={{ ...smallBtn, marginTop: 8 }}
            >
              {t("webhooks.deliveries.more")}
            </button>
          )}
      </Card>
    </div>
  );
}

// Show, Hide and Rotate. Absent for a viewer the secret routes refuse.
function SecretField({ hook }: { hook: WebhookWire }) {
  const { sessionContext } = useAppState();
  const { t } = useI18n();
  const allowed = canHandleWebhookSecret(hook, sessionContext);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  // Every request takes a number; Hide, unmount and a lost permission take a
  // new one, so an answer that arrives after them is dropped.
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current++;
    },
    [],
  );
  useEffect(() => {
    if (allowed) return;
    requestRef.current++;
    /* eslint-disable react-hooks/set-state-in-effect */
    setSecret(null);
    setBusy(false);
    setConfirmRotate(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [allowed]);

  const run = async (method: "GET" | "POST") => {
    const id = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<WebhookSecretRes>(
        method,
        `/api/webhooks/${encodeURIComponent(hook.id)}/secret`,
      );
      if (id !== requestRef.current) return;
      setSecret(res.secret);
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(
        err instanceof ApiError ? err.message : t("webhooks.secretFailed"),
      );
    } finally {
      if (id === requestRef.current) setBusy(false);
    }
  };
  const hide = () => {
    requestRef.current++;
    setSecret(null);
    setBusy(false);
  };

  return (
    <Field label={t("webhooks.setup.secret")}>
      {hook.secretState === "missing" && (
        <p
          style={{ ...hintStyle, color: "var(--orange-text)", marginTop: 0 }}
          data-webhook-secret-missing=""
        >
          {t("webhooks.setup.secretMissing")}
        </p>
      )}
      {!allowed ? (
        <p style={{ ...hintStyle, marginTop: 0 }}>
          {t("webhooks.setup.secretMembersOnly")}
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {secret !== null ? (
            <>
              <code style={codeBox} data-webhook-secret="">
                {secret}
              </code>
              <CopyButton getText={() => secret} />
              <button
                type="button"
                onClick={hide}
                style={smallBtn}
                data-webhook-secret-hide=""
              >
                {t("webhooks.setup.hide")}
              </button>
            </>
          ) : (
            hook.secretState === "set" && (
              <button
                type="button"
                onClick={() => void run("GET")}
                disabled={busy}
                style={smallBtn}
                data-webhook-secret-show=""
              >
                {t("webhooks.setup.show")}
              </button>
            )
          )}
          {confirmRotate ? (
            <span
              style={{
                display: "inline-flex",
                gap: 6,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 11, color: "var(--orange-text)" }}>
                {t("webhooks.setup.rotateWarning")}
              </span>
              <button
                type="button"
                onClick={() => {
                  setConfirmRotate(false);
                  void run("POST");
                }}
                disabled={busy}
                style={{
                  ...smallBtn,
                  borderColor: "var(--red)",
                  color: "var(--red-text)",
                }}
                data-webhook-rotate-confirm=""
              >
                {t("webhooks.setup.rotateYes")}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRotate(false)}
                style={smallBtn}
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRotate(true)}
              disabled={busy}
              style={smallBtn}
              data-webhook-rotate=""
            >
              {t("webhooks.setup.rotate")}
            </button>
          )}
        </div>
      )}
      {error && (
        <p style={{ ...hintStyle, color: "var(--red-text)" }}>{error}</p>
      )}
    </Field>
  );
}

function DryRun({ hook }: { hook: WebhookWire }) {
  const { t } = useI18n();
  const firstEvent = hook.rules.find((r) => r.event !== "*")?.event ?? "";
  const [event, setEvent] = useState(firstEvent);
  const [payload, setPayload] = useState("");
  const [result, setResult] = useState<WebhookDryRunRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current++;
    },
    [],
  );

  const test = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      setResult(null);
      setError(t("webhooks.dryRun.notObject"));
      return;
    }
    const id = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<WebhookDryRunRes>(
        "POST",
        `/api/webhooks/${encodeURIComponent(hook.id)}/dry-run`,
        { event, payload: parsed },
      );
      if (id !== requestRef.current) return;
      setResult(res);
    } catch (err) {
      if (id !== requestRef.current) return;
      setResult(null);
      setError(
        err instanceof ApiError ? err.message : t("webhooks.dryRun.failed"),
      );
    } finally {
      if (id === requestRef.current) setBusy(false);
    }
  };

  return (
    <details style={cardStyle} data-webhook-dry-run="">
      <summary
        style={{
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          color: "var(--text-dim)",
        }}
      >
        {t("webhooks.dryRun.title")}
      </summary>
      <p style={hintStyle}>{t("webhooks.dryRun.hint")}</p>
      <Field label={t("webhooks.dryRun.event")}>
        <input
          value={event}
          onChange={(e) => setEvent(e.target.value)}
          style={dialogInput}
          data-dry-run-event=""
        />
      </Field>
      <Field label={t("webhooks.dryRun.payload")}>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          style={{ ...dialogInput, resize: "vertical" }}
          data-dry-run-payload=""
        />
      </Field>
      <button
        type="button"
        onClick={() => void test()}
        disabled={busy}
        style={smallBtn}
        data-dry-run-test=""
      >
        {t("webhooks.dryRun.run")}
      </button>
      {error && (
        <p style={{ ...hintStyle, color: "var(--red-text)" }}>{error}</p>
      )}
      {result && (
        <div style={{ marginTop: 10 }} data-dry-run-result={result.outcome}>
          <p style={{ fontSize: 12, margin: "0 0 6px" }}>
            {result.outcome === "match"
              ? t("webhooks.dryRun.match", { n: result.ruleIndex + 1 })
              : result.outcome === "ping"
                ? t("webhooks.dryRun.ping")
                : t("webhooks.dryRun.noMatch")}
          </p>
          {result.outcome === "match" && (
            <>
              <div style={{ ...dialogLabelSmall }}>
                {t("webhooks.dryRun.block")}
              </div>
              <pre
                style={{ ...codeBox, whiteSpace: "pre-wrap", display: "block" }}
                data-dry-run-block=""
              >
                {result.block}
              </pre>
            </>
          )}
        </div>
      )}
    </details>
  );
}

function DeliveryRows({
  rows,
  focusId,
  isMobile,
  onOpenRun,
  onFocusAgent,
}: {
  rows: WebhookDelivery[];
  focusId: string | null;
  isMobile: boolean;
  onOpenRun: (cronjobId: string, runId: string) => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { t, tn, language } = useI18n();
  const { agents, cronjobs, sessionContext } = useAppState();
  const pad = isMobile ? "6px 4px" : "6px 8px";
  const th: React.CSSProperties = {
    padding: pad,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-muted)",
    fontFamily: MONO,
    textAlign: "left",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border-subtle)",
  };
  const td: React.CSSProperties = {
    padding: pad,
    fontSize: 11,
    fontFamily: MONO,
    verticalAlign: "top",
  };
  // A run stays readable while its job is visible, and for office owners.
  const runReadable = (cronjobId: string) =>
    cronjobs.some((c) => c.id === cronjobId) ||
    sessionContext?.role === "owner";

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>{t("webhooks.deliveries.col.time")}</th>
            <th style={th}>{t("webhooks.deliveries.col.event")}</th>
            <th style={th}>{t("webhooks.deliveries.col.outcome")}</th>
            {!isMobile && (
              <th style={th}>{t("webhooks.deliveries.col.rule")}</th>
            )}
            {!isMobile && (
              <th style={th}>{t("webhooks.deliveries.col.args")}</th>
            )}
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const focused = row.id === focusId;
            const target = row.target;
            let link: React.ReactNode = null;
            if (
              target?.kind === "cronjob" &&
              target.runId &&
              runReadable(target.cronjobId)
            ) {
              const runId = target.runId;
              link = (
                <button
                  type="button"
                  style={linkBtn}
                  onClick={() => onOpenRun(target.cronjobId, runId)}
                  data-delivery-open-run={runId}
                >
                  {t("webhooks.deliveries.openRun")}
                </button>
              );
            } else if (
              target?.kind === "agent" &&
              onFocusAgent &&
              agents.some((a) => a.id === target.agentId)
            ) {
              link = (
                <button
                  type="button"
                  style={linkBtn}
                  onClick={() => onFocusAgent(target.agentId)}
                >
                  {t("webhooks.deliveries.openChat")}
                </button>
              );
            }
            const argsText = row.args
              ? Object.entries(row.args)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")
              : null;
            return (
              <tr
                key={row.id}
                data-delivery-row={row.id}
                data-focused={focused ? "true" : undefined}
                style={{
                  borderBottom: "1px solid var(--border-subtle)",
                  background: focused ? "var(--accent-bg)" : undefined,
                }}
              >
                <td
                  style={{
                    ...td,
                    whiteSpace: "nowrap",
                    color: "var(--text-muted)",
                  }}
                >
                  {formatDateTime(language, row.receivedAt, "monthDayTime")}
                </td>
                <td style={td}>{row.event || "-"}</td>
                <td style={{ ...td, color: OUTCOME_COLOR[row.outcome] }}>
                  {t(OUTCOME_KEY[row.outcome])}
                  {row.detail && (
                    <div style={{ color: "var(--text-muted)" }}>
                      {row.detail}
                    </div>
                  )}
                  {row.attempts > 1 && (
                    <div style={{ color: "var(--text-muted)" }}>
                      {tn("webhooks.deliveries.attempts", row.attempts)}
                    </div>
                  )}
                  {row.duplicates > 0 && (
                    <div style={{ color: "var(--text-muted)" }}>
                      {tn("webhooks.deliveries.duplicates", row.duplicates)}
                    </div>
                  )}
                  {/* No room for the rule and args columns: they go here. */}
                  {isMobile && row.ruleIndex !== null && (
                    <div
                      style={{ color: "var(--text-secondary)" }}
                      data-delivery-rule={row.ruleIndex + 1}
                    >
                      {t("webhooks.rules.ruleN", { n: row.ruleIndex + 1 })}
                    </div>
                  )}
                  {isMobile && argsText && (
                    <div
                      style={{
                        color: "var(--text-secondary)",
                        wordBreak: "break-all",
                      }}
                      data-delivery-args=""
                    >
                      {argsText}
                    </div>
                  )}
                </td>
                {!isMobile && (
                  <td
                    style={td}
                    data-delivery-rule={
                      row.ruleIndex === null ? undefined : row.ruleIndex + 1
                    }
                  >
                    {row.ruleIndex === null ? "-" : row.ruleIndex + 1}
                  </td>
                )}
                {!isMobile && (
                  <td
                    style={{
                      ...td,
                      color: "var(--text-secondary)",
                      wordBreak: "break-all",
                    }}
                    data-delivery-args={argsText === null ? undefined : ""}
                  >
                    {argsText ?? "-"}
                  </td>
                )}
                <td style={{ ...td, whiteSpace: "nowrap" }}>{link}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EnabledDot({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  return (
    <span
      title={
        enabled ? t("schedules.enabledToggle") : t("schedules.pausedToggle")
      }
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: enabled ? "var(--green)" : "var(--text-muted)",
        boxShadow: enabled ? "0 0 6px var(--green)" : "none",
      }}
    />
  );
}

export function BackArrow() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 12 12"
      style={{ display: "inline-block", verticalAlign: "-0.1em" }}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.5 6 H1.5 M5 2.5 L1.5 6 L5 9.5" />
    </svg>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={cardStyle}>
      <h3
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "var(--text-dim)",
          margin: "0 0 10px",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={dialogLabelSmall}>{label}</div>
      {children}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 8,
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  minWidth: 0,
};

const dialogLabelSmall: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "var(--text-muted)",
  fontFamily: MONO,
  letterSpacing: "0.05em",
  marginBottom: 4,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  margin: "4px 0 0",
};

const codeBox: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 6,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  wordBreak: "break-all",
  minWidth: 0,
  margin: 0,
};

const chip: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 10,
  border: "1px solid var(--border)",
};

const ruleLine: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-secondary)",
  wordBreak: "break-all",
};

const smallBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent-text)",
  fontSize: 12,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
