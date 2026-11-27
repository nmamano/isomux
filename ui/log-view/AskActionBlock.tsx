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
// Task 2ff2729f: some settings of one existing route of the member, in
// either app (messaging-route), read from the same held route data; and the
// ages of the daily automatic cleanup (storage-retention).
// Task 8852553c: a member's sign-in link given another 3 days
// (sign-in-link-extend) and a member's avatar (member-avatar).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch, type AskResult } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { Data } from "../components/Data.tsx";
import { noTranslate } from "../no-translate.ts";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import {
  whatsappChatMatches,
  whatsappPhoneChat,
  type WhatsAppChatSeen,
  type WhatsAppRoute,
} from "../../shared/whatsapp.ts";
import {
  discordPlacesMatching,
  type DiscordPlace,
  type DiscordReplyMode,
  type DiscordRoute as DiscordRouteWire,
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
  LogRetentionWire,
  CompressResultWire,
  MemberOsUserWire,
  PrunePlanWire,
  PruneResultWire,
  RemovedMemberListRes,
} from "../../shared/contract-shapes.ts";
import { categoryLabel, sizeText } from "../components/StoragePane.tsx";
import { formatSince } from "../components/access-shared.tsx";
import {
  FailureRow,
  OS_USER_POLL_CAP_MS,
  OS_USER_POLL_MS,
  runErrorLine,
} from "../components/MemberOsUserSection.tsx";
import { nameValues } from "../components/Data.tsx";
import { MaskedInput } from "../components/MaskedInput.tsx";
import { dialogInput } from "../components/dialog-styles.ts";
import type { InviteWire, SessionWire } from "../../shared/types.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { formatNumber } from "../../shared/i18n/number.ts";
import { accessSummary, roomsSummary } from "../components/ApiTokensPane.tsx";
import { SUPPORTED_LANGUAGES } from "../../shared/languages.ts";
import { DEFAULT_VOICE_NAME } from "../../shared/voice.ts";
import {
  useDiscordRouteData,
  useWhatsAppRouteData,
} from "../route-ask-data.ts";
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

// The button's label: the action the tap runs. A kind that sets values says
// Apply; a kind that makes or ends something names it (task 29a3cb9c).
export function actionButtonKey(step: ActionStepRequest): PlainMessageKey {
  switch (step.kind) {
    case "agent-access":
    case "member-pack":
    case "member-preferences":
    case "member-view":
    case "office-settings":
    case "backup-settings":
    case "office-access":
    case "storage-retention":
    case "messaging-route":
    case "whatsapp-route":
    case "discord-route":
      return "asks.action.apply";
    case "sign-in-link":
      return "asks.action.button.signInLink";
    case "api-token":
      return "asks.action.button.apiToken";
    case "member-sessions":
      return "asks.action.button.memberSessions";
    case "session-revoke":
      return "asks.action.button.sessionRevoke";
    case "sign-in-links-revoke":
      return "asks.action.button.signInLinksRevoke";
    case "api-token-revoke":
      return "asks.action.button.apiTokenRevoke";
    case "member-room":
      return step.grant
        ? "asks.action.button.roomGrant"
        : "asks.action.button.roomRemove";
    case "member-role":
      return step.role === "owner"
        ? "asks.action.button.makeOwner"
        : "asks.action.button.makeMember";
    case "member-remove":
      return "asks.action.button.memberRemove";
    case "member-restore":
      return "asks.action.button.memberRestore";
    case "member-purge":
      return "asks.action.button.memberPurge";
    case "instructions-line":
      return "asks.action.button.instructionsLine";
    // The settings pages' own labels for the same action.
    case "office-update":
      return "settings.update.updateNow";
    case "storage-prune":
      return "settings.storage.deletePermanently";
    case "storage-compress":
      return "settings.storage.compress";
    case "member-os-user":
      return step.on
        ? "asks.action.button.osUserOn"
        : "asks.action.button.osUserOff";
    // The Invites page's own label.
    case "sign-in-link-extend":
      return "settings.invites.extend";
    case "member-avatar":
      return "asks.action.apply";
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

interface Value {
  value: string;
  label: string;
}

// A row whose value now equals the value asked for shows it once, with no
// arrow.
const sameValue = (now: Value, asked: Value) => now.value === asked.value;

// The widest a value now draws in a card that reads it (task 8e61bf71):
// a fixed column, so the value asked keeps its place when it arrives. A
// longer one wraps.
const VALUE_NOW = "16em";
// The least the value asked gets beside it, so on a phone the value now
// gives way first.
const VALUE_ASKED = "8em";

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
  // The gone line says the asked end state already holds (the member is
  // removed, the sessions ended): a note, not a blocker.
  goneDone?: boolean;
  // No Apply: the viewer is not the member who can run it.
  noApply?: boolean;
  // Apply waits for a choice on the card.
  waiting?: boolean;
}

// A chat a whatsapp-route step may route: its name as the bridge saw it (else
// the row's), and its row when it has one. `phone`: the chat is the step's
// number, shown so the member sees what the agent named (absent when the
// name is that number).
interface WhatsAppCandidate {
  chat: string;
  name: string;
  group: boolean;
  row?: WhatsAppRoute;
  phone?: string;
}

// The member's chats that match the step's name or number: those the bridge
// saw, and those with a row, matched by the seen name, the row's name or the
// chat's number (the server's rule, step-asks-messaging.ts). With a number
// that no such chat has, the number's chat itself, under the step's name
// (task a23a66d3).
export function whatsappCandidates(
  step: { chatName: string; phone?: string },
  seen: readonly WhatsAppChatSeen[],
  rows: readonly WhatsAppRoute[],
): WhatsAppCandidate[] {
  const out = new Map<string, WhatsAppCandidate>();
  for (const c of seen)
    if (whatsappChatMatches(c, step))
      out.set(c.chat, { chat: c.chat, name: c.name, group: c.group });
  for (const row of rows) {
    const seenChat = seen.find((c) => c.chat === row.chat);
    if (
      whatsappChatMatches(row, step) ||
      (seenChat !== undefined && whatsappChatMatches(seenChat, step))
    )
      out.set(row.chat, {
        chat: row.chat,
        name: seenChat?.name ?? row.name,
        group: row.group,
      });
  }
  const phone = step.phone;
  const phoneChat = phone === undefined ? null : whatsappPhoneChat(phone);
  if (phoneChat !== null && !out.has(phoneChat))
    out.set(phoneChat, { chat: phoneChat, name: step.chatName, group: false });
  return [...out.values()].map((c) => {
    const row = rows.find((r) => r.chat === c.chat);
    const shown =
      phone !== undefined && c.chat === phoneChat && c.name !== phone
        ? { phone }
        : {};
    return row ? { ...c, ...shown, row } : { ...c, ...shown };
  });
}

// A candidate's name, with the number when it has one to show.
const candidateLabel = (c: WhatsAppCandidate): string =>
  c.phone === undefined ? c.name : `${c.name} (+${c.phone})`;

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
  limitResume: "settings.office.limitResume",
};
const OFFICE_HINT: Record<string, PlainMessageKey> = {
  memberUsageCap: "settings.office.memberUsageCapHint",
  recordTerminals: "audit.recordTerminalsHint",
  providerFallback: "settings.office.providerFallbackHint",
  processIsolation: "settings.office.processIsolationHint",
  claudeIsomuxLabel: "settings.office.claudeIsomuxLabelHint",
  limitResume: "settings.office.limitResumeHint",
};
const PREFERENCE_LABEL: Record<string, PlainMessageKey> = {
  language: "settings.sidebar.language",
  voiceInput: "integrations.voice.mic",
  voiceOutput: "integrations.voice.readAloud",
  voiceName: "integrations.voice.voiceName",
  showToolCalls: "preferences.showToolCalls",
  showAgentMessages: "preferences.showAgentMessages",
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

// A Discord route's and a WhatsApp row's settings as a messaging-route step
// compares them: a key the route does not store has its default (off, no
// prefix, mention on a group).
function routeNow(r: DiscordRouteWire): Record<string, unknown> {
  return {
    name: r.name,
    agentId: r.agentId,
    trigger: r.trigger,
    replyMode: r.replyMode,
    prefix: r.prefix ?? "",
    includeBots: r.includeBots === true,
    react: r.react === true,
  };
}
function rowNow(r: WhatsAppRoute): Record<string, unknown> {
  return {
    name: r.name,
    agentId: r.agentId,
    ...(r.group ? { trigger: r.trigger ?? "mention" } : {}),
    prefix: r.prefix ?? "",
    sendDirect: r.sendDirect === true,
    ownMessages: r.ownMessages === true,
  };
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
  const { t, tn, rich, language } = i18n;
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
                  : step.kind === "storage-retention"
                    ? "/api/storage/retention"
                    : null;
  const [fetched, setFetched] = useState<unknown>(undefined);
  // A whatsapp-route step reads the chats and rows of the viewer, so only the
  // member the ask is for reads them: another viewer (an owner) would see
  // their own chats. The data is shared and read at boot
  // (ui/route-ask-data.ts), so the card draws its shape at once.
  const viewerId = sessionContext?.userId ?? null;
  const waMember =
    (step.kind === "whatsapp-route" ||
      (step.kind === "messaging-route" && step.app === "whatsapp")) &&
    !!memberUserId &&
    viewerId === memberUserId;
  const waData = useWhatsAppRouteData(waMember ? viewerId : null);
  const waChats = waData?.chats ?? null;
  const waRows = waData?.rows ?? null;
  const [waPick, setWaPick] = useState<string | null>(null);
  const waCandidates =
    step.kind === "whatsapp-route" && waChats && waRows
      ? whatsappCandidates(step, waChats, waRows)
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
    (step.kind === "discord-route" ||
      (step.kind === "messaging-route" && step.app === "discord")) &&
    !!memberUserId &&
    viewerId === memberUserId;
  const dcData = useDiscordRouteData(dcMember ? viewerId : null);
  const dcBots = dcData?.bots ?? null;
  const dcRoutes = dcData?.routes ?? [];
  const [dcPick, setDcPick] = useState<string | null>(null);
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
      : step.kind === "sign-in-links-revoke" ||
          step.kind === "sign-in-link-extend"
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

  // A member-os-user step (task 4088f164) reads the member's OS user as the
  // Members page does, and again every OS_USER_POLL_MS after its Apply and
  // while a run or a move goes on, up to OS_USER_POLL_CAP_MS. The password
  // stays in this card's state only, cleared at the start of a run.
  const osUserPath =
    step.kind === "member-os-user"
      ? (() => {
          const name = [...users.values()].find(
            (u) => u.id === step.userId,
          )?.name;
          return name ? `/api/users/${encodeURIComponent(name)}/os-user` : null;
        })()
      : null;
  // When the card first drew: whether a sign-in link's stored expiry has
  // passed, while the live list loads.
  const [drawnAt] = useState(() => Date.now());
  const [osView, setOsView] = useState<MemberOsUserWire | null>(null);
  const [osPassword, setOsPassword] = useState("");
  // The attempt's stamp at Apply: a failure with another stamp is this run's.
  const osAttemptAtApply = useRef<number | undefined>(undefined);
  const readOsUser = (path: string, live: () => boolean = () => true) =>
    apiFetch<MemberOsUserWire>("GET", path)
      .then((next) => {
        if (live()) setOsView(next);
      })
      .catch(() => {});
  useEffect(() => {
    if (!osUserPath) return;
    let live = true;
    void readOsUser(osUserPath, () => live);
    return () => {
      live = false;
    };
  }, [osUserPath]);
  const osBusy =
    osView?.attempt?.status === "running" || osView?.state === "moving";
  const osPolling = !!osUserPath && (phase === "ran" || osBusy);
  useEffect(() => {
    if (!osPolling || !osUserPath) return;
    let live = true;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      if (ticks * OS_USER_POLL_MS > OS_USER_POLL_CAP_MS) {
        clearInterval(timer);
        return;
      }
      void readOsUser(osUserPath, () => live);
    }, OS_USER_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [osPolling, osUserPath]);
  // This card's run failed or stopped: the failure shows, and the password
  // field and Apply come back.
  const osAttempt = osView?.attempt;
  useEffect(() => {
    if (
      phase === "ran" &&
      step.kind === "member-os-user" &&
      (osAttempt?.status === "failed" || osAttempt?.status === "stopped") &&
      osAttempt.at !== osAttemptAtApply.current
    ) {
      running.current = false;
      setPhase("idle");
    }
  }, [phase, step.kind, osAttempt?.status, osAttempt?.at]);
  const fontSize = isMobile ? 13 : 12;
  const small = isMobile ? 12 : 11;
  const muted = { color: "var(--text-muted)", fontSize: small };
  // A line that says why Apply cannot run: in the error colour and set apart,
  // so it does not read as a note under a warning (task a1971631).
  const blocker = { color: "var(--red-text)", fontSize: small, marginTop: 4 };

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
    if (step.kind === "member-os-user")
      osAttemptAtApply.current = osView?.attempt?.at;
    try {
      const body = await apiFetch<unknown>(
        "POST",
        `/api/asks/${askId}/action`,
        step.kind === "member-os-user"
          ? osView?.run === "password"
            ? { password: osPassword }
            : undefined
          : step.kind === "whatsapp-route"
            ? { chat: waChosen }
            : step.kind === "instructions-line"
              ? // The line as the card shows it: a changed rule is refused.
                { scope: step.scope, line: step.line }
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
      if (step.kind === "member-os-user") {
        setOsPassword("");
        if (osUserPath) void readOsUser(osUserPath);
      }
      setPhase("ran");
    } catch (err) {
      running.current = false;
      setPhase("idle");
      setPreview(null);
      setError(
        step.kind === "member-os-user"
          ? runErrorLine(err, t)
          : err instanceof ApiError
            ? err.message
            : String(err),
      );
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
      if (typeof value === "boolean")
        return t(value ? "asks.action.on" : "asks.action.off");
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
          showToolCalls: self.showToolCalls === true,
          showAgentMessages: self.showAgentMessages === true,
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
      goneDone: true,
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
            {rich("asks.action.sessionOwner", {
              member: <Data>{member.name}</Data>,
            })}
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
      goneDone: true,
    };
  }

  // A member's own list holds only their live links, so for a member who
  // takes back their own, an expired link an owner could extend is not
  // counted, though Apply removes it too.
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
      goneDone: true,
    };
  }

  // The link's expiry now, from the owners' live invite list (task
  // 8852553c). A link used, replaced or taken back is gone: nothing to
  // extend. While the list loads, the expiry the step stored at the create
  // stands in (task 8e61bf71): an open ask's link still has it, since the
  // ask closes when the link's expiry passes it.
  function linkExtendView(s: Step<"sign-in-link-extend">): ActionView {
    const member = memberById(s.userId);
    const link = invitesList.find((i) => i.tokenPrefix === s.tokenPrefix);
    const expiry = (expiresAt: number, expired: boolean): Value => {
      const time = formatDateTime(language, expiresAt, "dateTime");
      return {
        value: String(expiresAt),
        label: expired
          ? t("asks.action.linkExpiredAt", { time })
          : t("asks.action.linkExpiresAt", { time }),
      };
    };
    const current = !invitesLoaded
      ? expiry(s.expiresAt, s.expiresAt < drawnAt)
      : link
        ? expiry(link.expiresAt, !!link.expired)
        : undefined;
    return {
      name: member?.name ?? s.userId,
      ...(current ? { current } : {}),
      loading: !invitesLoaded,
      requested: { value: "extended", label: t("asks.action.linkExtended") },
      lines: [
        <div key="hint" style={muted}>
          {t("asks.action.linkExtendHint")}
        </div>,
      ],
      marks: {},
      gone: !member
        ? t("asks.action.memberGone")
        : invitesLoaded && !link
          ? t("asks.action.linkGone")
          : null,
    };
  }

  // The fields the step names, as the member has them now and as asked: the
  // colour and the ghost shape's name, as the avatar picker titles them.
  function memberAvatarView(s: Step<"member-avatar">): ActionView {
    const member = memberById(s.userId);
    const asked = (color: string, variant: string): Value => {
      const parts = [
        ...(s.avatarColor !== undefined ? [color] : []),
        ...(s.avatarVariant !== undefined ? [variant] : []),
      ];
      return { value: parts.join(" "), label: parts.join(" · ") };
    };
    const now = member
      ? { color: member.avatarColor, variant: member.avatarVariant }
      : null;
    const want = now
      ? {
          color: s.avatarColor ?? now.color,
          variant: s.avatarVariant ?? now.variant,
        }
      : null;
    return {
      name: member?.name ?? s.userId,
      ...(now ? { current: asked(now.color, now.variant) } : {}),
      requested: asked(s.avatarColor ?? "", s.avatarVariant ?? ""),
      lines: [
        now && want && (
          <div
            key="ghosts"
            aria-hidden="true"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <GhostGraphic
              variant={now.variant}
              color={now.color}
              size={22}
              animated={false}
            />
            <span>→</span>
            <GhostGraphic
              variant={want.variant}
              color={want.color}
              size={22}
              animated={false}
            />
          </div>
        ),
      ],
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
            {rich("asks.action.tokenOwner", {
              member: <Data>{owner.name}</Data>,
            })}
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
      goneDone: true,
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
            {rich("settings.removedMembers.removedOn", {
              date: date(removed.removedAt),
              name: <Data>{removed.removedBy}</Data>,
              expires: date(removed.expiresAt),
            })}
          </div>
        ),
        restore &&
          removed?.heirName &&
          passedAny &&
          (s.agents ? (
            <div key="agents" style={{ fontSize: small }}>
              {rich("settings.removedMembers.moveBack", {
                heir: <Data>{removed.heirName}</Data>,
              })}
            </div>
          ) : (
            <div key="agents" style={{ fontSize: small }}>
              {rich("asks.action.restoreKeepsAgents", {
                heir: <Data>{removed.heirName}</Data>,
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
      // Restored or purged by someone else: a restore after a purge fails,
      // but the card cannot tell the two apart.
      goneDone: true,
    };
  }

  // A member's own OS user on or off (task 4088f164): the user now and the
  // one asked for, what the change does, the other members on that user,
  // the last run's failure, and the box account's password where sudo asks
  // for one. A run or a move that goes on, or a state the root command must
  // refuse, is a blocker.
  function memberOsUserView(s: Step<"member-os-user">): ActionView {
    const member = memberById(s.userId);
    const now = osView;
    const name = member?.name ?? s.userId;
    const off: Value = { value: "off", label: t("asks.action.off") };
    const target = s.osUser ?? now?.newUserName;
    const requested: Value = s.on
      ? target
        ? { value: target, label: target }
        : { value: "on", label: t("asks.action.on") }
      : off;
    const current: Value | undefined = !now
      ? undefined
      : now.osUser
        ? { value: now.osUser.name, label: now.osUser.name }
        : now.state === "off"
          ? off
          : undefined;
    const ownRun = phase === "ran";
    const gone = !member
      ? t("asks.action.memberGone")
      : !now || ownRun
        ? null
        : !now.support.ok || now.run === null
          ? t("asks.action.osUser.noRun")
          : now.state === "moving"
            ? t("settings.osUser.moving")
            : now.attempt?.status === "running"
              ? t("settings.osUser.runInProgress")
              : s.osUser !== undefined && now.state !== "off"
                ? t("asks.action.osUser.hasOne")
                : !s.on && now.movedIn
                  ? t("asks.action.osUser.movedIn")
                  : null;
    // The other members on the user: the existing user the step names, or
    // the member's own user that an off leaves to them.
    const sharedWith = s.on
      ? s.existing
        ? (now?.candidates?.find((c) => c.name === s.osUser)?.members ?? [])
        : []
      : (now?.sharedWith ?? []);
    const sharedName = s.on ? s.osUser : now?.osUser?.name;
    const failed =
      now &&
      !ownRun &&
      (now.attempt?.status === "failed" || now.attempt?.status === "stopped")
        ? now.attempt
        : null;
    // While the read is out, the field holds its place (most offices ask
    // for a password), so the card does not jump when it comes.
    const askPassword =
      gone === null && !ownRun && (!now || now.run === "password");
    return {
      name,
      loading: !now,
      rows: [
        {
          key: "osUser",
          label: t("settings.osUser.title"),
          ...(current ? { current } : {}),
          requested,
        },
      ],
      lines: [
        // An existing user may be one that can become root: the line that
        // says their agents cannot read the office's files is for a new one.
        !(s.on && s.existing) && (
          <div key="hint" style={muted}>
            {s.on ? t("settings.osUser.hint") : t("asks.action.osUser.offHint")}
          </div>
        ),
        sharedWith.length > 0 && sharedName && (
          <div key="shared" role="note" style={muted}>
            {s.on
              ? rich("settings.osUser.shared", {
                  members: nameValues(
                    sharedWith.map((m) => m.name),
                    language,
                  ),
                  name: <Data>{sharedName}</Data>,
                })
              : rich("asks.action.osUser.offShared", {
                  members: nameValues(
                    sharedWith.map((m) => m.name),
                    language,
                  ),
                  name: <Data>{sharedName}</Data>,
                })}
          </div>
        ),
        failed && <FailureRow key="failed" attempt={failed} />,
        ownRun && (
          <div key="running" role="status" style={{ fontSize: small }}>
            {t(
              s.on ? "settings.osUser.turningOn" : "settings.osUser.turningOff",
            )}
          </div>
        ),
        askPassword && (
          <MaskedInput
            key="password"
            aria-label={t("cards.sudoRequest.password")}
            placeholder={t("cards.sudoRequest.password")}
            value={osPassword}
            disabled={!now}
            onChange={(e) => setOsPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && osPassword !== "") void apply();
            }}
            style={{
              ...dialogInput,
              display: "block",
              marginTop: 6,
              maxWidth: 280,
              // A field the member cannot use yet looks disabled.
              ...(now ? {} : { opacity: 0.6 }),
            }}
          />
        ),
      ],
      marks: ownRun ? { "data-ask-action-started": "" } : {},
      gone,
      noApply: ownRun,
      waiting: !now || (askPassword && osPassword === ""),
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

  // The rule ask of "... and automate" (task 33891b5b): whose instructions
  // get the line, and the line as Apply writes it.
  function instructionsLineView(s: Step<"instructions-line">): ActionView {
    const name =
      s.scope === "agent"
        ? t("asks.action.instructionsAgent", {
            agent: agents.find((a) => a.id === s.targetId)?.name ?? s.targetId,
          })
        : s.scope === "room"
          ? t("asks.action.instructionsRoom", {
              room:
                (
                  rooms.find((r) => r.id === s.targetId) ??
                  allRooms.find((r) => r.id === s.targetId)
                )?.name ?? s.targetId,
            })
          : t("asks.action.instructionsMember", {
              member:
                [...users.values()].find((u) => u.id === s.targetId)?.name ??
                s.targetId,
            });
    return {
      name,
      lines: [
        <div
          key="line"
          data-ask-action-line=""
          {...noTranslate()}
          style={{
            paddingLeft: 8,
            borderLeft: "2px solid var(--border-light)",
            color: "var(--text-primary)",
            fontSize: isMobile ? 13 : 12,
            overflowWrap: "anywhere",
            whiteSpace: "pre-wrap",
          }}
        >
          {s.line}
        </div>,
      ],
      marks: {},
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
          {rich("asks.action.whatsappManager", {
            member: <Data>{manager.name}</Data>,
          })}
        </div>,
      );
    // No chat matches: Apply cannot run, so the blocker is the one coloured
    // line.
    const waNone = waMember && waChats !== null && waCandidates.length === 0;
    if (target && !belowStandard(agentAccessOf(target)) && !waNone)
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
          {rich("asks.action.whatsappOtherMember", {
            member: member ? <Data>{member.name}</Data> : "",
          })}
        </div>,
      );
    else if (waNone)
      lines.push(
        <div
          key="none"
          data-ask-action-wa-none=""
          data-ask-action-blocker=""
          style={blocker}
        >
          {rich("asks.action.whatsappNoMatch", {
            name: <Data>{s.chatName}</Data>,
          })}
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
              <span {...noTranslate()}>{candidateLabel(c)}</span>
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
          {rich("asks.action.whatsappMoves", {
            agent: <Data>{agentName(row.agentId)}</Data>,
          })}
        </div>,
      );
    return {
      name: `WhatsApp: ${picked ? candidateLabel(picked) : s.chatName}`,
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

  // The route's name and app, and a row per key of `set`: the value now
  // (the default when the route stores no key) and the one asked. Only the
  // member reads their routes; a route their list no longer has is gone.
  function messagingRouteView(s: Step<"messaging-route">): ActionView {
    const isMember = s.app === "discord" ? dcMember : waMember;
    const list: { id: string }[] | null =
      s.app === "discord" ? (dcData?.routes ?? null) : waRows;
    const found = list?.find((r) => r.id === s.routeId);
    const now: Record<string, unknown> | null = !found
      ? null
      : s.app === "discord"
        ? routeNow(found as DiscordRouteWire)
        : rowNow(found as WhatsAppRoute);
    const onOff = (v: unknown) => t(v ? "asks.action.on" : "asks.action.off");
    const agentName = (id: unknown) =>
      agents.find((a) => a.id === id)?.name ?? String(id);
    const dc = s.app === "discord";
    const label = (key: string): string => {
      switch (key) {
        case "name":
          return t("integrations.whatsapp.rows.name");
        case "agentId":
          return t("integrations.whatsapp.rows.agent");
        case "trigger":
          return t(
            dc
              ? "integrations.discord.routes.trigger"
              : "integrations.whatsapp.rows.trigger",
          );
        case "replyMode":
          return t("integrations.discord.routes.replies");
        case "prefix":
          return t("integrations.whatsapp.rows.prefix");
        case "includeBots":
          return t("integrations.discord.routes.includeBots");
        case "react":
          return t("integrations.discord.routes.react");
        // As the Integrations page and the whatsapp-route card name it.
        case "sendDirect":
          return t("integrations.whatsapp.rows.waitForSend");
        case "ownMessages":
          return t("integrations.whatsapp.rows.ownMessages");
        default:
          return key;
      }
    };
    const valueOf = (key: string, v: unknown): Value => {
      const value = String(v);
      switch (key) {
        case "agentId":
          return { value, label: agentName(v) };
        case "trigger":
          return {
            value,
            label: t(
              dc
                ? v === "all"
                  ? "integrations.discord.routes.trigger.all"
                  : "integrations.discord.routes.trigger.mention"
                : v === "all"
                  ? "integrations.whatsapp.rows.trigger.all"
                  : "integrations.whatsapp.rows.trigger.mention",
            ),
          };
        case "replyMode":
          return {
            value,
            label: t(
              v === "bot"
                ? "integrations.discord.routes.replies.bot"
                : v === "read"
                  ? "integrations.discord.routes.replies.read"
                  : "integrations.discord.routes.replies.ask",
            ),
          };
        case "prefix":
          return { value, label: value || t("asks.action.off") };
        case "sendDirect":
          return { value, label: onOff(!v) };
        case "includeBots":
        case "react":
        case "ownMessages":
          return { value, label: onOff(v) };
        default:
          return { value, label: value };
      }
    };
    const target =
      typeof s.set.agentId === "string"
        ? agents.find((a) => a.id === s.set.agentId)
        : undefined;
    const member = memberUserId ? memberById(memberUserId) : undefined;
    const lines: ReactNode[] = [];
    if (target && !belowStandard(agentAccessOf(target)))
      lines.push(
        <div
          key="shell"
          data-ask-action-route-shell=""
          style={{ ...muted, color: "var(--orange-text)" }}
        >
          {t(
            dc
              ? "integrations.discord.routes.shellWarning"
              : "integrations.whatsapp.rows.shellWarning",
          )}
        </div>,
      );
    if (!isMember)
      lines.push(
        <div key="other" data-ask-action-route-other="" style={muted}>
          {rich("asks.action.routeOtherMember", {
            member: member ? <Data>{member.name}</Data> : "",
          })}
        </div>,
      );
    const routeName = (found as { name?: string } | undefined)?.name;
    return {
      name: t("asks.action.routeName", {
        app: dc ? "Discord" : "WhatsApp",
        name: routeName ?? s.routeId,
      }),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: label(key),
        ...(now ? { current: valueOf(key, now[key]) } : {}),
        requested: valueOf(key, value),
        ...(key === "sendDirect" && value === true
          ? { hint: t("integrations.whatsapp.rows.directHint") }
          : {}),
      })),
      loading: isMember && list === null,
      lines,
      marks: { "data-ask-action-route": s.routeId },
      gone:
        isMember && list !== null && !found ? t("asks.action.routeGone") : null,
      noApply: !isMember,
    };
  }

  // A row per key of `set`: the age now and the one asked (null: off), as
  // the Storage page names them.
  function storageRetentionView(s: Step<"storage-retention">): ActionView {
    const now = (fetched ?? null) as LogRetentionWire | null;
    const valueOf = (v: unknown): Value => ({
      value: String(v),
      label:
        typeof v === "number"
          ? tn("common.days", v)
          : t("settings.storage.autoDeleteOff"),
    });
    return {
      name: t("settings.storage.autoSection"),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: t(
          key === "deleteAfterDays"
            ? "settings.storage.autoDeleteAfter"
            : "settings.storage.autoCompressAfter",
        ),
        ...(now
          ? {
              current: valueOf(
                key === "deleteAfterDays"
                  ? now.deleteAfterDays
                  : now.compressAfterDays,
              ),
            }
          : {}),
        requested: valueOf(value),
        ...(key === "deleteAfterDays" && typeof value === "number" && now
          ? {
              hint: t("settings.storage.autoDeleteHint", {
                count: String(now.keepPerAgent),
              }),
            }
          : {}),
      })),
      loading: now === null,
      lines: [],
      marks: {},
      gone: null,
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
          {rich("asks.action.discordManager", {
            member: <Data>{manager.name}</Data>,
          })}
        </div>,
      );
    // No place matches: Apply cannot run, so the blocker is the one coloured
    // line.
    const dcNone = dcMember && dcBots !== null && dcPlaces.length === 0;
    if (target && !belowStandard(agentAccessOf(target)) && !dcNone)
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
          {rich("asks.action.discordOtherMember", {
            member: member ? <Data>{member.name}</Data> : "",
          })}
        </div>,
      );
    else if (dcNone)
      lines.push(
        <div
          key="none"
          data-ask-action-dc-none=""
          data-ask-action-blocker=""
          style={blocker}
        >
          {rich("asks.action.discordNoMatch", {
            name: <Data>{s.placeName}</Data>,
          })}
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
          {rich("asks.action.discordMoves", {
            agent: <Data>{agentName(route.agentId)}</Data>,
          })}
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
      case "messaging-route":
        return messagingRouteView(step);
      case "storage-retention":
        return storageRetentionView(step);
      case "instructions-line":
        return instructionsLineView(step);
      case "member-os-user":
        return memberOsUserView(step);
      case "sign-in-link-extend":
        return linkExtendView(step);
      case "member-avatar":
        return memberAvatarView(step);
    }
  })();

  // A kind that reads its value now (`loading` set) draws its value rows as
  // one grid whose columns do not depend on the value now (task 8e61bf71):
  // name or key, the value now (at most VALUE_NOW wide), the arrow, the
  // value asked. While it loads, a dimmed block fills the value-now cell, so
  // nothing moves when the value arrives, whatever its width.
  const grid = view.loading !== undefined;
  const cell = { minWidth: 0 };

  // One value row: the name or key, the value now, an arrow and the value
  // asked.
  function valueRow(
    name: ReactNode,
    current: Value | undefined,
    requested: Value | undefined,
    // The value now is the value asked: show the value asked only.
    same: boolean,
    // The labels are names or data, not copy: no page translation.
    raw: boolean,
  ): ReactNode {
    const rawProps = raw ? noTranslate() : {};
    const from = current && !same;
    const arrow =
      requested && (current ? !same : view.loading) ? (
        <span aria-hidden="true">→</span>
      ) : null;
    const to = requested && (
      <span
        data-ask-action-to=""
        {...rawProps}
        style={{ ...cell, fontWeight: 600, overflowWrap: "anywhere" }}
      >
        {requested.label}
      </span>
    );
    if (!grid) {
      return (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            columnGap: 8,
            alignItems: "baseline",
          }}
        >
          {name}
          {from ? (
            <span
              data-ask-action-from=""
              {...rawProps}
              style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}
            >
              {current.label}
            </span>
          ) : null}
          {arrow}
          {to}
        </div>
      );
    }
    if (!requested)
      return <div style={{ gridColumn: "1 / -1", ...cell }}>{name}</div>;
    return (
      <div style={{ display: "contents" }}>
        <span style={{ ...cell, overflowWrap: "anywhere" }}>{name}</span>
        <span
          style={{
            ...cell,
            minHeight: "1.5em",
            display: "flex",
            alignItems: "center",
          }}
        >
          {from ? (
            <span
              key="from"
              data-ask-action-from=""
              {...rawProps}
              style={{
                ...cell,
                color: "var(--text-muted)",
                overflowWrap: "anywhere",
              }}
            >
              {current.label}
            </span>
          ) : (
            !current &&
            view.loading && (
              <span
                key="loading"
                data-ask-action-loading=""
                aria-hidden="true"
                style={{
                  flex: 1,
                  height: "0.9em",
                  borderRadius: 4,
                  background: "var(--bg-surface)",
                }}
              />
            )
          )}
        </span>
        <span>{arrow}</span>
        {to}
      </div>
    );
  }

  const valueRows = (
    <>
      {valueRow(
        <span {...noTranslate()} style={{ fontWeight: 600 }}>
          {view.name}
        </span>,
        view.current,
        view.requested,
        false,
        false,
      )}
      {view.rows?.map((row) => (
        <div
          key={row.key}
          data-ask-action-key={row.key}
          {...(row.current
            ? { "data-ask-action-current": row.current.value }
            : {})}
          data-ask-action-requested={row.requested.value}
          style={grid ? { display: "contents" } : { marginTop: 2 }}
        >
          {valueRow(
            <span>{row.label}</span>,
            row.current,
            row.requested,
            !!row.current && sameValue(row.current, row.requested),
            true,
          )}
          {row.hint && (
            <div
              data-ask-action-hint=""
              style={grid ? { ...muted, gridColumn: "1 / -1" } : muted}
            >
              {row.hint}
            </div>
          )}
        </div>
      ))}
    </>
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
      {grid ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `auto minmax(0, ${VALUE_NOW}) 1em minmax(${VALUE_ASKED}, 1fr)`,
            columnGap: 8,
            rowGap: 2,
            alignItems: "start",
          }}
        >
          {valueRows}
        </div>
      ) : (
        valueRows
      )}
      {view.lines}
      {view.gone !== null ? (
        view.goneDone ? (
          <div style={muted}>{view.gone}</div>
        ) : (
          <div data-ask-action-blocker="" style={blocker}>
            {view.gone}
          </div>
        )
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
            ? t(actionButtonKey(step))
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
