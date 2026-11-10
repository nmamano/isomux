// The WhatsApp card of the Integrations Messaging tab (task d03a61d8): the member links their
// own WhatsApp as a linked device, by QR or by a pairing code, and unlinks
// it. Only the viewer's own: no owner links a member's phone. The status
// comes from GET /api/whatsapp, then live from the whatsapp_status event.
// While a read is out, the card holds the layout this device last saw, so it
// does not grow when the answer arrives (task eeec205a).

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useCan } from "../hooks/useCan.ts";
import { useConfirmStep } from "../hooks/useConfirmStep.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { Reserved } from "../components/Reserved.tsx";
import { getWhatsAppLayout, setWhatsAppLayout } from "../device-settings.ts";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import {
  WHATSAPP_PREFIX_MAX,
  type WhatsAppChatSeen,
  type WhatsAppLinkReq,
  type WhatsAppReason,
  type WhatsAppRoute,
  type WhatsAppRouteCreateReq,
  type WhatsAppRouteDead,
  type WhatsAppRouteTrigger,
  type WhatsAppRouteUpdateReq,
  type WhatsAppStatus,
} from "../../shared/whatsapp.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { groupAgentsByRoom } from "../agent-groups.ts";
import { AgentOptions } from "../components/AgentOptions.tsx";
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
  Placeholder,
  errorText,
  flatCard,
  hintText,
  input,
} from "./kit.tsx";
import { armedConfirmLook } from "../components/dialog-styles.ts";

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

// The rows a held card draws: a bar for each chat it does not know yet.
const heldRoutes = (n: number): WhatsAppRoute[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `held-${i}`,
    chat: "",
    group: false,
    name: "",
    agentId: "",
    createdAt: 0,
  }));

export function WhatsAppSection() {
  const { t, rich } = useI18n();
  const { whatsappStatus: status } = useAppState();
  const dispatch = useDispatch();
  // A pack that gives environment at read shows the link, not its changes.
  const environmentWrite = useCan("environment", "write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [codeForm, setCodeForm] = useState(false);
  const [phone, setPhone] = useState("");
  const [held] = useState(getWhatsAppLayout);
  // Unlink ends the link; a new one needs a phone scan or code: it asks
  // first.
  const unlinkStep = useConfirmStep();

  const show = (next: WhatsAppStatus) =>
    dispatch({ type: "whatsapp_status", status: next });

  // Every status comes through the store; the rows keep their own count.
  useEffect(() => {
    if (status)
      setWhatsAppLayout({
        linked: status.state === "linked",
        rows: getWhatsAppLayout().rows,
      });
  }, [status]);

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

  // The unlinked or dead card's buttons and warning, and the linked line. A
  // held card draws the same blocks.
  const linkBlock = (state: "unlinked" | "dead") =>
    environmentWrite && (
      <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Btn
            kind="primary"
            disabled={busy}
            onClick={() => void link({ method: "qr" })}
            data-whatsapp-link=""
          >
            {state === "dead"
              ? t("integrations.whatsapp.linkAgain")
              : t("integrations.whatsapp.link")}
          </Btn>
          {state === "dead" && (
            <Btn
              disabled={busy}
              onClick={() => unlinkStep.confirm("dead", () => void unlink())}
              confirmProps={unlinkStep.bind("dead")}
              style={unlinkStep.armed === "dead" ? armedConfirmLook : undefined}
              data-whatsapp-unlink=""
            >
              {t(
                unlinkStep.armed === "dead"
                  ? "common.confirmQuestion"
                  : "integrations.whatsapp.unlink",
              )}
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
    );
  // `linked` null: a held card, with bars for the number and the connection.
  const linkedLine = (linked: { phone: string; connected: boolean } | null) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13 }}>
        {rich("integrations.whatsapp.linkedAs", {
          phone: linked ? `+${linked.phone}` : <Placeholder width="7em" />,
        })}
      </span>
      {linked ? (
        <Pill
          tone={linked.connected ? "green" : "neutral"}
          data-whatsapp-connected={String(linked.connected)}
        >
          {linked.connected
            ? t("integrations.whatsapp.connected")
            : t("integrations.whatsapp.connecting")}
        </Pill>
      ) : (
        <Pill tone="neutral">
          <Placeholder width="4em" />
        </Pill>
      )}
      {environmentWrite && (
        <Btn
          kind="danger"
          small
          disabled={busy}
          onClick={() => unlinkStep.confirm("linked", () => void unlink())}
          confirmProps={unlinkStep.bind("linked")}
          data-whatsapp-unlink=""
        >
          {t(
            unlinkStep.armed === "linked"
              ? "common.confirmQuestion"
              : "integrations.whatsapp.unlink",
          )}
        </Btn>
      )}
    </div>
  );

  return (
    <section
      data-integrations-card="whatsapp"
      data-whatsapp-state={status?.state ?? "loading"}
      style={flatCard}
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

      {(status?.state === "unlinked" || status?.state === "dead") &&
        linkBlock(status.state)}

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
          {environmentWrite && (
            <Btn
              disabled={busy}
              onClick={() => void unlink()}
              data-whatsapp-cancel=""
            >
              {t("common.cancel")}
            </Btn>
          )}
        </>
      )}

      {status?.state === "linked" && (
        <>
          {linkedLine(status)}
          <WhatsAppRows selfPhone={status.phone} />
        </>
      )}
      {!status && !error && (
        // The layout this device last saw, until the status answers.
        <Reserved dim>
          {held.linked ? (
            <>
              {linkedLine(null)}
              <WhatsAppRows holdRows={held.rows} />
            </>
          ) : (
            linkBlock("unlinked")
          )}
        </Reserved>
      )}

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

// The picker's prompt (nothing picked yet) and its "by number" choice. A
// chat id always holds "@", so neither is a chat.
const NO_CHAT = "";
const checkLabel = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--text-primary)",
  marginTop: 12,
} as const;
const BY_NUMBER = "#number";

// The contact rows of a linked member: which WhatsApp chats reach which of
// their agents. `holdRows`: a held card's copy, with that many placeholder
// rows and no reads. `selfPhone`: the linked number, whose own chat the Add
// picker lists first.
function WhatsAppRows({
  holdRows,
  selfPhone,
}: {
  holdRows?: number;
  selfPhone?: string;
}) {
  const { t } = useI18n();
  const { agents, rooms, sessionContext } = useAppState();
  const environmentWrite = useCan("environment", "write");
  const selfId = sessionContext?.userId ?? null;
  const [routes, setRoutes] = useState<WhatsAppRoute[] | null>(null);
  const [chats, setChats] = useState<WhatsAppChatSeen[]>([]);
  const [adding, setAdding] = useState(false);
  // The row the form edits, or null when it adds one.
  const [editing, setEditing] = useState<WhatsAppRoute | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [chat, setChat] = useState(NO_CHAT);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [trigger, setTrigger] = useState<WhatsAppRouteTrigger>("mention");
  const [waitForSend, setWaitForSend] = useState(true);
  const [prefix, setPrefix] = useState("");
  const [ownMessages, setOwnMessages] = useState(false);
  const [heldRows] = useState(() => getWhatsAppLayout().rows);
  // A deleted row has no Undo: Delete asks first.
  const deleteStep = useConfirmStep();

  // Agents that can reply, above Chat stop: the member's own, or any agent
  // for an office owner (task 0b53ff37).
  const isOwner = sessionContext?.role === "owner";
  const mine = agents.filter(
    (a) =>
      selfId !== null &&
      (isOwner || a.userId === selfId) &&
      agentAccessOf(a) !== "chat",
  );
  // The agent picker groups them by room (AgentOptions); the form opens on
  // its first choice.
  const agentChoices = groupAgentsByRoom(mine, rooms).flatMap((g) => g.agents);
  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? null;
  const picked = chats.find((c) => c.chat === chat) ?? null;
  const group = editing ? editing.group : (picked?.group ?? false);
  const routed = new Set(routes?.map((r) => r.chat));
  const free = chats.filter((c) => !routed.has(c.chat));
  const selfChat =
    selfPhone && !routed.has(`${selfPhone}@s.whatsapp.net`)
      ? `${selfPhone}@s.whatsapp.net`
      : null;
  const people = free.filter((c) => !c.group);
  const groups = free.filter((c) => c.group);
  const agent = mine.find((a) => a.id === agentId) ?? null;

  const load = () =>
    apiFetch<WhatsAppRoute[]>("GET", "/api/whatsapp/routes")
      .then(setRoutes)
      .catch(() => setError("integrations.whatsapp.error.failed"));
  useEffect(() => {
    if (holdRows === undefined) void load();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each answer: the next load holds this many rows.
  useEffect(() => {
    if (routes)
      setWhatsAppLayout({
        linked: getWhatsAppLayout().linked,
        rows: routes.length,
      });
  }, [routes]);

  function openForm() {
    setAdding(true);
    setEditing(null);
    setError(null);
    setChat(NO_CHAT);
    setPhone("");
    setName("");
    setAgentId(agentChoices[0]?.id ?? "");
    setTrigger("mention");
    setWaitForSend(true);
    setPrefix("");
    setOwnMessages(false);
    apiFetch<WhatsAppChatSeen[]>("GET", "/api/whatsapp/chats")
      .then(setChats)
      .catch(() => setChats([]));
  }

  // The same form on a row as it is; its chat cannot change.
  function openEdit(route: WhatsAppRoute) {
    setAdding(true);
    setEditing(route);
    setError(null);
    setName(route.name);
    setAgentId(route.agentId);
    setTrigger(route.trigger ?? "mention");
    setWaitForSend(route.sendDirect !== true);
    setPrefix(route.prefix ?? "");
    setOwnMessages(route.ownMessages === true);
  }

  function pick(next: string) {
    setChat(next);
    const ownName = `+${selfPhone}`;
    // Every message in the member's own chat is theirs.
    if (next === selfChat) {
      if (!name.trim()) setName(ownName);
      setOwnMessages(true);
      return;
    }
    // Away from the own chat: undo what its pick filled in.
    let current = name;
    if (chat === selfChat) {
      setOwnMessages(false);
      if (name === ownName) current = "";
    }
    const seen = chats.find((c) => c.chat === next);
    if (seen && !current.trim()) current = seen.name;
    setName(current);
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
    if (editing) {
      const update: WhatsAppRouteUpdateReq = {
        name,
        agentId,
        ...(group ? { trigger } : {}),
        sendDirect: !waitForSend,
        prefix,
        ownMessages,
      };
      const done = await run(() =>
        apiFetch("PATCH", `/api/whatsapp/routes/${editing.id}`, update),
      );
      if (done) {
        setAdding(false);
        setEditing(null);
      }
      return;
    }
    // A new row sends a setting only when it is not the default.
    const settings = {
      ...(waitForSend ? {} : { sendDirect: true }),
      ...(prefix.trim() ? { prefix } : {}),
      ...(ownMessages ? { ownMessages: true } : {}),
    };
    const req: WhatsAppRouteCreateReq =
      chat === BY_NUMBER
        ? { phone, name, agentId, ...settings }
        : { chat, name, agentId, ...(group ? { trigger } : {}), ...settings };
    const done = await run(
      () => apiFetch("POST", "/api/whatsapp/routes", req),
      chat === BY_NUMBER,
    );
    if (done) setAdding(false);
  }

  const ready =
    (editing !== null || chat !== NO_CHAT) &&
    name.trim() !== "" &&
    agent !== null &&
    (editing !== null || chat !== BY_NUMBER || phone.trim() !== "");

  // `held`: bars for each row's chat.
  const list = (shown: WhatsAppRoute[], held = false) => (
    <>
      {shown.length === 0 && (
        <Empty>{t("integrations.whatsapp.rows.empty")}</Empty>
      )}
      {shown.map((r) => (
        <ItemRow
          key={r.id}
          data-whatsapp-row={r.id}
          title={held ? <Placeholder /> : r.name}
          detail={
            held ? (
              <Placeholder width="10em" />
            ) : (
              [
                r.group
                  ? t("integrations.whatsapp.rows.group")
                  : (chatNumber(r.chat) ?? r.chat.split("@")[0]),
                ...(agentName(r.agentId) ? [`→ ${agentName(r.agentId)}`] : []),
                ...(r.group && r.trigger ? [t(TRIGGER[r.trigger])] : []),
              ].join(" · ")
            )
          }
          status={
            !held &&
            (r.dead || r.sendDirect) && (
              <>
                {r.sendDirect && (
                  <Pill tone="orange" data-whatsapp-row-direct="">
                    {t("integrations.whatsapp.rows.direct")}
                  </Pill>
                )}
                {r.dead && (
                  <Pill tone="red" data-whatsapp-row-dead={r.dead}>
                    {t(DEAD[r.dead])}
                  </Pill>
                )}
              </>
            )
          }
          actions={
            environmentWrite && (
              <>
                <Btn
                  small
                  disabled={busy}
                  onClick={() => openEdit(r)}
                  data-whatsapp-row-edit={r.id}
                >
                  {t("common.edit")}
                </Btn>
                <Btn
                  small
                  disabled={busy}
                  onClick={() =>
                    deleteStep.confirm(
                      r.id,
                      () =>
                        void run(() =>
                          apiFetch("DELETE", `/api/whatsapp/routes/${r.id}`),
                        ),
                    )
                  }
                  confirmProps={deleteStep.bind(r.id)}
                  style={
                    deleteStep.armed === r.id ? armedConfirmLook : undefined
                  }
                  data-whatsapp-row-delete={r.id}
                >
                  {t(
                    deleteStep.armed === r.id
                      ? "common.confirmQuestion"
                      : "common.delete",
                  )}
                </Btn>
              </>
            )
          }
        />
      ))}
    </>
  );
  const addRow = environmentWrite && (
    <AddRow label={t("integrations.whatsapp.rows.add")} onClick={openForm} />
  );

  return (
    <div data-whatsapp-rows="" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 650 }}>
        {t("integrations.whatsapp.rows.title")}
      </div>
      <p style={{ ...hintText, margin: "4px 0 8px" }}>
        {t("integrations.whatsapp.rows.hint")}
      </p>
      {holdRows !== undefined ? (
        <>
          {list(heldRoutes(holdRows), true)}
          {addRow}
        </>
      ) : routes === null ? (
        // The last row count, until the rows answer.
        !error && (
          <Reserved dim>
            {list(heldRoutes(heldRows), true)}
            {addRow}
          </Reserved>
        )
      ) : (
        list(routes)
      )}

      {adding ? (
        <form
          data-whatsapp-add-form=""
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
          style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 4 }}
        >
          {editing ? (
            <Field label={t("integrations.whatsapp.rows.chat")}>
              <span style={{ fontSize: 12.5 }}>
                {editing.group
                  ? t("integrations.whatsapp.rows.group")
                  : (chatNumber(editing.chat) ?? editing.chat.split("@")[0])}
              </span>
            </Field>
          ) : (
            <Field
              label={t("integrations.whatsapp.rows.chat")}
              hint={t("integrations.whatsapp.rows.chatHint")}
            >
              <select
                name="whatsappChat"
                value={chat}
                onChange={(e) => pick(e.target.value)}
                style={{ ...input, width: "100%" }}
              >
                <option value={NO_CHAT} disabled hidden>
                  {t("integrations.whatsapp.rows.chatPrompt")}
                </option>
                {selfChat && (
                  <option value={selfChat} data-whatsapp-myself="">
                    {t("integrations.whatsapp.rows.myself", {
                      phone: `+${selfPhone}`,
                    })}
                  </option>
                )}
                <option value={BY_NUMBER} data-whatsapp-by-number="">
                  {t("integrations.whatsapp.rows.byNumber")}
                </option>
                {(
                  [
                    ["integrations.whatsapp.rows.people", people],
                    ["integrations.whatsapp.rows.groups", groups],
                  ] as const
                ).map(
                  ([label, list]) =>
                    list.length > 0 && (
                      <optgroup key={label} label={t(label)}>
                        {list.map((c) => (
                          <option key={c.chat} value={c.chat}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                    ),
                )}
              </select>
            </Field>
          )}
          {!editing && chat === BY_NUMBER && (
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
                <AgentOptions agents={mine} rooms={rooms} />
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
          <label style={checkLabel}>
            <input
              type="checkbox"
              name="whatsappRowOwnMessages"
              checked={ownMessages}
              onChange={() => setOwnMessages(!ownMessages)}
            />
            {t("integrations.whatsapp.rows.ownMessages")}
          </label>
          {!ownMessages && (
            <p
              data-whatsapp-own-hint=""
              style={{ ...hintText, margin: "6px 0 0" }}
            >
              {t("integrations.whatsapp.rows.ownMessagesHint")}
            </p>
          )}
          <label style={checkLabel}>
            <input
              type="checkbox"
              name="whatsappRowWaitForSend"
              checked={waitForSend}
              onChange={() => setWaitForSend(!waitForSend)}
            />
            {t("integrations.whatsapp.rows.waitForSend")}
          </label>
          {!waitForSend && (
            <p
              data-whatsapp-direct-hint=""
              style={{ ...hintText, margin: "6px 0 0" }}
            >
              {t("integrations.whatsapp.rows.directHint")}
            </p>
          )}
          <Field
            label={t("integrations.whatsapp.rows.prefix")}
            hint={t("integrations.whatsapp.rows.prefixHint")}
          >
            <input
              name="whatsappRowPrefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              maxLength={WHATSAPP_PREFIX_MAX}
              style={{ ...input, width: "100%" }}
            />
          </Field>
          <FormButtons
            ready={ready}
            busy={busy}
            onCancel={() => {
              setAdding(false);
              setEditing(null);
            }}
            onSave={save}
            saveLabel={t(
              editing ? "common.save" : "integrations.whatsapp.rows.save",
            )}
          />
        </form>
      ) : (
        routes !== null && addRow
      )}

      {error && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {t(error)}
        </p>
      )}
    </div>
  );
}
