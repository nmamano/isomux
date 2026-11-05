// The Discord card of the Integrations Messaging tab (task 7fd44c30, slice
// 3): the member connects their own bots by token, adds them to servers, and
// routes a channel, a category or a whole server to one of their agents. Only
// the viewer's own. The bots come from GET /api/discord, then live from the
// discord_status event; while a read is out, the card holds the layout this
// device last saw (task eeec205a).
//
// A token lives only in the connect form's own state until its POST, and is
// cleared after it whatever the answer: never in the store, the held layout
// or a log. Each bot's servers and channels are read when the card first sees
// the bot, when the bot becomes connected, and when the route form opens.

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useCan } from "../hooks/useCan.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { Reserved } from "../components/Reserved.tsx";
import { getDiscordLayout, setDiscordLayout } from "../device-settings.ts";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import {
  DISCORD_BOTS_MAX,
  discordInviteUrl,
  type DiscordBot,
  type DiscordBotReason,
  type DiscordBotStatus,
  type DiscordChannelSeen,
  type DiscordGuildSeen,
  type DiscordReplyMode,
  type DiscordRoute,
  type DiscordRouteCreateReq,
  type DiscordRouteScope,
  type DiscordRouteTrigger,
  type DiscordRouteUpdateReq,
} from "../../shared/discord.ts";
import {
  WHATSAPP_PREFIX_MAX,
  type WhatsAppRouteDead,
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
  card,
  errorText,
  hintText,
  input,
} from "./kit.tsx";

const REASON: Record<DiscordBotReason, PlainMessageKey> = {
  token_invalid: "integrations.discord.reason.tokenInvalid",
  intent_off: "integrations.discord.reason.intentOff",
  crash_loop: "integrations.discord.reason.crashLoop",
};

const STATE: Record<DiscordBotStatus["state"], PlainMessageKey> = {
  connected: "integrations.discord.state.connected",
  connecting: "integrations.discord.state.connecting",
  dead: "integrations.discord.state.dead",
};

const STATE_TONE = {
  connected: "green",
  connecting: "neutral",
  dead: "red",
} as const;

// A refused connect, by its code; any other failure is the generic line
// (bots_max names the cap, so it is worded apart).
const CONNECT_ERROR: Record<string, PlainMessageKey> = {
  token_refused: "integrations.discord.error.tokenRefused",
  not_a_bot: "integrations.discord.error.notABot",
  check_failed: "integrations.discord.error.checkFailed",
  bot_taken: "integrations.discord.error.botTaken",
};

const DEAD: Record<WhatsAppRouteDead, PlainMessageKey> = {
  agent_gone: "integrations.whatsapp.rows.dead.agentGone",
  agent_not_yours: "integrations.whatsapp.rows.dead.agentNotYours",
  agent_chat_only: "integrations.whatsapp.rows.dead.agentChatOnly",
};

const TRIGGER: Record<DiscordRouteTrigger, PlainMessageKey> = {
  mention: "integrations.discord.routes.trigger.mention",
  all: "integrations.discord.routes.trigger.all",
};

const REPLIES: Record<DiscordReplyMode, PlainMessageKey> = {
  bot: "integrations.discord.routes.replies.bot",
  read: "integrations.discord.routes.replies.read",
  ask: "integrations.discord.routes.replies.ask",
};

const SCOPE: Record<DiscordRouteScope, PlainMessageKey> = {
  channel: "integrations.discord.routes.scope.channel",
  category: "integrations.discord.routes.scope.category",
  server: "integrations.discord.routes.scope.server",
};

const checkLabel = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--text-primary)",
  marginTop: 12,
} as const;

const linkButton = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--accent-text)",
  textDecoration: "none",
  padding: "3px 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  whiteSpace: "nowrap",
} as const;

// A bot's servers as the card last read them: undefined before the first
// answer, null when the bot is not connected yet (404).
type GuildsByBot = Record<string, DiscordGuildSeen[] | null | undefined>;

function InviteLink({ botId }: { botId: string }) {
  const { t } = useI18n();
  return (
    <a
      href={discordInviteUrl(botId)}
      target="_blank"
      rel="noreferrer"
      data-discord-invite={botId}
      style={linkButton}
    >
      {t("integrations.discord.invite")}
    </a>
  );
}

// The token form. `onCancel` absent: the form of a member with no bot, which
// stays.
function ConnectForm({
  onConnected,
  onCancel,
}: {
  onConnected: (bot: DiscordBot) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | "bots_max" | null>(null);

  async function connect() {
    const sent = token;
    setToken("");
    setBusy(true);
    setError(null);
    try {
      onConnected(
        await apiFetch<DiscordBot>("POST", "/api/discord/bots", {
          token: sent,
        }),
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "bots_max"
          ? "bots_max"
          : (CONNECT_ERROR[code] ?? "integrations.whatsapp.error.failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-discord-connect-form=""
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim() && !busy) void connect();
      }}
      style={{ marginTop: 4 }}
    >
      <Field
        label={t("integrations.discord.token")}
        hint={t("integrations.discord.steps")}
      >
        <input
          type="password"
          name="discordToken"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ ...input, width: "100%" }}
        />
      </Field>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 10,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {onCancel && (
          <Btn
            disabled={busy}
            onClick={() => {
              setToken("");
              onCancel();
            }}
            data-discord-connect-cancel=""
          >
            {t("common.cancel")}
          </Btn>
        )}
        <Btn
          kind="primary"
          disabled={busy || !token.trim()}
          onClick={() => void connect()}
          data-discord-connect=""
        >
          {t("integrations.discord.connect")}
        </Btn>
      </div>
      {error && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {error === "bots_max"
            ? t("integrations.discord.error.botsMax", { max: DISCORD_BOTS_MAX })
            : t(error)}
        </p>
      )}
    </form>
  );
}

export function DiscordSection() {
  const { t } = useI18n();
  const { discordBots: bots } = useAppState();
  const dispatch = useDispatch();
  const environmentWrite = useCan("environment", "write");
  const [routes, setRoutes] = useState<DiscordRoute[] | null>(null);
  // The routes read failed: no held rows wait for it.
  const [routesFailed, setRoutesFailed] = useState(false);
  const [guilds, setGuilds] = useState<GuildsByBot>({});
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  // The token form behind the Add or a Connect again.
  const [connectOpen, setConnectOpen] = useState(false);
  const [held] = useState(getDiscordLayout);
  // The state each bot had when the card last looked: a read on a new bot
  // and on a move to connected.
  const seen = useRef(new Map<string, DiscordBotStatus["state"]>());

  const show = (next: DiscordBot[]) =>
    dispatch({ type: "discord_status", bots: next });

  const readGuilds = (botId: string) =>
    apiFetch<DiscordGuildSeen[]>("GET", `/api/discord/bots/${botId}/guilds`)
      .then((list) => setGuilds((g) => ({ ...g, [botId]: list })))
      .catch(() => setGuilds((g) => ({ ...g, [botId]: null })));

  const loadRoutes = () =>
    apiFetch<DiscordRoute[]>("GET", "/api/discord/routes")
      .then((list) => {
        setRoutes(list);
        setRoutesFailed(false);
      })
      .catch(() => {
        setRoutesFailed(true);
        setError("integrations.whatsapp.error.failed");
      });

  useEffect(() => {
    apiFetch<DiscordBot[]>("GET", "/api/discord")
      .then(show)
      .catch(() => setError("integrations.whatsapp.error.failed"));
    void loadRoutes();
    // Once, on mount; the event keeps the bots current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bots) return;
    for (const b of bots) {
      const before = seen.current.get(b.id);
      if (
        before === undefined ||
        (before !== "connected" && b.status.state === "connected")
      )
        void readGuilds(b.id);
      seen.current.set(b.id, b.status.state);
    }
  }, [bots]);

  // Each answer: the next load holds this many bots and routes.
  useEffect(() => {
    if (bots && routes)
      setDiscordLayout({
        bots: bots.length,
        rows: bots.length ? routes.length : 0,
      });
  }, [bots, routes]);

  function connected(bot: DiscordBot) {
    const list = bots ?? [];
    show(
      list.some((b) => b.id === bot.id)
        ? list.map((b) => (b.id === bot.id ? bot : b))
        : [...list, bot],
    );
    setConnectOpen(false);
  }

  async function disconnect(botId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("DELETE", `/api/discord/bots/${botId}`);
      show((bots ?? []).filter((b) => b.id !== botId));
      // The server removed the bot's routes with it.
      setRoutes((rs) => rs?.filter((r) => r.botId !== botId) ?? rs);
    } catch {
      setError("integrations.whatsapp.error.failed");
    } finally {
      setBusy(false);
    }
  }

  const botRow = (b: DiscordBot | null, i: number) => (
    <ItemRow
      key={b?.id ?? `held-${i}`}
      data-discord-bot={b?.id ?? `held-${i}`}
      title={b ? b.name : <Placeholder />}
      status={
        b ? (
          <Pill
            tone={STATE_TONE[b.status.state]}
            data-discord-bot-state={b.status.state}
          >
            {t(STATE[b.status.state])}
          </Pill>
        ) : (
          <Pill tone="neutral">
            <Placeholder width="4em" />
          </Pill>
        )
      }
      actions={
        environmentWrite && (
          <>
            {b && b.status.state !== "dead" && <InviteLink botId={b.id} />}
            {b?.status.state === "dead" && (
              <Btn
                small
                disabled={busy}
                onClick={() => setConnectOpen(true)}
                data-discord-reconnect={b.id}
              >
                {t("integrations.discord.reconnect")}
              </Btn>
            )}
            <Btn
              kind="danger"
              small
              disabled={busy || !b}
              onClick={() => b && void disconnect(b.id)}
              {...(b ? { "data-discord-disconnect": b.id } : {})}
            >
              {t("integrations.discord.disconnect")}
            </Btn>
          </>
        )
      }
    >
      {b?.status.state === "dead" && (
        <p
          data-discord-bot-reason={b.status.reason}
          style={{
            ...hintText,
            color: "var(--orange-text)",
            margin: "6px 0 0",
          }}
        >
          {t(REASON[b.status.reason])}
        </p>
      )}
    </ItemRow>
  );

  const connectBlock = (list: DiscordBot[]) =>
    environmentWrite &&
    (list.length === 0 ? (
      <ConnectForm onConnected={connected} />
    ) : connectOpen ? (
      <ConnectForm
        onConnected={connected}
        onCancel={() => setConnectOpen(false)}
      />
    ) : (
      list.length < DISCORD_BOTS_MAX && (
        <AddRow
          label={t("integrations.discord.connectAnother")}
          onClick={() => setConnectOpen(true)}
        />
      )
    ));

  return (
    <section
      data-integrations-card="discord"
      style={{ ...card, marginTop: 16 }}
      aria-busy={!bots && !error}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "0 0 12px",
        }}
      >
        <Logo label="Discord" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Discord</span>
      </div>

      {bots && (
        <>
          {bots.map((b, i) => botRow(b, i))}
          {connectBlock(bots)}
          {bots.length > 0 && (
            <DiscordRoutes
              bots={bots}
              routes={routes}
              failed={routesFailed}
              guilds={guilds}
              heldRows={held.rows}
              onOpen={() => bots.forEach((b) => void readGuilds(b.id))}
              reload={loadRoutes}
            />
          )}
        </>
      )}
      {!bots && !error && (
        // The layout this device last saw, until the bots answer.
        <Reserved dim>
          {held.bots > 0 ? (
            <>
              {Array.from({ length: held.bots }, (_, i) => botRow(null, i))}
              <DiscordRoutes
                bots={[]}
                routes={null}
                failed={false}
                guilds={{}}
                heldRows={held.rows}
                onOpen={() => {}}
                reload={async () => {}}
              />
            </>
          ) : (
            connectBlock([])
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

// "#general", "Category Talk", "Whole server": where a route listens, from
// its bot's servers; null when the bot does not know the place.
function usePlaceName() {
  const { t } = useI18n();
  return (route: DiscordRoute, guild: DiscordGuildSeen | undefined) => {
    if (!guild) return null;
    if (route.scope === "server") return t(SCOPE.server);
    const c = guild.channels.find((x) => x.id === route.targetId);
    if (!c) return null;
    return route.scope === "category"
      ? t("integrations.discord.routes.inCategory", { name: c.name })
      : `#${c.name}`;
  };
}

const heldRoute = (i: number): DiscordRoute => ({
  id: `held-${i}`,
  botId: "",
  guildId: "",
  scope: "channel",
  targetId: "",
  name: "",
  agentId: "",
  trigger: "mention",
  replyMode: "bot",
  createdAt: 0,
});

// The routes of the member's bots. `routes` null: held rows until they
// answer, or nothing when their read `failed`.
function DiscordRoutes({
  bots,
  routes,
  failed,
  guilds,
  heldRows,
  onOpen,
  reload,
}: {
  bots: DiscordBot[];
  routes: DiscordRoute[] | null;
  failed: boolean;
  guilds: GuildsByBot;
  heldRows: number;
  onOpen: () => void;
  reload: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { agents } = useAppState();
  const environmentWrite = useCan("environment", "write");
  const placeName = usePlaceName();
  // The form: closed, a new route, or the route it edits.
  const [form, setForm] = useState<"closed" | "add" | DiscordRoute>("closed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);

  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? null;
  const guildOf = (r: DiscordRoute) =>
    guilds[r.botId]?.find((g) => g.id === r.guildId);

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("DELETE", `/api/discord/routes/${id}`);
      await reload();
    } catch {
      setError("integrations.whatsapp.error.failed");
    } finally {
      setBusy(false);
    }
  }

  const open = (next: "add" | DiscordRoute) => {
    setError(null);
    setForm(next);
    onOpen();
  };

  const list = (shown: DiscordRoute[], held = false) => (
    <>
      {shown.length === 0 && (
        <Empty>{t("integrations.discord.routes.empty")}</Empty>
      )}
      {shown.map((r) => {
        const guild = guildOf(r);
        const place = placeName(r, guild);
        const agent = agentName(r.agentId);
        return (
          <ItemRow
            key={r.id}
            data-discord-route={r.id}
            title={held ? <Placeholder /> : r.name}
            detail={
              held ? (
                <Placeholder width="10em" />
              ) : (
                [
                  ...(place ? [place] : []),
                  ...(guild ? [guild.name] : []),
                  ...(agent ? [`→ ${agent}`] : []),
                  t(TRIGGER[r.trigger]),
                ].join(" · ")
              )
            }
            status={
              !held &&
              (r.dead || r.replyMode !== "ask") && (
                <>
                  {r.replyMode !== "ask" && (
                    <Pill tone="orange" data-discord-route-mode={r.replyMode}>
                      {r.replyMode === "read"
                        ? t(REPLIES.read)
                        : t("integrations.whatsapp.rows.direct")}
                    </Pill>
                  )}
                  {r.dead && (
                    <Pill tone="red" data-discord-route-dead={r.dead}>
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
                    disabled={busy || held}
                    onClick={() => open(r)}
                    {...(held ? {} : { "data-discord-route-edit": r.id })}
                  >
                    {t("common.edit")}
                  </Btn>
                  <Btn
                    small
                    disabled={busy || held}
                    onClick={() => void remove(r.id)}
                    {...(held ? {} : { "data-discord-route-delete": r.id })}
                  >
                    {t("common.delete")}
                  </Btn>
                </>
              )
            }
          />
        );
      })}
    </>
  );
  const addRow = environmentWrite && (
    <AddRow
      label={t("integrations.discord.routes.add")}
      onClick={() => open("add")}
    />
  );
  const heldList = Array.from({ length: heldRows }, (_, i) => heldRoute(i));

  return (
    <div data-discord-routes="" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 650 }}>
        {t("integrations.discord.routes.title")}
      </div>
      <p style={{ ...hintText, margin: "4px 0 8px" }}>
        {t("integrations.discord.routes.hint")}
      </p>
      {routes === null
        ? !failed && (
            <Reserved dim>
              {list(heldList, true)}
              {addRow}
            </Reserved>
          )
        : list(routes)}
      {form !== "closed" && routes !== null ? (
        <RouteForm
          key={form === "add" ? "add" : form.id}
          editing={form === "add" ? null : form}
          bots={bots}
          routes={routes}
          guilds={guilds}
          onDone={async () => {
            await reload();
            setForm("closed");
          }}
          onCancel={() => setForm("closed")}
        />
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

const NONE = "";

// The Add form, or the Edit form of `editing`, whose bot, server and place
// are fixed.
function RouteForm({
  editing,
  bots,
  routes,
  guilds,
  onDone,
  onCancel,
}: {
  editing: DiscordRoute | null;
  bots: DiscordBot[];
  routes: DiscordRoute[];
  guilds: GuildsByBot;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { agents, rooms, sessionContext } = useAppState();
  const placeName = usePlaceName();
  const selfId = sessionContext?.userId ?? null;
  // Agents that can reply: the member's own, above Chat stop.
  const mine = agents.filter(
    (a) =>
      selfId !== null && a.userId === selfId && agentAccessOf(a) !== "chat",
  );
  const firstAgent =
    groupAgentsByRoom(mine, rooms).flatMap((g) => g.agents)[0]?.id ?? NONE;

  const [botId, setBotId] = useState(editing?.botId ?? bots[0]?.id ?? NONE);
  const [guildId, setGuildId] = useState(editing?.guildId ?? NONE);
  const [scope, setScope] = useState<DiscordRouteScope>(
    editing?.scope ?? "channel",
  );
  const [targetId, setTargetId] = useState(editing?.targetId ?? NONE);
  const [name, setName] = useState(editing?.name ?? "");
  // The name the last pick filled in: a later pick may replace it.
  const [autoName, setAutoName] = useState("");
  const [agentId, setAgentId] = useState(editing?.agentId ?? firstAgent);
  const [trigger, setTrigger] = useState<DiscordRouteTrigger>(
    editing?.trigger ?? "mention",
  );
  const [replyMode, setReplyMode] = useState<DiscordReplyMode>(
    editing?.replyMode ?? "ask",
  );
  const [prefix, setPrefix] = useState(editing?.prefix ?? "");
  const [includeBots, setIncludeBots] = useState(editing?.includeBots === true);
  const [react, setReact] = useState(editing?.react === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);

  const seen = guilds[botId];
  const guild = seen?.find((g) => g.id === guildId);
  const agent = mine.find((a) => a.id === agentId) ?? null;
  // The places of this bot that have a route already.
  const routed = new Set(
    routes
      .filter((r) => r.botId === botId && r.scope === scope)
      .map((r) => r.targetId),
  );
  const places: DiscordChannelSeen[] = (guild?.channels ?? []).filter(
    (c) =>
      !routed.has(c.id) &&
      (scope === "category"
        ? c.kind === "category"
        : c.kind === "text" || c.kind === "forum"),
  );
  const categories = (guild?.channels ?? []).filter(
    (c) => c.kind === "category",
  );

  const fill = (next: string) => {
    if (name.trim() === "" || name === autoName) setName(next);
    setAutoName(next);
  };
  const pickBot = (next: string) => {
    setBotId(next);
    setGuildId(NONE);
    setTargetId(NONE);
  };
  // A server takes one route per bot.
  const serverRouted = (guild: string) =>
    routes.some(
      (r) => r.botId === botId && r.scope === "server" && r.guildId === guild,
    );
  const pickGuild = (next: string) => {
    setGuildId(next);
    setTargetId(NONE);
    if (scope !== "server") return;
    // Whole server on a server that has its route: back to a channel.
    if (serverRouted(next)) setScope("channel");
    else fill(seen?.find((g) => g.id === next)?.name ?? "");
  };
  const pickScope = (next: DiscordRouteScope) => {
    setScope(next);
    setTargetId(NONE);
    if (next === "server" && guild) fill(guild.name);
  };
  const pickTarget = (next: string) => {
    setTargetId(next);
    fill(guild?.channels.find((c) => c.id === next)?.name ?? "");
  };

  const placed =
    editing !== null ||
    (guild !== undefined && (scope === "server" || targetId !== NONE));
  const ready = placed && name.trim() !== "" && agent !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const update: DiscordRouteUpdateReq = {
          name,
          agentId,
          trigger,
          replyMode,
          prefix,
          includeBots,
          react,
        };
        await apiFetch("PATCH", `/api/discord/routes/${editing.id}`, update);
      } else {
        // A new route sends a setting only when it is not the default.
        const req: DiscordRouteCreateReq = {
          botId,
          guildId,
          scope,
          targetId: scope === "server" ? guildId : targetId,
          name,
          agentId,
          ...(trigger !== "mention" ? { trigger } : {}),
          ...(replyMode !== "ask" ? { replyMode } : {}),
          ...(prefix.trim() ? { prefix } : {}),
          ...(includeBots ? { includeBots: true } : {}),
          ...(react ? { react: true } : {}),
        };
        await apiFetch("POST", "/api/discord/routes", req);
      }
      await onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.status : 0;
      setError(
        code === 409
          ? "integrations.discord.routes.error.taken"
          : "integrations.whatsapp.error.failed",
      );
    } finally {
      setBusy(false);
    }
  }

  // Where the new route listens: the bot, the server and the place.
  const where = editing ? (
    <Field label={t("integrations.discord.routes.scope")}>
      <span style={{ fontSize: 12.5 }}>
        {[
          placeName(
            editing,
            guilds[editing.botId]?.find((g) => g.id === editing.guildId),
          ) ?? editing.name,
          guilds[editing.botId]?.find((g) => g.id === editing.guildId)?.name,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </Field>
  ) : (
    <>
      {bots.length > 1 && (
        <Field label={t("integrations.discord.routes.bot")}>
          <select
            name="discordRouteBot"
            value={botId}
            onChange={(e) => pickBot(e.target.value)}
            style={{ ...input, width: "100%" }}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {seen === null ? (
        <p
          data-discord-not-connected=""
          style={{ ...hintText, margin: "12px 0 0" }}
        >
          {t("integrations.discord.routes.notConnected")}
        </p>
      ) : seen && seen.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 12,
          }}
        >
          <span style={hintText}>
            {t("integrations.discord.routes.noGuild")}
          </span>
          <InviteLink botId={botId} />
        </div>
      ) : (
        seen && (
          <>
            <Field label={t("integrations.discord.routes.guild")}>
              <select
                name="discordRouteGuild"
                value={guildId}
                onChange={(e) => pickGuild(e.target.value)}
                style={{ ...input, width: "100%" }}
              >
                <option value={NONE} disabled>
                  {t("integrations.discord.routes.guildPrompt")}
                </option>
                {seen.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            {guild && (
              <Field label={t("integrations.discord.routes.scope")}>
                <div data-discord-route-scope="">
                  <Choice
                    label={t("integrations.discord.routes.scope")}
                    value={scope}
                    onChange={pickScope}
                    options={(["channel", "category", "server"] as const)
                      .filter((v) => v !== "server" || !serverRouted(guildId))
                      .map((v) => ({ value: v, label: t(SCOPE[v]) }))}
                  />
                </div>
              </Field>
            )}
            {guild && scope !== "server" && (
              <Field label={t(SCOPE[scope])}>
                <select
                  name="discordRouteTarget"
                  value={targetId}
                  onChange={(e) => pickTarget(e.target.value)}
                  style={{ ...input, width: "100%" }}
                >
                  <option value={NONE} disabled>
                    {t(
                      scope === "category"
                        ? "integrations.discord.routes.categoryPrompt"
                        : "integrations.discord.routes.channelPrompt",
                    )}
                  </option>
                  {scope === "category"
                    ? places.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    : [null, ...categories].map((cat) => {
                        const inside = places.filter(
                          (c) => c.parentId === (cat?.id ?? null),
                        );
                        return (
                          inside.length > 0 && (
                            <optgroup
                              key={cat?.id ?? "none"}
                              label={
                                cat?.name ??
                                t("integrations.discord.routes.noCategory")
                              }
                            >
                              {inside.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.kind === "forum"
                                    ? t("integrations.discord.routes.forum", {
                                        name: c.name,
                                      })
                                    : c.name}
                                </option>
                              ))}
                            </optgroup>
                          )
                        );
                      })}
                </select>
              </Field>
            )}
          </>
        )
      )}
    </>
  );

  return (
    <form
      data-discord-route-form=""
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
      style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 4 }}
    >
      {where}
      <Field
        label={t("integrations.whatsapp.rows.name")}
        hint={t("integrations.whatsapp.rows.nameHint")}
      >
        <input
          name="discordRouteName"
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
            name="discordRouteAgent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{ ...input, width: "100%" }}
          >
            <AgentOptions agents={mine} rooms={rooms} />
          </select>
        )}
      </Field>
      {agent && !belowStandard(agentAccessOf(agent)) && (
        <p
          data-discord-shell-warning=""
          style={{
            ...hintText,
            color: "var(--orange-text)",
            margin: "10px 0 0",
          }}
        >
          {t("integrations.discord.routes.shellWarning")}
        </p>
      )}
      <Field label={t("integrations.discord.routes.trigger")}>
        <div data-discord-route-trigger="">
          <Choice
            label={t("integrations.discord.routes.trigger")}
            value={trigger}
            onChange={setTrigger}
            options={(["mention", "all"] as const).map((v) => ({
              value: v,
              label: t(TRIGGER[v]),
            }))}
          />
        </div>
      </Field>
      <Field label={t("integrations.discord.routes.replies")}>
        <div data-discord-route-replies="">
          <Choice
            label={t("integrations.discord.routes.replies")}
            value={replyMode}
            onChange={setReplyMode}
            options={(["bot", "read", "ask"] as const).map((v) => ({
              value: v,
              label: t(REPLIES[v]),
            }))}
          />
        </div>
      </Field>
      <Field
        label={t("integrations.whatsapp.rows.prefix")}
        hint={t("integrations.discord.routes.prefixHint")}
      >
        <input
          name="discordRoutePrefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          maxLength={WHATSAPP_PREFIX_MAX}
          style={{ ...input, width: "100%" }}
        />
      </Field>
      <label style={checkLabel}>
        <input
          type="checkbox"
          name="discordRouteIncludeBots"
          checked={includeBots}
          onChange={() => setIncludeBots(!includeBots)}
        />
        {t("integrations.discord.routes.includeBots")}
      </label>
      <label style={checkLabel}>
        <input
          type="checkbox"
          name="discordRouteReact"
          checked={react}
          onChange={() => setReact(!react)}
        />
        {t("integrations.discord.routes.react")}
      </label>
      <FormButtons
        ready={ready}
        busy={busy}
        onCancel={onCancel}
        onSave={save}
        saveLabel={t(
          editing ? "common.save" : "integrations.discord.routes.save",
        )}
      />
      {error && (
        <p role="alert" style={{ ...errorText, margin: "10px 0 0" }}>
          {t(error)}
        </p>
      )}
    </form>
  );
}
