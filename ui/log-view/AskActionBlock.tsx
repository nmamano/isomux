// The action of an action ask (task e3d1bc63): its target, the value now,
// read live from the office state, and the value asked for, with what that
// value gives. Apply runs it as the member (POST /api/asks/:askId/action). A
// refusal shows here and the ask stays open; the server closes the ask when
// the state reaches the value, by Apply or by hand, so after a run Apply
// stays off until the card goes.
//
// Kinds: an agent's access stop (agent-access), one room of a member's room
// access (member-room), a member's role (member-role) and permission pack
// (member-pack), the member's own preferences (member-preferences) and room
// lists (member-view), and the office and backup settings (office-settings,
// backup-settings). A kind that sets several keys draws one row per key.
// Part 4: a member's sign-in link (sign-in-link), their sign-out on every
// device (member-sessions), their unused links taken back
// (sign-in-links-revoke), one session ended (session-revoke, task 43b67f3a),
// a personal API token (api-token), a token revoked
// (api-token-revoke) and the office's outside access (office-access). A link
// or token the Apply makes goes to the store's askResults, which outlive this
// card: the ask closes as it is made, often before the Apply answers.
// Part 5: a member's removal (member-remove), restore (member-restore) and
// delete for good (member-purge), the office update (office-update), and the
// storage prune and compress (storage-prune, storage-compress), whose results
// go to askResults too.
// Task 0b53ff37: one of the member's WhatsApp chats routed to an agent
// (whatsapp-route). The agent names the chat by a part of its name; the
// member picks one of their chats that match, and Apply sends it.
// Task 386ec4d6: one place of the member's Discord bots routed to an agent
// (discord-route), the same way: the member picks one of the channels,
// categories and servers whose name matches.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch, type AskResult } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import {
  chatNameMatches,
  type WhatsAppChatSeen,
  type WhatsAppRoute,
} from "../../shared/whatsapp.ts";
import {
  discordPlacesMatching,
  type DiscordBotListed,
  type DiscordGuildSeen,
  type DiscordPlace,
  type DiscordReplyMode,
  type DiscordRoute,
  type DiscordRouteTrigger,
} from "../../shared/discord.ts";
import type { ActionStepRequest } from "../../shared/types.ts";
import type { MemberViewList } from "../../shared/action-steps.ts";
import {
  roomViewLevel,
  type RoomViewLevel,
} from "../../shared/room-view-level.ts";
import type {
  AccessSettings,
  AccessibleRoomWire,
  ApiTokenListRes,
  BackupStatusWire,
  CompressResultWire,
  PrunePlanWire,
  PruneResultWire,
  RemovedMemberListRes,
} from "../../shared/contract-shapes.ts";
import { categoryLabel, sizeText } from "../components/StoragePane.tsx";
import { formatSince } from "../components/access-shared.tsx";
import type { InviteWire, SessionWire } from "../../shared/types.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { accessSummary, roomsSummary } from "../components/ApiTokensPane.tsx";
import { SUPPORTED_LANGUAGES } from "../../shared/languages.ts";
import { DEFAULT_VOICE_NAME } from "../../shared/voice.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { AREA_LABEL as PACK_AREA_LABEL } from "../components/AreaLevelsGrid.tsx";
import {
  LEVEL_LABEL,
  STOP_HINT,
  STOP_LABEL,
} from "../components/AccessSlider.tsx";
import {
  LEVEL_MEANING,
  LEVEL_NAME,
} from "../components/RoomViewLevelControl.tsx";

type Step<K extends ActionStepRequest["kind"]> = Extract<
  ActionStepRequest,
  { kind: K }
>;

interface Value {
  value: string;
  label: string;
}

// One key of a kind that sets several: its label, the value now (undefined
// until it is read) and asked for, and what the setting does.
interface Row {
  key: string;
  label: string;
  current?: Value;
  requested: Value;
  hint?: string;
}

// What a kind draws: the target's name, the value now (undefined when the
// state does not hold it), the value asked for or one row per key, the lines
// under them, the data-* marks, and whether the target is gone. `loading`:
// the value now is still being read, so a placeholder holds its place.
interface ActionView {
  name: string;
  current?: Value;
  loading?: boolean;
  requested?: Value;
  rows?: Row[];
  lines: ReactNode[];
  marks: Record<string, string>;
  gone: string | null;
  // No Apply: the viewer is not the member who can run it.
  noApply?: boolean;
  // Apply waits for a choice on the card.
  waiting?: boolean;
}

// A chat a whatsapp-route step may route: its name as the bridge saw it (else
// the row's), and its row when it has one.
interface WhatsAppCandidate {
  chat: string;
  name: string;
  group: boolean;
  row?: WhatsAppRoute;
}

// The member's chats that match the step's name: those the bridge saw, and
// those with a row, matched by the seen name or the row's name (the server's
// rule, step-asks.ts).
export function whatsappCandidates(
  chatName: string,
  seen: readonly WhatsAppChatSeen[],
  rows: readonly WhatsAppRoute[],
): WhatsAppCandidate[] {
  const out = new Map<string, WhatsAppCandidate>();
  for (const c of seen)
    if (chatNameMatches(c.name, chatName))
      out.set(c.chat, { chat: c.chat, name: c.name, group: c.group });
  for (const row of rows) {
    const seenName = seen.find((c) => c.chat === row.chat)?.name;
    if (
      chatNameMatches(row.name, chatName) ||
      (seenName !== undefined && chatNameMatches(seenName, chatName))
    )
      out.set(row.chat, {
        chat: row.chat,
        name: seenName ?? row.name,
        group: row.group,
      });
  }
  return [...out.values()].map((c) => {
    const row = rows.find((r) => r.chat === c.chat);
    return row ? { ...c, row } : c;
  });
}

// A Discord place as one key: its bot, scope and target.
const placeKey = (p: { botId: string; scope: string; targetId: string }) =>
  `${p.botId}:${p.scope}:${p.targetId}`;

// The labels of the settings an office-settings step sets, with the page's
// hint for each switch that changes what agents or members get.
const OFFICE_LABEL: Record<string, PlainMessageKey> = {
  name: "settings.office.name",
  memberUsageCap: "settings.office.memberUsageCap",
  memberUsageShare: "settings.office.memberUsageShare",
  recordTerminals: "audit.recordTerminals",
  providerFallback: "settings.office.providerFallback",
  processIsolation: "settings.office.processIsolation",
  claudeIsomuxLabel: "settings.office.claudeIsomuxLabel",
};
const OFFICE_HINT: Record<string, PlainMessageKey> = {
  memberUsageCap: "settings.office.memberUsageCapHint",
  recordTerminals: "audit.recordTerminalsHint",
  providerFallback: "settings.office.providerFallbackHint",
  processIsolation: "settings.office.processIsolationHint",
  claudeIsomuxLabel: "settings.office.claudeIsomuxLabelHint",
};
const PREFERENCE_LABEL: Record<string, PlainMessageKey> = {
  language: "settings.sidebar.language",
  voiceInput: "integrations.voice.mic",
  voiceOutput: "integrations.voice.readAloud",
  voiceName: "integrations.voice.voiceName",
};
const BACKUP_LABEL: Record<string, PlainMessageKey> = {
  intervalHours: "settings.storage.backupInterval",
  retention: "settings.storage.backupCopies",
  dir: "settings.storage.backupFolder",
};
// The room's view level after a member-view step, from the level now
// (undefined when the member's lists are not known) and whether the room
// keeps its tucked flag. It mirrors clampViewFields and viewRefusal on the
// server: a step the server refuses (sound or push for a hidden or tucked
// room) shows the level it asks for.
function levelAfterView(
  list: MemberViewList,
  on: boolean,
  now: RoomViewLevel | undefined,
  keepsTucked: boolean,
): RoomViewLevel {
  switch (list) {
    case "shown":
      if (!on) return "hidden";
      if (now === undefined || now === "hidden")
        return keepsTucked ? "tucked" : "shown";
      return now;
    case "tucked":
      if (on) return now === "hidden" ? "hidden" : "tucked";
      return now === undefined || now === "tucked" ? "shown" : now;
    case "notif":
      if (on) return now === "push" ? "push" : "notify";
      return now === undefined || now === "notify" || now === "push"
        ? "shown"
        : now;
    case "push":
      if (on) return "push";
      return now === undefined || now === "push" ? "notify" : now;
  }
}

export function AskActionBlock({
  askId,
  askingAgentId,
  memberUserId,
  step,
  isMobile,
}: {
  askId: string;
  askingAgentId: string;
  // The member the ask is for.
  memberUserId?: string;
  step: ActionStepRequest;
  isMobile: boolean;
}) {
  const i18n = useI18n();
  const { t, tn, language } = i18n;
  const {
    agents,
    users,
    rooms,
    allRooms,
    office,
    activeSessions,
    activeSessionsLoaded,
    sessionContext,
    invitesList,
    invitesLoaded,
    updateInfo,
  } = useAppState();
  const dispatch = useDispatch();
  // A member's tokens: the member's own list, or an owner's view of another
  // member's (null until the member list names them).
  function tokensPath(userId: string): string | null {
    if (userId === memberUserId) return "/api/me/api-tokens";
    const owner = [...users.values()].find((u) => u.id === userId);
    return owner
      ? `/api/users/${encodeURIComponent(owner.name)}/api-tokens`
      : null;
  }
  // The settings the state does not carry, read when the card shows: the
  // office settings (again on each office settings change), the backup
  // settings, the member's rooms, hidden ones included, the access settings,
  // and the tokens of a token's owner.
  const read =
    step.kind === "office-settings"
      ? "/api/office/settings"
      : step.kind === "backup-settings"
        ? "/api/backup/status"
        : step.kind === "member-view"
          ? "/api/me/rooms"
          : step.kind === "office-access"
            ? "/api/office/access"
            : step.kind === "api-token-revoke"
              ? tokensPath(step.userId)
              : step.kind === "member-restore" || step.kind === "member-purge"
                ? "/api/removed-members"
                : step.kind === "office-update"
                  ? "/api/office/update"
                  : null;
  const [fetched, setFetched] = useState<unknown>(undefined);
  // A whatsapp-route step reads the chats and rows of the viewer, so only the
  // member the ask is for reads them: another viewer (an owner) would see
  // their own chats.
  const viewerId = sessionContext?.userId ?? null;
  const waMember =
    step.kind === "whatsapp-route" &&
    !!memberUserId &&
    viewerId === memberUserId;
  const [waChats, setWaChats] = useState<WhatsAppChatSeen[] | null>(null);
  const [waRows, setWaRows] = useState<WhatsAppRoute[] | null>(null);
  const [waPick, setWaPick] = useState<string | null>(null);
  useEffect(() => {
    if (!waMember) return;
    let live = true;
    void Promise.allSettled([
      apiFetch<WhatsAppChatSeen[]>("GET", "/api/whatsapp/chats"),
      apiFetch<WhatsAppRoute[]>("GET", "/api/whatsapp/routes"),
    ]).then(([chats, rows]) => {
      if (!live) return;
      setWaChats(chats.status === "fulfilled" ? chats.value : []);
      setWaRows(rows.status === "fulfilled" ? rows.value : []);
    });
    return () => {
      live = false;
    };
  }, [waMember]);
  const waCandidates =
    step.kind === "whatsapp-route" && waChats && waRows
      ? whatsappCandidates(step.chatName, waChats, waRows)
      : [];
  // One match is picked for the member; several wait for their choice.
  const waChosen =
    waPick !== null && waCandidates.some((c) => c.chat === waPick)
      ? waPick
      : waCandidates.length === 1
        ? waCandidates[0].chat
        : null;
  // A discord-route step reads the viewer's bots, the servers each bot sees
  // and their routes, so only the member the ask is for reads them, as for
  // WhatsApp.
  const dcMember =
    step.kind === "discord-route" &&
    !!memberUserId &&
    viewerId === memberUserId;
  const [dcBots, setDcBots] = useState<
    { botId: string; name: string; guilds: DiscordGuildSeen[] }[] | null
  >(null);
  const [dcRoutes, setDcRoutes] = useState<DiscordRoute[]>([]);
  const [dcPick, setDcPick] = useState<string | null>(null);
  useEffect(() => {
    if (!dcMember) return;
    let live = true;
    void Promise.allSettled([
      apiFetch<DiscordBotListed[]>("GET", "/api/discord"),
      apiFetch<DiscordRoute[]>("GET", "/api/discord/routes"),
    ]).then(async ([listed, routes]) => {
      const bots = listed.status === "fulfilled" ? listed.value : [];
      // A bot that is not connected yet (404) sees no server.
      const seen = await Promise.allSettled(
        bots.map((b) =>
          apiFetch<DiscordGuildSeen[]>(
            "GET",
            `/api/discord/bots/${encodeURIComponent(b.id)}/guilds`,
          ),
        ),
      );
      if (!live) return;
      setDcRoutes(routes.status === "fulfilled" ? routes.value : []);
      setDcBots(
        bots.map((b, i) => {
          const res = seen[i];
          return {
            botId: b.id,
            name: b.name,
            guilds: res.status === "fulfilled" ? res.value : [],
          };
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [dcMember]);
  const dcPlaces =
    step.kind === "discord-route" && dcBots
      ? discordPlacesMatching(step.placeName, step.scope, dcBots)
      : [];
  const dcChosen =
    (dcPick !== null && dcPlaces.find((p) => placeKey(p) === dcPick)) ||
    (dcPlaces.length === 1 ? dcPlaces[0] : null);
  useEffect(() => {
    if (!read) return;
    let live = true;
    apiFetch("GET", read)
      .then((res) => {
        if (live) setFetched(res);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [read, office]);
  // A sign-out or a links revoke counts the member's sessions or links from
  // the lists the office keeps live; seeded here when no page has yet. Keyed
  // on sessionContext too: see useAccessListsSeed.
  const needs =
    step.kind === "member-sessions" || step.kind === "session-revoke"
      ? "sessions"
      : step.kind === "sign-in-links-revoke"
        ? "invites"
        : null;
  useEffect(() => {
    if (needs === "sessions" && !activeSessionsLoaded)
      apiFetch<{ sessions: SessionWire[] }>("GET", "/api/sessions")
        .then((r) =>
          dispatch({ type: "sessions_active_list", sessions: r.sessions }),
        )
        .catch(() => {});
    if (needs === "invites" && !invitesLoaded)
      apiFetch<{ invites: InviteWire[] }>("GET", "/api/invites")
        .then((r) => dispatch({ type: "invites_list", invites: r.invites }))
        .catch(() => {});
  }, [needs, activeSessionsLoaded, invitesLoaded, sessionContext, dispatch]);
  // "confirming" after a first click that asks again, "running" while a POST
  // is out, "ran" after the run's 2xx.
  const [phase, setPhase] = useState<"idle" | "confirming" | "running" | "ran">(
    "idle",
  );
  // A prune's dry run, from its first click.
  const [preview, setPreview] = useState<PrunePlanWire | null>(null);
  // Nil's UI rule (AGENTS.md, 2026-11-05): a destructive Apply asks again
  // before it runs, as the card has no Undo: a removal, a delete for good, a
  // prune, a sign-out, a revoke, a room access taken away, an owner made a
  // member, and an update (its restart cuts every turn, with no way back). A
  // prune's first click is its preview. The others run on the first click:
  // the card already shows what they change.
  const confirms =
    step.kind === "member-remove" ||
    step.kind === "member-purge" ||
    step.kind === "storage-prune" ||
    step.kind === "member-sessions" ||
    step.kind === "session-revoke" ||
    step.kind === "sign-in-links-revoke" ||
    step.kind === "api-token-revoke" ||
    step.kind === "office-update" ||
    (step.kind === "member-room" && !step.grant) ||
    (step.kind === "member-role" && step.role === "member");
  const [error, setError] = useState<string | null>(null);
  // One run at a time: a second click in the same frame still sees "idle".
  const running = useRef(false);
  // The confirm takes the focus, so the blur that ends it comes in every
  // browser: Chrome drops the focus of the button disabled for a prune's
  // preview with no blur, and Safari does not focus a clicked button.
  const applyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "confirming")
      applyButton.current?.focus({ preventScroll: true });
  }, [phase]);
  const fontSize = isMobile ? 13 : 12;
  const small = isMobile ? 12 : 11;
  const muted = { color: "var(--text-muted)", fontSize: small };

  // The first click of a kind that asks again: a prune's preview (the page's
  // dry run, with the step's policy), else the confirm state.
  async function firstClick() {
    if (step.kind !== "storage-prune") {
      setPhase("confirming");
      return;
    }
    running.current = true;
    setPhase("running");
    setError(null);
    try {
      const res = await apiFetch<{ plan: PrunePlanWire }>(
        "POST",
        "/api/storage/prune",
        {
          target: step.target,
          olderThanDays: step.olderThanDays,
          ...(step.keepPerAgent === undefined
            ? {}
            : { keepPerAgent: step.keepPerAgent }),
        },
      );
      // The server refuses that apply: say why instead of offering it.
      if (res.plan.skipped.some((v) => v.reason === "queue-state-unknown")) {
        setError(t("settings.storage.queueUnreadable"));
        setPhase("idle");
      } else {
        setPreview(res.plan);
        setPhase("confirming");
      }
    } catch (err) {
      setPhase("idle");
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      running.current = false;
    }
  }

  async function apply() {
    if (running.current) return;
    if (confirms && phase !== "confirming") return firstClick();
    running.current = true;
    setPhase("running");
    setError(null);
    try {
      const body = await apiFetch<unknown>(
        "POST",
        `/api/asks/${askId}/action`,
        step.kind === "whatsapp-route"
          ? { chat: waChosen }
          : step.kind === "discord-route" && dcChosen
            ? {
                botId: dcChosen.botId,
                guildId: dcChosen.guildId,
                scope: dcChosen.scope,
                targetId: dcChosen.targetId,
              }
            : undefined,
      );
      // Through the store, as this card may be gone: the ask closed as the
      // link or token was made.
      const result = resultOf(body);
      if (result) dispatch({ type: "ask_result_shown", askId, result });
      setPhase("ran");
    } catch (err) {
      running.current = false;
      setPhase("idle");
      setPreview(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const memberById = (userId: string) =>
    [...users.values()].find((u) => u.id === userId);

  // The sign-in link or token in a run's answer, or null. Read once, here:
  // the server keeps neither.
  function resultOf(body: unknown): AskResult | null {
    const b = (body ?? {}) as Record<string, unknown>;
    const memberName = (userId: string | undefined) =>
      (userId && memberById(userId)?.name) || "";
    // The member who applies is the one the ask is for: their own link is
    // for their device, another member's is to send on.
    const link = (value: unknown, userId: string | undefined) =>
      typeof value === "string" && value
        ? {
            kind: "sign-in-link" as const,
            agentId: askingAgentId,
            target: memberName(userId),
            value,
            forSelf: userId === memberUserId,
          }
        : null;
    switch (step.kind) {
      case "sign-in-link":
        return link(b.url, step.userId);
      // The link for the new address is always the member's own.
      case "office-access":
        return link(b.signInUrl, memberUserId);
      case "api-token":
        return typeof b.token === "string" && b.token
          ? {
              kind: "api-token",
              agentId: askingAgentId,
              target: step.name,
              value: b.token,
              forSelf: false,
            }
          : null;
      case "storage-prune":
        return b.applied
          ? {
              kind: "storage-prune",
              agentId: askingAgentId,
              target: step.target,
              applied: b.applied as PruneResultWire,
            }
          : null;
      case "storage-compress":
        return b.applied
          ? {
              kind: "storage-compress",
              agentId: askingAgentId,
              applied: b.applied as CompressResultWire,
            }
          : null;
      default:
        return null;
    }
  }
  // The asking agent's manager: a change that widens their reach widens the
  // agent's too.
  const managerUserId = agents.find((a) => a.id === askingAgentId)?.userId;
  const managerLine = (userId: string) =>
    userId === managerUserId ? (
      <div key="manager" style={muted}>
        {t("asks.action.manager")}
      </div>
    ) : null;

  function agentAccessView(s: Step<"agent-access">): ActionView {
    const target = agents.find((a) => a.id === s.agentId);
    const current = target ? agentAccessOf(target) : null;
    // A pack an older version stored on the step is not shown: Apply sends
    // the stop alone.
    const self = s.agentId === askingAgentId;
    return {
      name: target?.name ?? s.agentId,
      ...(current
        ? { current: { value: current, label: t(STOP_LABEL[current]) } }
        : {}),
      requested: { value: s.access, label: t(STOP_LABEL[s.access]) },
      lines: [
        <div key="hint" style={muted}>
          {t(STOP_HINT[s.access])}
        </div>,
        self && (
          <div key="self" style={muted}>
            {t("asks.action.self")}
          </div>
        ),
      ],
      marks: self ? { "data-ask-action-self": "" } : {},
      gone: target ? null : t("asks.action.gone"),
    };
  }

  function memberRoomView(s: Step<"member-room">): ActionView {
    const member = memberById(s.userId);
    const room =
      rooms.find((r) => r.id === s.roomId) ??
      allRooms.find((r) => r.id === s.roomId);
    const label = (granted: boolean) =>
      granted ? t("asks.action.roomGranted") : t("asks.action.roomRemoved");
    // An owner reaches every room by rule. A member's rooms are in the full
    // record only (an owner's view).
    const has =
      member?.role === "owner"
        ? true
        : member?.allowedRooms
          ? member.allowedRooms.includes(s.roomId)
          : undefined;
    const widens = s.grant && s.userId === managerUserId;
    return {
      name: member?.name ?? s.userId,
      ...(has !== undefined
        ? {
            current: {
              value: has ? "granted" : "removed",
              label: label(has),
            },
          }
        : {}),
      requested: {
        value: s.grant ? "granted" : "removed",
        label: label(s.grant),
      },
      lines: [
        <div key="room" {...noTranslate()} style={{ fontSize: small }}>
          {room?.name ?? s.roomId}
        </div>,
        <div key="hint" style={muted}>
          {t(
            s.grant
              ? "asks.action.roomGrantHint"
              : "asks.action.roomRemoveHint",
          )}
        </div>,
        widens && managerLine(s.userId),
      ],
      marks: widens ? { "data-ask-action-manager": "" } : {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  function memberRoleView(s: Step<"member-role">): ActionView {
    const member = memberById(s.userId);
    const label = (role: "owner" | "member") =>
      role === "owner"
        ? t("asks.action.roleOwner")
        : t("asks.action.roleMember");
    const widens = s.role === "owner" && s.userId === managerUserId;
    const selfDemote = s.role === "member" && s.userId === memberUserId;
    return {
      name: member?.name ?? s.userId,
      ...(member
        ? { current: { value: member.role, label: label(member.role) } }
        : {}),
      requested: { value: s.role, label: label(s.role) },
      lines: [
        <div key="hint" style={muted}>
          {t(
            s.role === "owner"
              ? "settings.role.officeOwnerExplanation"
              : "asks.action.roleMemberHint",
          )}
        </div>,
        widens && managerLine(s.userId),
        selfDemote && (
          <div key="self-demote" style={{ fontSize: small }}>
            {t("asks.action.selfDemote")}
          </div>
        ),
      ],
      marks: {
        ...(widens ? { "data-ask-action-manager": "" } : {}),
        ...(selfDemote ? { "data-ask-action-self-demote": "" } : {}),
      },
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  const onOff = (on: boolean): Value => ({
    value: on ? "on" : "off",
    label: t(on ? "asks.action.on" : "asks.action.off"),
  });
  const setting = (value: unknown): Value => ({
    value: String(value),
    label:
      typeof value === "boolean"
        ? t(value ? "asks.action.on" : "asks.action.off")
        : String(value),
  });

  function memberPackView(s: Step<"member-pack">): ActionView {
    const member = memberById(s.userId);
    const packValue = (
      pack: { agentCeiling: keyof typeof STOP_LABEL } | null | undefined,
    ): Value =>
      pack
        ? {
            value: pack.agentCeiling,
            label: t("asks.action.packCeiling", {
              stop: t(STOP_LABEL[pack.agentCeiling]),
            }),
          }
        : { value: "none", label: t("asks.action.packNone") };
    // A member's pack is in the full record only (an owner's view).
    const known = member && member.allowedRooms !== undefined;
    const areas = s.pack
      ? (Object.keys(s.pack.areas) as (keyof typeof PACK_AREA_LABEL)[])
      : [];
    return {
      name: member?.name ?? s.userId,
      ...(known ? { current: packValue(member.pack) } : {}),
      requested: packValue(s.pack),
      lines: [
        areas.length > 0 && (
          <div
            key="pack"
            data-ask-action-pack=""
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}
          >
            {areas.map((area) => (
              <span
                key={area}
                style={{
                  display: "inline-flex",
                  gap: 4,
                  padding: "1px 6px",
                  borderRadius: 6,
                  background: "var(--bg-surface)",
                  fontSize: small,
                }}
              >
                <span>{t(PACK_AREA_LABEL[area])}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {t(LEVEL_LABEL[s.pack!.areas[area]!])}
                </span>
              </span>
            ))}
          </div>
        ),
        s.pack && (
          <div key="hint" style={muted}>
            {t("settings.memberPack.hint")}
          </div>
        ),
      ],
      marks: {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  // The member the ask is for: their own record.
  const self = memberUserId ? memberById(memberUserId) : undefined;

  function preferencesView(s: Step<"member-preferences">): ActionView {
    const label = (key: string, value: unknown): string => {
      if (key === "language")
        return value === null
          ? t("asks.action.languageNone")
          : (SUPPORTED_LANGUAGES.find((l) => l.code === value)?.label ??
              (typeof value === "string" ? value : ""));
      if (key === "voiceInput" || key === "voiceOutput")
        return t(
          value === "openai"
            ? "integrations.voice.openai"
            : "integrations.voice.browser",
        );
      return String(value);
    };
    // The values as they apply: a record with no voice value has the
    // default.
    const now: Record<string, unknown> | null = self
      ? {
          language: self.language ?? null,
          voiceInput: self.voiceInput ?? "browser",
          voiceOutput: self.voiceOutput ?? "browser",
          voiceName: self.voiceName ?? DEFAULT_VOICE_NAME,
        }
      : null;
    return {
      name: t("asks.action.yourPreferences"),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: t(PREFERENCE_LABEL[key] ?? "asks.action.yourPreferences"),
        ...(now
          ? {
              current: {
                value: String(now[key]),
                label: label(key, now[key]),
              },
            }
          : {}),
        requested: { value: String(value), label: label(key, value) },
      })),
      lines: [],
      marks: {},
      gone: null,
    };
  }

  function memberViewView(s: Step<"member-view">): ActionView {
    const fetchedRooms = Array.isArray(fetched)
      ? (fetched as AccessibleRoomWire[])
      : [];
    const room =
      fetchedRooms.find((r) => r.id === s.roomId) ??
      rooms.find((r) => r.id === s.roomId) ??
      allRooms.find((r) => r.id === s.roomId);
    const lists = self?.hidden
      ? {
          hidden: self.hidden,
          tucked: self.tucked ?? [],
          notif: self.notifRooms ?? [],
          push: self.pushRooms ?? [],
        }
      : null;
    const on = lists
      ? s.list === "shown"
        ? !lists.hidden.includes(s.roomId)
        : lists[s.list].includes(s.roomId)
      : undefined;
    const notified = !!lists?.notif.includes(s.roomId);
    const pushed = !!lists?.push.includes(s.roomId);
    // What the view core does with the room's alerts: hiding or tucking a
    // room stops them, notifications off stops the push, and a push turns
    // notifications on.
    const alertsStop =
      on !== undefined &&
      on !== s.on &&
      ((s.list === "shown" && !s.on) || (s.list === "tucked" && s.on)
        ? notified || pushed
        : s.list === "notif" && !s.on && pushed);
    const notifOn =
      on !== undefined && on !== s.on && s.list === "push" && s.on && !notified;
    const now = lists
      ? roomViewLevel(
          {
            hidden: lists.hidden,
            tucked: lists.tucked,
            notifRooms: lists.notif,
            pushRooms: lists.push,
          },
          s.roomId,
        )
      : undefined;
    const after = levelAfterView(
      s.list,
      s.on,
      now,
      !!lists?.tucked.includes(s.roomId),
    );
    const level = (l: RoomViewLevel): Value => ({
      value: l,
      label: t(LEVEL_NAME[l]),
    });
    return {
      name: room?.name ?? s.roomId,
      ...(now !== undefined ? { current: level(now) } : {}),
      requested: level(after),
      lines: [
        <div key="info" style={muted}>
          {t(LEVEL_MEANING[after])}
        </div>,
        alertsStop && (
          <div key="alerts" style={muted}>
            {t("asks.action.alertsStop")}
          </div>
        ),
        notifOn && (
          <div key="notif" style={muted}>
            {t("asks.action.notifOn")}
          </div>
        ),
      ],
      marks: {
        ...(alertsStop ? { "data-ask-action-alerts-stop": "" } : {}),
        ...(notifOn ? { "data-ask-action-notif-on": "" } : {}),
      },
      gone: room ? null : t("asks.action.roomGone"),
    };
  }

  function officeSettingsView(s: Step<"office-settings">): ActionView {
    const now = (fetched ?? null) as Record<string, unknown> | null;
    const share = (value: unknown) =>
      t("settings.office.memberUsageShareOption", { share: String(value) });
    return {
      name: t("settings.office.title"),
      rows: Object.entries(s.set).map(([key, value]) => {
        const valueOf = (v: unknown): Value =>
          key === "memberUsageShare"
            ? { value: String(v), label: share(v) }
            : setting(v);
        const hint = OFFICE_HINT[key];
        return {
          key,
          label: t(OFFICE_LABEL[key] ?? "settings.office.title"),
          ...(now && key in now ? { current: valueOf(now[key]) } : {}),
          requested: valueOf(value),
          ...(hint ? { hint: t(hint) } : {}),
        };
      }),
      loading: now === null,
      lines: [],
      marks: {},
      gone: null,
    };
  }

  function backupSettingsView(s: Step<"backup-settings">): ActionView {
    const status = (fetched ?? null) as BackupStatusWire | null;
    const now: Record<string, unknown> | null = status
      ? {
          intervalHours: status.intervalHours,
          retention: status.retention,
          dir: status.destDir,
        }
      : null;
    const valueOf = (key: string, v: unknown): Value =>
      key === "dir" && v === null
        ? { value: "null", label: t("asks.action.backupDefaultFolder") }
        : key === "intervalHours"
          ? {
              value: String(v),
              label: `${String(v)} ${t("settings.storage.backupHours")}`,
            }
          : setting(v);
    const movesFolder = "dir" in s.set;
    return {
      name: t("settings.storage.category.backups"),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: t(BACKUP_LABEL[key] ?? "settings.storage.category.backups"),
        ...(now ? { current: valueOf(key, now[key]) } : {}),
        requested: valueOf(key, value),
      })),
      loading: now === null,
      lines: [
        movesFolder && (
          <div key="holds" style={muted}>
            {t("asks.action.backupHolds")}
          </div>
        ),
      ],
      marks: movesFolder ? { "data-ask-action-backup-holds": "" } : {},
      gone: null,
    };
  }

  function signInLinkView(s: Step<"sign-in-link">): ActionView {
    const member = memberById(s.userId);
    return {
      name: member?.name ?? s.userId,
      requested: { value: "link", label: t("asks.action.signInLink") },
      lines: [
        <div key="hint" style={muted}>
          {t(
            s.userId === memberUserId
              ? "asks.action.signInLinkHintSelf"
              : "asks.action.signInLinkHint",
          )}
        </div>,
      ],
      marks: {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  function memberSessionsView(s: Step<"member-sessions">): ActionView {
    const member = memberById(s.userId);
    const live = activeSessions.filter((v) => v.userId === s.userId).length;
    const here = s.userId === memberUserId;
    return {
      name: member?.name ?? s.userId,
      ...(activeSessionsLoaded
        ? {
            current: {
              value: String(live),
              label: tn("asks.action.devicesSignedIn", live),
            },
          }
        : {}),
      loading: !activeSessionsLoaded,
      requested: { value: "0", label: t("asks.action.signedOut") },
      lines: [
        <div key="hint" style={muted}>
          {t("asks.action.signOutHint")}
        </div>,
        here && (
          <div key="here" style={{ fontSize: small }}>
            {t("asks.action.signsYouOut")}
          </div>
        ),
      ],
      marks: here ? { "data-ask-action-signs-you-out": "" } : {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  // One session, named as the Access pane shows it: its device, else its
  // user agent, else its prefix.
  function sessionRevokeView(s: Step<"session-revoke">): ActionView {
    const member = memberById(s.userId);
    const session = activeSessions.find(
      (v) => v.userId === s.userId && v.sessionPrefix === s.sessionPrefix,
    );
    const name = session?.device || session?.userAgent || s.sessionPrefix;
    const here = sessionContext?.currentSessionPrefix === s.sessionPrefix;
    return {
      name,
      loading: !activeSessionsLoaded,
      requested: { value: "0", label: t("asks.action.signedOut") },
      lines: [
        s.userId !== memberUserId && member && (
          <div key="owner" style={{ fontSize: small }}>
            {t("asks.action.sessionOwner", { member: member.name })}
          </div>
        ),
        name !== s.sessionPrefix && (
          <div
            key="prefix"
            {...noTranslate()}
            style={{ ...muted, fontFamily: "'JetBrains Mono', monospace" }}
          >
            {s.sessionPrefix}…
          </div>
        ),
        session && (
          <div key="times" style={muted}>
            {t("asks.action.sessionTimes", {
              lastSeen: formatSince(i18n, session.lastSeenAt),
              created: formatSince(i18n, session.createdAt),
            })}
          </div>
        ),
        here && (
          <div key="here" style={{ fontSize: small }}>
            {t("asks.action.signsYouOut")}
          </div>
        ),
      ],
      marks: here ? { "data-ask-action-signs-you-out": "" } : {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  function linksRevokeView(s: Step<"sign-in-links-revoke">): ActionView {
    const member = memberById(s.userId);
    const pending = member
      ? invitesList.filter((i) => i.username === member.name).length
      : 0;
    return {
      name: member?.name ?? s.userId,
      ...(invitesLoaded && member
        ? {
            current: {
              value: String(pending),
              label: tn("asks.action.unusedLinks", pending),
            },
          }
        : {}),
      loading: !invitesLoaded,
      requested: { value: "0", label: t("asks.action.linksTakenBack") },
      lines: [],
      marks: {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  function apiTokenView(s: Step<"api-token">): ActionView {
    return {
      name: s.name,
      requested: {
        value: String(s.expiresInDays),
        label:
          s.expiresInDays === null
            ? t("asks.action.tokenNeverExpires")
            : t("asks.action.tokenExpires", { days: s.expiresInDays }),
      },
      lines: [
        <div key="access" style={muted}>
          {t("settings.apiTokens.accessLine", {
            access: accessSummary(t, language, s.limits),
          })}
        </div>,
        <div key="rooms" style={muted}>
          {t("settings.apiTokens.roomsLine", {
            rooms: roomsSummary(t, tn, language, s.limits, rooms),
          })}
        </div>,
        <div key="hint" style={muted}>
          {t("asks.action.tokenHint")}
        </div>,
      ],
      marks: {},
      gone: null,
    };
  }

  function apiTokenRevokeView(s: Step<"api-token-revoke">): ActionView {
    const token = (fetched as ApiTokenListRes | undefined)?.apiTokens?.find(
      (row) => row.id === s.tokenId,
    );
    const owner = s.userId === memberUserId ? null : memberById(s.userId);
    return {
      name: token?.name ?? s.tokenId,
      requested: { value: "revoked", label: t("asks.action.tokenRevoked") },
      lines: [
        owner && (
          <div key="owner" style={{ fontSize: small }}>
            {t("asks.action.tokenOwner", { member: owner.name })}
          </div>
        ),
        token && (
          <div key="used" style={muted}>
            {t("settings.apiTokens.lastRequest", {
              when: token.lastUsedAt
                ? t("settings.apiTokens.about", {
                    date: formatDateTime(
                      language,
                      token.lastUsedAt,
                      "dateTimeSeconds",
                    ),
                  })
                : t("settings.apiTokens.never"),
            })}
          </div>
        ),
        <div key="hint" style={muted}>
          {t("asks.action.tokenRevokeHint")}
        </div>,
      ],
      marks: {},
      gone: null,
    };
  }

  function officeAccessView(s: Step<"office-access">): ActionView {
    const now = fetched as AccessSettings | undefined;
    const address = (origin: string | null) =>
      origin || t("asks.action.accessNoAddress");
    return {
      name: t("settings.externalAccess.title"),
      ...(now ? { current: onOff(now.externalAccess) } : {}),
      loading: !now,
      requested: onOff(s.externalAccess),
      rows: [
        {
          key: "publicOrigin",
          label: t("settings.externalAccess.publicUrl"),
          ...(now
            ? {
                current: {
                  value: now.publicOrigin ?? "",
                  label: address(now.publicOrigin),
                },
              }
            : {}),
          requested: {
            value: s.publicOrigin,
            label: address(s.publicOrigin),
          },
        },
      ],
      lines: [
        <div key="restart" style={muted}>
          {t("asks.action.accessRestart")}
        </div>,
      ],
      marks: {},
      gone: null,
    };
  }

  function memberRemoveView(s: Step<"member-remove">): ActionView {
    const member = memberById(s.userId);
    const self = s.userId === memberUserId;
    return {
      name: member?.name ?? s.userId,
      requested: { value: "removed", label: t("asks.action.removed") },
      lines: [
        <div key="note" style={muted}>
          {t("settings.profile.deleteNote")}
        </div>,
        <div key="passes" style={muted}>
          {t("asks.action.removePasses")}
        </div>,
        self && (
          <div key="self" style={{ fontSize: small }}>
            {t("asks.action.removesYou")}
          </div>
        ),
      ],
      marks: self ? { "data-ask-action-self": "" } : {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  // A restore or a delete for good, of a member in Removed members.
  function removedMemberView(
    s: Step<"member-restore"> | Step<"member-purge">,
  ): ActionView {
    const list = (fetched as RemovedMemberListRes | undefined)?.members;
    const removed = list?.find((m) => m.user.id === s.userId);
    const restore = s.kind === "member-restore";
    const date = (at: number) => formatDateTime(language, at, "date");
    // As the page: the agents line only when something passed to the heir.
    const passed = removed?.passed;
    const passedAny =
      !!passed && passed.agents + passed.schedules + passed.webhooks > 0;
    return {
      name: removed?.user.name ?? s.userId,
      requested: restore
        ? { value: "restored", label: t("asks.action.restored") }
        : { value: "purged", label: t("asks.action.purged") },
      lines: [
        removed && (
          <div key="removed" style={muted}>
            {t("settings.removedMembers.removedOn", {
              date: date(removed.removedAt),
              name: removed.removedBy,
              expires: date(removed.expiresAt),
            })}
          </div>
        ),
        restore &&
          removed?.heirName &&
          passedAny &&
          (s.agents ? (
            <div key="agents" style={{ fontSize: small }}>
              {t("settings.removedMembers.moveBack", {
                heir: removed.heirName,
              })}
            </div>
          ) : (
            <div key="agents" style={{ fontSize: small }}>
              {t("asks.action.restoreKeepsAgents", {
                heir: removed.heirName,
              })}
            </div>
          )),
        <div key="hint" style={muted}>
          {restore
            ? t("settings.removedMembers.intro")
            : t("settings.storage.cannotUndo")}
        </div>,
      ],
      marks: {},
      gone: list && !removed ? t("asks.action.notRemoved") : null,
    };
  }

  function officeUpdateView(s: Step<"office-update">): ActionView {
    const running = updateInfo
      ? (updateInfo.current.release ??
        ("version" in updateInfo.current
          ? updateInfo.current.version
          : updateInfo.current.sha.slice(0, 7)))
      : null;
    const busy = (fetched as { busyAgents?: number } | undefined)?.busyAgents;
    const notes =
      updateInfo?.latest?.tag === s.tag ? updateInfo.latest.url : null;
    const started = phase === "ran";
    return {
      name: "Isomux",
      ...(running ? { current: { value: running, label: running } } : {}),
      loading: !updateInfo,
      requested: { value: s.tag, label: s.tag },
      lines: [
        <div key="restart" style={{ fontSize: small }}>
          {t("settings.update.restartWarning")}
        </div>,
        typeof busy === "number" && (
          <div key="busy" style={muted}>
            {busy === 0
              ? t("settings.update.busyNone")
              : tn("settings.update.busy", busy)}
          </div>
        ),
        notes && (
          <div key="notes" style={muted}>
            <a href={notes} target="_blank" rel="noreferrer">
              {t("settings.update.releaseNotes")}
            </a>
          </div>
        ),
        started && (
          <div key="started" style={{ fontSize: small }}>
            {t("update.screen.title")}
          </div>
        ),
      ],
      marks: started ? { "data-ask-action-started": "" } : {},
      gone: null,
    };
  }

  const olderThan = (days: number): Value => ({
    value: String(days),
    label: tn("asks.action.olderThanDays", days),
  });

  function storagePruneView(s: Step<"storage-prune">): ActionView {
    return {
      name: categoryLabel(t, s.target),
      requested: olderThan(s.olderThanDays),
      rows:
        s.keepPerAgent === undefined
          ? []
          : [
              {
                key: "keepPerAgent",
                label: t("settings.storage.keepPerAgent"),
                requested: {
                  value: String(s.keepPerAgent),
                  label: String(s.keepPerAgent),
                },
              },
            ],
      lines: [
        preview && (
          <div key="preview" style={{ fontSize: small }}>
            {preview.candidates.length > 0
              ? t("settings.storage.planCount", {
                  count: formatNumber(language, preview.candidates.length),
                  target: categoryLabel(t, s.target).toLowerCase(),
                  size: sizeText(language, t, preview.bytes),
                })
              : t("settings.storage.planEmpty", {
                  target: categoryLabel(t, s.target).toLowerCase(),
                })}
          </div>
        ),
        <div key="undo" style={muted}>
          {t("settings.storage.cannotUndo")}
        </div>,
      ],
      marks: preview
        ? { "data-ask-action-preview-count": String(preview.candidates.length) }
        : {},
      gone: null,
    };
  }

  function storageCompressView(s: Step<"storage-compress">): ActionView {
    return {
      name: t("settings.storage.compressSection"),
      requested: olderThan(s.olderThanDays),
      lines: [
        <div key="hint" style={muted}>
          {t("settings.storage.compressHint")}
        </div>,
      ],
      marks: {},
      gone: null,
    };
  }

  function whatsappRouteView(s: Step<"whatsapp-route">): ActionView {
    const target = agents.find((a) => a.id === s.agentId);
    const agentName = (id: string) =>
      agents.find((a) => a.id === id)?.name ?? id;
    const picked = waCandidates.find((c) => c.chat === waChosen);
    const row = picked?.row;
    const onOff = (on: boolean): Value => ({
      value: on ? "on" : "off",
      label: on ? t("asks.action.on") : t("asks.action.off"),
    });
    const group = picked ? picked.group : s.trigger !== undefined;
    const trigger = s.trigger ?? "mention";
    const triggerLabel = (v: "mention" | "all"): Value => ({
      value: v,
      label: t(
        v === "all"
          ? "integrations.whatsapp.rows.trigger.all"
          : "integrations.whatsapp.rows.trigger.mention",
      ),
    });
    const rows: Row[] = [
      {
        key: "agent",
        label: t("integrations.whatsapp.rows.agent"),
        ...(row
          ? { current: { value: row.agentId, label: agentName(row.agentId) } }
          : {}),
        requested: { value: s.agentId, label: target?.name ?? s.agentId },
      },
      {
        key: "waitForSend",
        label: t("integrations.whatsapp.rows.waitForSend"),
        ...(row ? { current: onOff(row.sendDirect !== true) } : {}),
        requested: onOff(s.sendDirect !== true),
        ...(s.sendDirect
          ? { hint: t("integrations.whatsapp.rows.directHint") }
          : {}),
      },
      ...(group
        ? [
            {
              key: "trigger",
              label: t("integrations.whatsapp.rows.trigger"),
              ...(row
                ? { current: triggerLabel(row.trigger ?? "mention") }
                : {}),
              requested: triggerLabel(trigger),
            },
          ]
        : []),
      ...(s.prefix || row?.prefix
        ? [
            {
              key: "prefix",
              label: t("integrations.whatsapp.rows.prefix"),
              ...(row
                ? {
                    current: {
                      value: row.prefix ?? "",
                      label: row.prefix ?? t("asks.action.off"),
                    },
                  }
                : {}),
              requested: {
                value: s.prefix ?? "",
                label: s.prefix ?? t("asks.action.off"),
              },
            },
          ]
        : []),
      ...(s.ownMessages || row?.ownMessages
        ? [
            {
              key: "ownMessages",
              label: t("integrations.whatsapp.rows.ownMessages"),
              ...(row ? { current: onOff(row.ownMessages === true) } : {}),
              requested: onOff(s.ownMessages === true),
            },
          ]
        : []),
    ];
    const member = memberUserId ? memberById(memberUserId) : undefined;
    const manager =
      target?.userId && target.userId !== memberUserId
        ? memberById(target.userId)
        : undefined;
    const lines: ReactNode[] = [];
    if (manager)
      lines.push(
        <div key="manager" data-ask-action-wa-manager="" style={muted}>
          {t("asks.action.whatsappManager", { member: manager.name })}
        </div>,
      );
    if (target && !belowStandard(agentAccessOf(target)))
      lines.push(
        <div
          key="shell"
          data-ask-action-wa-shell=""
          style={{ ...muted, color: "var(--orange-text)" }}
        >
          {t("integrations.whatsapp.rows.shellWarning")}
        </div>,
      );
    if (!waMember)
      lines.push(
        <div key="other" data-ask-action-wa-other="" style={muted}>
          {t("asks.action.whatsappOtherMember", {
            member: member?.name ?? "",
          })}
        </div>,
      );
    else if (waChats !== null && waCandidates.length === 0)
      lines.push(
        <div key="none" data-ask-action-wa-none="" style={muted}>
          {t("asks.action.whatsappNoMatch", { name: s.chatName })}
        </div>,
      );
    else if (waCandidates.length > 1)
      lines.push(
        <fieldset
          key="pick"
          data-ask-action-wa-pick=""
          style={{ border: "none", margin: "4px 0 0", padding: 0 }}
        >
          <legend style={muted}>
            {t("integrations.whatsapp.rows.chatPrompt")}
          </legend>
          {waCandidates.map((c) => (
            <label
              key={c.chat}
              data-ask-action-chat={c.chat}
              style={{ display: "flex", gap: 6, alignItems: "baseline" }}
            >
              <input
                type="radio"
                name={`ask-${askId}-chat`}
                value={c.chat}
                checked={waChosen === c.chat}
                onChange={() => setWaPick(c.chat)}
              />
              <span {...noTranslate()}>{c.name}</span>
              {c.group && (
                <span style={muted}>
                  {t("integrations.whatsapp.rows.group")}
                </span>
              )}
            </label>
          ))}
        </fieldset>,
      );
    if (row && row.agentId !== s.agentId)
      lines.push(
        <div key="moves" data-ask-action-wa-moves="" style={muted}>
          {t("asks.action.whatsappMoves", { agent: agentName(row.agentId) })}
        </div>,
      );
    return {
      name: `WhatsApp: ${picked?.name ?? s.chatName}`,
      loading: waMember && waChats === null,
      rows,
      lines,
      marks: {
        "data-ask-action-agent": s.agentId,
        ...(waChosen ? { "data-ask-action-chat-picked": waChosen } : {}),
      },
      gone: target ? null : t("asks.action.gone"),
      noApply: !waMember,
      waiting: waChosen === null,
    };
  }

  function discordRouteView(s: Step<"discord-route">): ActionView {
    const target = agents.find((a) => a.id === s.agentId);
    const agentName = (id: string) =>
      agents.find((a) => a.id === id)?.name ?? id;
    const route = dcChosen
      ? dcRoutes.find(
          (r) =>
            r.botId === dcChosen.botId &&
            r.scope === dcChosen.scope &&
            r.targetId === dcChosen.targetId,
        )
      : undefined;
    // "#general", "Category Talk" or "Whole server".
    const placeLabel = (p: DiscordPlace) =>
      p.scope === "channel"
        ? `#${p.name}`
        : p.scope === "category"
          ? t("integrations.discord.routes.inCategory", { name: p.name })
          : t("integrations.discord.routes.scope.server");
    const manyBots = (dcBots?.length ?? 0) > 1;
    const botName = (botId: string) =>
      dcBots?.find((b) => b.botId === botId)?.name ?? botId;
    const onOff = (on: boolean): Value => ({
      value: on ? "on" : "off",
      label: on ? t("asks.action.on") : t("asks.action.off"),
    });
    const triggerLabel = (v: DiscordRouteTrigger): Value => ({
      value: v,
      label: t(
        v === "all"
          ? "integrations.discord.routes.trigger.all"
          : "integrations.discord.routes.trigger.mention",
      ),
    });
    const repliesLabel = (v: DiscordReplyMode): Value => ({
      value: v,
      label: t(
        v === "bot"
          ? "integrations.discord.routes.replies.bot"
          : v === "read"
            ? "integrations.discord.routes.replies.read"
            : "integrations.discord.routes.replies.ask",
      ),
    });
    const prefixLabel = (v: string | undefined): Value => ({
      value: v ?? "",
      label: v ?? t("asks.action.off"),
    });
    const rows: Row[] = [
      {
        key: "agent",
        label: t("integrations.whatsapp.rows.agent"),
        ...(route
          ? {
              current: {
                value: route.agentId,
                label: agentName(route.agentId),
              },
            }
          : {}),
        requested: { value: s.agentId, label: target?.name ?? s.agentId },
      },
      {
        key: "replies",
        label: t("integrations.discord.routes.replies"),
        ...(route ? { current: repliesLabel(route.replyMode) } : {}),
        requested: repliesLabel(s.replyMode ?? "ask"),
      },
      {
        key: "trigger",
        label: t("integrations.discord.routes.trigger"),
        ...(route ? { current: triggerLabel(route.trigger) } : {}),
        requested: triggerLabel(s.trigger ?? "mention"),
      },
      ...(s.prefix || route?.prefix
        ? [
            {
              key: "prefix",
              label: t("integrations.whatsapp.rows.prefix"),
              ...(route ? { current: prefixLabel(route.prefix) } : {}),
              requested: prefixLabel(s.prefix),
            },
          ]
        : []),
      ...(s.includeBots || route?.includeBots
        ? [
            {
              key: "includeBots",
              label: t("integrations.discord.routes.includeBots"),
              ...(route ? { current: onOff(route.includeBots === true) } : {}),
              requested: onOff(s.includeBots === true),
            },
          ]
        : []),
      ...(s.react || route?.react
        ? [
            {
              key: "react",
              label: t("integrations.discord.routes.react"),
              ...(route ? { current: onOff(route.react === true) } : {}),
              requested: onOff(s.react === true),
            },
          ]
        : []),
    ];
    const member = memberUserId ? memberById(memberUserId) : undefined;
    const manager =
      target?.userId && target.userId !== memberUserId
        ? memberById(target.userId)
        : undefined;
    const lines: ReactNode[] = [];
    if (manager)
      lines.push(
        <div key="manager" data-ask-action-dc-manager="" style={muted}>
          {t("asks.action.discordManager", { member: manager.name })}
        </div>,
      );
    if (target && !belowStandard(agentAccessOf(target)))
      lines.push(
        <div
          key="shell"
          data-ask-action-dc-shell=""
          style={{ ...muted, color: "var(--orange-text)" }}
        >
          {t("integrations.discord.routes.shellWarning")}
        </div>,
      );
    if (!dcMember)
      lines.push(
        <div key="other" data-ask-action-dc-other="" style={muted}>
          {t("asks.action.discordOtherMember", {
            member: member?.name ?? "",
          })}
        </div>,
      );
    else if (dcBots !== null && dcPlaces.length === 0)
      lines.push(
        <div key="none" data-ask-action-dc-none="" style={muted}>
          {t("asks.action.discordNoMatch", { name: s.placeName })}
        </div>,
      );
    else if (dcPlaces.length > 1)
      lines.push(
        <fieldset
          key="pick"
          data-ask-action-dc-pick=""
          style={{ border: "none", margin: "4px 0 0", padding: 0 }}
        >
          <legend style={muted}>{t("asks.action.discordPlacePrompt")}</legend>
          {dcPlaces.map((p) => (
            <label
              key={placeKey(p)}
              style={{ display: "flex", gap: 6, alignItems: "baseline" }}
            >
              <input
                type="radio"
                name={`ask-${askId}-place`}
                value={placeKey(p)}
                checked={
                  dcChosen !== null && placeKey(dcChosen) === placeKey(p)
                }
                onChange={() => setDcPick(placeKey(p))}
              />
              <span {...noTranslate()}>{placeLabel(p)}</span>
              <span style={muted} {...noTranslate()}>
                {manyBots
                  ? `${p.guildName} · ${botName(p.botId)}`
                  : p.guildName}
              </span>
            </label>
          ))}
        </fieldset>,
      );
    if (route && route.agentId !== s.agentId)
      lines.push(
        <div key="moves" data-ask-action-dc-moves="" style={muted}>
          {t("asks.action.discordMoves", { agent: agentName(route.agentId) })}
        </div>,
      );
    return {
      name: `Discord: ${
        dcChosen
          ? dcChosen.scope === "server"
            ? dcChosen.guildName
            : placeLabel(dcChosen)
          : s.placeName
      }`,
      loading: dcMember && dcBots === null,
      rows,
      lines,
      marks: {
        "data-ask-action-agent": s.agentId,
        ...(dcChosen
          ? { "data-ask-action-place-picked": placeKey(dcChosen) }
          : {}),
      },
      gone: target ? null : t("asks.action.gone"),
      noApply: !dcMember,
      waiting: dcChosen === null,
    };
  }

  const view = (() => {
    switch (step.kind) {
      case "agent-access":
        return agentAccessView(step);
      case "member-room":
        return memberRoomView(step);
      case "member-role":
        return memberRoleView(step);
      case "member-pack":
        return memberPackView(step);
      case "member-preferences":
        return preferencesView(step);
      case "member-view":
        return memberViewView(step);
      case "office-settings":
        return officeSettingsView(step);
      case "backup-settings":
        return backupSettingsView(step);
      case "sign-in-link":
        return signInLinkView(step);
      case "member-sessions":
        return memberSessionsView(step);
      case "sign-in-links-revoke":
        return linksRevokeView(step);
      case "api-token":
        return apiTokenView(step);
      case "api-token-revoke":
        return apiTokenRevokeView(step);
      case "session-revoke":
        return sessionRevokeView(step);
      case "office-access":
        return officeAccessView(step);
      case "member-remove":
        return memberRemoveView(step);
      case "member-restore":
      case "member-purge":
        return removedMemberView(step);
      case "office-update":
        return officeUpdateView(step);
      case "storage-prune":
        return storagePruneView(step);
      case "storage-compress":
        return storageCompressView(step);
      case "whatsapp-route":
        return whatsappRouteView(step);
      case "discord-route":
        return discordRouteView(step);
    }
  })();

  // The value now while it loads: a dimmed block where its label goes, so the
  // row keeps its layout.
  const placeholder = (
    <span
      data-ask-action-loading=""
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: "4em",
        height: "0.9em",
        borderRadius: 4,
        background: "var(--bg-surface)",
        alignSelf: "center",
      }}
    />
  );

  return (
    <div
      data-ask-action=""
      {...(view.current
        ? { "data-ask-action-current": view.current.value }
        : {})}
      {...(view.requested
        ? { "data-ask-action-requested": view.requested.value }
        : {})}
      {...view.marks}
      {...(view.gone !== null ? { "data-ask-action-gone": "" } : {})}
      style={{
        marginTop: 8,
        padding: isMobile ? "8px 10px" : "6px 10px",
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        fontSize,
        lineHeight: 1.5,
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          columnGap: 8,
          alignItems: "baseline",
        }}
      >
        <span {...noTranslate()} style={{ fontWeight: 600 }}>
          {view.name}
        </span>
        {view.current ? (
          <span data-ask-action-from="" style={{ color: "var(--text-muted)" }}>
            {view.current.label}
          </span>
        ) : (
          view.requested && view.loading && placeholder
        )}
        {(view.current || (view.requested && view.loading)) && (
          <span aria-hidden="true">→</span>
        )}
        {view.requested && (
          <span data-ask-action-to="" style={{ fontWeight: 600 }}>
            {view.requested.label}
          </span>
        )}
      </div>
      {view.rows?.map((row) => (
        <div
          key={row.key}
          data-ask-action-key={row.key}
          {...(row.current
            ? { "data-ask-action-current": row.current.value }
            : {})}
          data-ask-action-requested={row.requested.value}
          style={{ marginTop: 2 }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 8,
              alignItems: "baseline",
            }}
          >
            <span>{row.label}</span>
            {row.current ? (
              <span
                {...noTranslate()}
                style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}
              >
                {row.current.label}
              </span>
            ) : (
              view.loading && placeholder
            )}
            {(row.current || view.loading) && <span aria-hidden="true">→</span>}
            <span
              {...noTranslate()}
              style={{ fontWeight: 600, overflowWrap: "anywhere" }}
            >
              {row.requested.label}
            </span>
          </div>
          {row.hint && (
            <div data-ask-action-hint="" style={muted}>
              {row.hint}
            </div>
          )}
        </div>
      ))}
      {view.lines}
      {view.gone !== null ? (
        <div style={muted}>{view.gone}</div>
      ) : view.noApply ||
        (step.kind === "office-update" && phase === "ran") ? null : (
        <button
          type="button"
          ref={applyButton}
          data-ask-action-apply=""
          {...(phase === "confirming" ? { "data-ask-action-confirm": "" } : {})}
          disabled={
            (phase !== "idle" && phase !== "confirming") || !!view.waiting
          }
          // The confirm ends when the button loses focus, as on the pages: a
          // click after the member moved on asks again (a prune previews
          // again).
          onBlur={() => {
            if (phase !== "confirming") return;
            setPhase("idle");
            setPreview(null);
          }}
          // Keep the focus on the armed button: Safari clears the focus on a
          // mousedown on a button, and that blur would end the confirm before
          // the second click lands.
          onMouseDown={(e) => {
            if (phase === "confirming") e.preventDefault();
          }}
          onClick={() => void apply()}
          style={{
            marginTop: 6,
            padding: isMobile ? "8px 14px" : "5px 14px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent-text)",
            color: "var(--bg-base)",
            fontSize: 12,
            fontWeight: 600,
            cursor:
              (phase === "idle" || phase === "confirming") && !view.waiting
                ? "pointer"
                : "default",
            opacity:
              (phase === "idle" || phase === "confirming") && !view.waiting
                ? 1
                : 0.6,
          }}
        >
          {phase !== "confirming"
            ? t("asks.action.apply")
            : preview && step.kind === "storage-prune"
              ? t("settings.storage.deleteCount", {
                  count: formatNumber(language, preview.candidates.length),
                  target: categoryLabel(t, step.target).toLowerCase(),
                })
              : t("common.confirmQuestion")}
        </button>
      )}
      {error && (
        <div
          role="alert"
          style={{ marginTop: 6, color: "var(--red-text)", fontSize: small }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
