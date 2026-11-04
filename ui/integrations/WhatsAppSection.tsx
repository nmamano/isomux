// The WhatsApp card of the Integrations Messaging tab (task d03a61d8): the member links their
// own WhatsApp as a linked device, by QR or by a pairing code, and unlinks
// it. Only the viewer's own: no owner links a member's phone. The status
// comes from GET /api/whatsapp, then live from the whatsapp_status event.

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState, useDispatch } from "../store.tsx";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import type {
  WhatsAppChatSeen,
  WhatsAppLinkReq,
  WhatsAppReason,
  WhatsAppRoute,
  WhatsAppRouteCreateReq,
  WhatsAppRouteDead,
  WhatsAppRouteTrigger,
  WhatsAppStatus,
} from "../../shared/whatsapp.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import {
  AddRow,
  Btn,
  Choice,
  Empty,
  Field,
  FormButtons,
  ItemRow,
  Logo,
  Pill,
  card,
  errorText,
  hintText,
  input,
} from "./kit.tsx";

const REASON: Record<WhatsAppReason, PlainMessageKey> = {
  link_expired: "integrations.whatsapp.reason.linkExpired",
  install_failed: "integrations.whatsapp.reason.installFailed",
  unlinked_by_phone: "integrations.whatsapp.reason.unlinkedByPhone",
  replaced: "integrations.whatsapp.reason.replaced",
  crash_loop: "integrations.whatsapp.reason.crashLoop",
};

const ERROR: Record<number, PlainMessageKey> = {
  400: "integrations.whatsapp.error.phone",
  429: "integrations.whatsapp.error.tooSoon",
};

export function WhatsAppSection() {
  const { t } = useI18n();
  const { whatsappStatus: status } = useAppState();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [codeForm, setCodeForm] = useState(false);
  const [phone, setPhone] = useState("");

  const show = (next: WhatsAppStatus) =>
    dispatch({ type: "whatsapp_status", status: next });

  useEffect(() => {
    apiFetch<WhatsAppStatus>("GET", "/api/whatsapp")
      .then(show)
      .catch(() => setError("integrations.whatsapp.error.failed"));
    // Once, on mount; the event keeps it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(run: () => Promise<WhatsAppStatus | null>) {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      if (next) show(next);
    } catch (err) {
      const code = err instanceof ApiError ? err.status : 0;
      setError(ERROR[code] ?? "integrations.whatsapp.error.failed");
      // Another tab or device changed the link: show where it is now.
      if (code === 409)
        await apiFetch<WhatsAppStatus>("GET", "/api/whatsapp")
          .then(show)
          .catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const link = (req: WhatsAppLinkReq) =>
    act(() => apiFetch<WhatsAppStatus>("POST", "/api/whatsapp/link", req));
  const unlink = () =>
    act(async () => {
      await apiFetch("DELETE", "/api/whatsapp");
      setCodeForm(false);
      return { state: "unlinked" };
    });

  return (
    <section
      data-integrations-card="whatsapp"
      data-whatsapp-state={status?.state ?? "loading"}
      style={card}
      aria-busy={!status}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "0 0 12px",
        }}
      >
        <Logo label="WhatsApp" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>WhatsApp</span>
      </div>
      {status && "reason" in status && status.reason && (
        <p
          data-whatsapp-reason={status.reason}
          style={{
            ...hintText,
            color: "var(--orange-text)",
            margin: "0 0 12px",
          }}
        >
          {t(REASON[status.reason])}
        </p>
      )}

      {(status?.state === "unlinked" || status?.state === "dead") && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Btn
              kind="primary"
              disabled={busy}
              onClick={() => void link({ method: "qr" })}
              data-whatsapp-link=""
            >
              {status.state === "dead"
                ? t("integrations.whatsapp.linkAgain")
                : t("integrations.whatsapp.link")}
            </Btn>
            {status.state === "dead" && (
              <Btn
                disabled={busy}
                onClick={() => void unlink()}
                data-whatsapp-unlink=""
              >
                {t("integrations.whatsapp.unlink")}
              </Btn>
            )}
            {!codeForm && (
              <Btn
                kind="link"
                onClick={() => setCodeForm(true)}
                data-whatsapp-code-form=""
              >
                {t("integrations.whatsapp.useCode")}
              </Btn>
            )}
          </div>
          {codeForm && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void link({ method: "code", phone });
              }}
              style={{
                display: "flex",
                gap: 8,
                marginTop: 10,
                flexWrap: "wrap",
              }}
            >
              <input
                type="tel"
                name="whatsappPhone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t("integrations.whatsapp.phonePlaceholder")}
                aria-label={t("integrations.whatsapp.phoneLabel")}
                style={{ ...input, width: 220 }}
              />
              <Btn
                disabled={busy || !phone.trim()}
                onClick={() => void link({ method: "code", phone })}
                data-whatsapp-get-code=""
              >
                {t("integrations.whatsapp.getCode")}
              </Btn>
            </form>
          )}
          <p style={{ ...hintText, margin: "12px 0 0" }}>
            {t("integrations.whatsapp.warning")}
          </p>
        </>
      )}

      {status?.state === "linking" && (
        <>
          {status.method === "qr" && status.qrSvg && (
            <img
              data-whatsapp-qr=""
              alt={t("integrations.whatsapp.qrAlt")}
              src={`data:image/svg+xml;utf8,${encodeURIComponent(status.qrSvg)}`}
              style={{
                width: 220,
                height: 220,
                background: "#fff",
                padding: 8,
                borderRadius: 6,
                display: "block",
              }}
            />
          )}
          {status.method === "code" && status.pairingCode && (
            <p
              data-whatsapp-pairing-code=""
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 24,
                letterSpacing: 4,
                margin: "4px 0",
              }}
            >
              {status.pairingCode}
            </p>
          )}
          <p style={{ ...hintText, margin: "10px 0" }}>
            {!status.qrSvg && !status.pairingCode
              ? t("integrations.whatsapp.starting")
              : status.method === "qr"
                ? t("integrations.whatsapp.scanSteps")
                : t("integrations.whatsapp.codeSteps")}
          </p>
          <Btn
            disabled={busy}
            onClick={() => void unlink()}
            data-whatsapp-cancel=""
          >
            {t("common.cancel")}
          </Btn>
        </>
      )}

      {status?.state === "linked" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13 }}>
            {t("integrations.whatsapp.linkedAs", { phone: `+${status.phone}` })}
          </span>
          <Pill
            tone={status.connected ? "green" : "neutral"}
            data-whatsapp-connected={String(status.connected)}
          >
            {status.connected
              ? t("integrations.whatsapp.connected")
              : t("integrations.whatsapp.connecting")}
          </Pill>
          <Btn
            kind="danger"
            small
            disabled={busy}
            onClick={() => void unlink()}
            data-whatsapp-unlink=""
          >
            {t("integrations.whatsapp.unlink")}
          </Btn>
        </div>
      )}
      {status?.state === "linked" && <WhatsAppRows />}

      {error && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {t(error)}
        </p>
      )}
    </section>
  );
}

const DEAD: Record<WhatsAppRouteDead, PlainMessageKey> = {
  agent_gone: "integrations.whatsapp.rows.dead.agentGone",
  agent_not_yours: "integrations.whatsapp.rows.dead.agentNotYours",
  agent_chat_only: "integrations.whatsapp.rows.dead.agentChatOnly",
};

const TRIGGER: Record<WhatsAppRouteTrigger, PlainMessageKey> = {
  mention: "integrations.whatsapp.rows.trigger.mention",
  all: "integrations.whatsapp.rows.trigger.all",
};

// "+447700900123" for a contact by number; null for a LID or a group.
function chatNumber(chat: string): string | null {
  const m = /^([0-9]+)@s\.whatsapp\.net$/.exec(chat);
  return m ? `+${m[1]}` : null;
}

// The picker's "by number" choice.
const BY_NUMBER = "";

// The contact rows of a linked member: which WhatsApp chats reach which of
// their agents.
function WhatsAppRows() {
  const { t } = useI18n();
  const { agents, sessionContext } = useAppState();
  const selfId = sessionContext?.userId ?? null;
  const [routes, setRoutes] = useState<WhatsAppRoute[] | null>(null);
  const [chats, setChats] = useState<WhatsAppChatSeen[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [chat, setChat] = useState(BY_NUMBER);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [trigger, setTrigger] = useState<WhatsAppRouteTrigger>("mention");

  // Agents that can reply: the member's own, above Chat stop.
  const mine = agents.filter(
    (a) =>
      selfId !== null && a.userId === selfId && agentAccessOf(a) !== "chat",
  );
  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? null;
  const picked = chats.find((c) => c.chat === chat) ?? null;
  const group = picked?.group ?? false;
  const routed = new Set(routes?.map((r) => r.chat));
  const agent = mine.find((a) => a.id === agentId) ?? null;

  const load = () =>
    apiFetch<WhatsAppRoute[]>("GET", "/api/whatsapp/routes")
      .then(setRoutes)
      .catch(() => setError("integrations.whatsapp.error.failed"));
  useEffect(() => {
    void load();
  }, []);

  function openForm() {
    setAdding(true);
    setError(null);
    setChat(BY_NUMBER);
    setPhone("");
    setName("");
    setAgentId(mine[0]?.id ?? "");
    setTrigger("mention");
    apiFetch<WhatsAppChatSeen[]>("GET", "/api/whatsapp/chats")
      .then(setChats)
      .catch(() => setChats([]));
  }

  function pick(next: string) {
    setChat(next);
    const seen = chats.find((c) => c.chat === next);
    if (seen && !name.trim()) setName(seen.name);
  }

  async function run(work: () => Promise<unknown>, byNumber = false) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.status : 0;
      setError(
        code === 409
          ? "integrations.whatsapp.rows.error.taken"
          : code === 400 && byNumber
            ? "integrations.whatsapp.error.phone"
            : "integrations.whatsapp.error.failed",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const req: WhatsAppRouteCreateReq =
      chat === BY_NUMBER
        ? { phone, name, agentId }
        : { chat, name, agentId, ...(group ? { trigger } : {}) };
    const done = await run(
      () => apiFetch("POST", "/api/whatsapp/routes", req),
      chat === BY_NUMBER,
    );
    if (done) setAdding(false);
  }

  const ready =
    name.trim() !== "" &&
    agent !== null &&
    (chat !== BY_NUMBER || phone.trim() !== "");

  return (
    <div data-whatsapp-rows="" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 650 }}>
        {t("integrations.whatsapp.rows.title")}
      </div>
      <p style={{ ...hintText, margin: "4px 0 8px" }}>
        {t("integrations.whatsapp.rows.hint")}
      </p>
      {routes?.length === 0 && (
        <Empty>{t("integrations.whatsapp.rows.empty")}</Empty>
      )}
      {routes?.map((r) => (
        <ItemRow
          key={r.id}
          data-whatsapp-row={r.id}
          title={r.name}
          detail={[
            r.group
              ? t("integrations.whatsapp.rows.group")
              : (chatNumber(r.chat) ?? r.chat.split("@")[0]),
            ...(agentName(r.agentId) ? [`→ ${agentName(r.agentId)}`] : []),
            ...(r.group && r.trigger ? [t(TRIGGER[r.trigger])] : []),
          ].join(" · ")}
          status={
            r.dead && (
              <Pill tone="red" data-whatsapp-row-dead={r.dead}>
                {t(DEAD[r.dead])}
              </Pill>
            )
          }
          actions={
            <Btn
              small
              disabled={busy}
              onClick={() =>
                void run(() =>
                  apiFetch("DELETE", `/api/whatsapp/routes/${r.id}`),
                )
              }
              data-whatsapp-row-delete={r.id}
            >
              {t("common.delete")}
            </Btn>
          }
        />
      ))}

      {adding ? (
        <form
          data-whatsapp-add-form=""
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
          style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 4 }}
        >
          <Field label={t("integrations.whatsapp.rows.chat")}>
            <select
              name="whatsappChat"
              value={chat}
              onChange={(e) => pick(e.target.value)}
              style={{ ...input, width: "100%" }}
            >
              <option value={BY_NUMBER}>
                {t("integrations.whatsapp.rows.byNumber")}
              </option>
              {chats
                .filter((c) => !routed.has(c.chat))
                .map((c) => (
                  <option key={c.chat} value={c.chat}>
                    {c.group
                      ? `${c.name} · ${t("integrations.whatsapp.rows.group")}`
                      : c.name}
                  </option>
                ))}
            </select>
          </Field>
          {chat === BY_NUMBER && (
            <Field label={t("integrations.whatsapp.rows.number")}>
              <input
                type="tel"
                name="whatsappRowPhone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t("integrations.whatsapp.phonePlaceholder")}
                style={{ ...input, width: "100%" }}
              />
            </Field>
          )}
          <Field
            label={t("integrations.whatsapp.rows.name")}
            hint={t("integrations.whatsapp.rows.nameHint")}
          >
            <input
              name="whatsappRowName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              style={{ ...input, width: "100%" }}
            />
          </Field>
          <Field label={t("integrations.whatsapp.rows.agent")}>
            {mine.length === 0 ? (
              <span style={hintText}>
                {t("integrations.whatsapp.rows.noAgents")}
              </span>
            ) : (
              <select
                name="whatsappRowAgent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                style={{ ...input, width: "100%" }}
              >
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {group && (
            <Field label={t("integrations.whatsapp.rows.trigger")}>
              <Choice
                label={t("integrations.whatsapp.rows.trigger")}
                value={trigger}
                onChange={setTrigger}
                options={(["mention", "all"] as const).map((v) => ({
                  value: v,
                  label: t(TRIGGER[v]),
                }))}
              />
            </Field>
          )}
          {agent && !belowStandard(agentAccessOf(agent)) && (
            <p
              data-whatsapp-shell-warning=""
              style={{
                ...hintText,
                color: "var(--orange-text)",
                margin: "10px 0 0",
              }}
            >
              {t("integrations.whatsapp.rows.shellWarning")}
            </p>
          )}
          <FormButtons
            ready={ready}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={save}
            saveLabel={t("integrations.whatsapp.rows.save")}
          />
        </form>
      ) : (
        routes !== null && (
          <AddRow
            label={t("integrations.whatsapp.rows.add")}
            onClick={openForm}
          />
        )
      )}

      {error && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {t(error)}
        </p>
      )}
    </div>
  );
}
