// Action steps on a member or an agent: room access, role, pack, the
// member's own preferences and room lists, avatar, OS user, removal.
// One family of server/step-asks.ts (STEP_FAMILY in
// server/step-asks-common.ts).

import {
  packNotAccepted,
  parseAgentAccessGrant,
  sameAccessGrant,
} from "../shared/agent-access.ts";
import {
  LOBBY_ROOM_ID,
  type ActionStepRequest,
  type AskStep,
  type MemberOsUserStep,
  type MemberViewList,
} from "../shared/types.ts";
import {
  ASK_PREFERENCE_KEYS,
  OS_USER_NAME_PATTERN,
} from "../shared/contract-shapes.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import {
  GHOST_VARIANTS,
  isGhostVariant,
  isHexColor,
  normalizeHexColor,
} from "../shared/avatar.ts";
import { parseMemberPack, samePack } from "../shared/pack-fit.ts";
import { DEFAULT_VOICE_NAME } from "../shared/voice.ts";
import { parsePreferenceChange } from "./routes/handlers/preferences.ts";
import type {
  MemberSettings,
  StepAskDeps,
  StepFailure,
  StepRoute,
  StepRun,
  StepRunDeps,
} from "./step-asks.ts";
import {
  allSet,
  firstRoute,
  invalid,
  isObject,
  notAllowed,
  ownerHasAllRooms,
  ownerHasNoPack,
  unknownMember,
  unknownRoom,
  type CompleteInput,
  type FamilyStep,
  type StepFamily,
} from "./step-asks-common.ts";

type S = FamilyStep<"members">;

const VIEW_LISTS: readonly string[] = ["shown", "tucked", "notif", "push"];

// The preferences as they apply: a record with no voice value has the
// default, and no language is null.
function effectivePreferences(m: MemberSettings): Record<string, unknown> {
  return {
    language: m.language ?? null,
    voiceInput: m.voiceInput ?? "browser",
    voiceOutput: m.voiceOutput ?? "browser",
    voiceName: m.voiceName ?? DEFAULT_VOICE_NAME,
    showToolCalls: m.showToolCalls === true,
    showAgentMessages: m.showAgentMessages === true,
  };
}

// Whether the room is on the member's list now. A hidden room is not shown.
function onList(
  m: MemberSettings,
  list: MemberViewList,
  roomId: string,
): boolean {
  switch (list) {
    case "shown":
      return m.accessible.includes(roomId) && !m.hidden.includes(roomId);
    case "tucked":
      return m.tucked.includes(roomId);
    case "notif":
      return m.notifRooms.includes(roomId);
    case "push":
      return m.pushRooms.includes(roomId);
  }
}

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: S, target: string): LogMessage {
  switch (step.kind) {
    case "member-os-user":
      return step.on
        ? msg("systemEntries.stepAsk.memberOsUserOn", { member: target })
        : msg("systemEntries.stepAsk.memberOsUserOff", { member: target });
    case "member-avatar":
      return msg("systemEntries.stepAsk.memberAvatarSet", { member: target });
    case "agent-access":
      return msg("systemEntries.stepAsk.agentAccessSet", { agent: target });
    case "member-room":
      return msg("systemEntries.stepAsk.memberRoomSet", { member: target });
    case "member-role":
      return msg("systemEntries.stepAsk.memberRoleSet", { member: target });
    case "member-pack":
      return msg("systemEntries.stepAsk.memberPackSet", { member: target });
    case "member-preferences":
      return msg("systemEntries.stepAsk.preferencesSet");
    case "member-view":
      return msg("systemEntries.stepAsk.roomViewSet", { room: target });
    case "member-remove":
      return msg("systemEntries.stepAsk.memberRemoved", { member: target });
    case "member-restore":
      return msg("systemEntries.stepAsk.memberRestored", { member: target });
    // Neutral: the 30 days running out deletes them too. The name is gone
    // with the member.
    case "member-purge":
      return msg("systemEntries.stepAsk.memberPurged");
  }
}

export function createMemberSteps(deps: StepAskDeps): StepFamily<S> {
  // Why a member-view step cannot run on the member's lists now, or null.
  // The view core drops notifications and pushes for a hidden or tucked room
  // without an error, so the step is refused before it runs.
  function viewRefusal(
    m: MemberSettings,
    step: Extract<AskStep, { kind: "member-view" }>,
  ): StepFailure | null {
    if (!m.accessible.includes(step.roomId)) return unknownRoom();
    if (!step.on || (step.list !== "notif" && step.list !== "push"))
      return null;
    if (m.hidden.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_hidden",
        message: "the member hides this room: show it first",
      };
    if (m.tucked.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_tucked",
        message: "the member tucked this room away: untuck it first",
      };
    return null;
  }

  // The member's list with the room on or off.
  function viewList(
    m: MemberSettings,
    list: MemberViewList,
    roomId: string,
    on: boolean,
  ): string[] {
    const now =
      list === "shown"
        ? m.accessible.filter((id) => !m.hidden.includes(id))
        : list === "tucked"
          ? m.tucked
          : list === "notif"
            ? m.notifRooms
            : m.pushRooms;
    const rest = now.filter((id) => id !== roomId);
    return on ? [...rest, roomId] : rest;
  }

  // The Members page's Run of a member-os-user step, under the member's
  // name now, or null when they are gone. The target comes from the step;
  // the card gives only the password, sent only when it is a string.
  function osUserRoute(
    step: MemberOsUserStep,
    pick: unknown,
  ): StepRoute | null {
    const name = deps.runs?.member(step.userId)?.name;
    if (name === undefined) return null;
    const password =
      isObject(pick) && typeof pick.password === "string"
        ? pick.password
        : undefined;
    return {
      method: "POST",
      path: `/api/users/${encodeURIComponent(name)}/os-user/run`,
      body: {
        action: step.on ? "enable" : "disable",
        ...(step.osUser === undefined ? {} : { osUser: step.osUser }),
        ...(step.existing ? { existing: true } : {}),
        ...(password === undefined ? {} : { password }),
      },
    };
  }

  // Why a member-os-user step cannot run on the member's OS user now, or
  // null: what the root command refuses since the state changed, and a run
  // or a move that goes on (the Run route knows only its own runs).
  function osUserRunRefusal(
    step: MemberOsUserStep,
    checkBusy = true,
  ): StepFailure | null {
    const now = deps.runs?.memberOsUser(step.userId);
    if (!now) return null;
    if (step.osUser !== undefined && now.state !== "off")
      return {
        ok: false,
        status: 409,
        code: "os_user_on",
        message:
          "the member has an OS user: leave out osUser to finish or run the enable again, or turn the OS user off first",
      };
    if (!step.on && now.movedIn)
      return {
        ok: false,
        status: 409,
        code: "moved_in",
        message:
          "the member came with an office move, and turning their OS user off deletes the files it moved: the office owner runs the disable command from GET /api/users/:username/os-user (commands.disable) by hand",
      };
    if (
      checkBusy &&
      (now.attempt?.status === "running" || now.state === "moving")
    )
      return {
        ok: false,
        status: 409,
        code: "run_in_progress",
        message:
          "the member's root command runs, or their files move: try again when it ends",
      };
    return null;
  }

  // The create's checks of a member-os-user step after the done check: the
  // office can run the command, the state lets it run, and the name the step
  // gives is one the box has (existing) or one it does not (new), where the
  // box's names were read in full.
  async function osUserCreateRefusal(
    step: MemberOsUserStep,
  ): Promise<StepFailure | null> {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    const name = runs.member(step.userId)?.name ?? ":username";
    if ((await runs.osUserRunMode()) === null)
      return {
        ok: false,
        status: 409,
        code: "run_unavailable",
        message: `this office cannot run the member's root command itself: give the office owner the command in commands of GET /api/users/${encodeURIComponent(name)}/os-user to run as root`,
      };
    const refused = osUserRunRefusal(step, false);
    if (refused) return refused;
    if (step.osUser === undefined) return null;
    const names = await runs.osUserNames();
    if (step.existing) {
      if (names.existing && !names.existing.includes(step.osUser))
        return {
          ok: false,
          status: 422,
          code: "unknown_os_user",
          message: `no existing OS user of this name that a member can get: candidates of GET /api/users/${encodeURIComponent(name)}/os-user lists them`,
        };
    } else if (names.taken?.includes(step.osUser))
      return {
        ok: false,
        status: 422,
        code: "os_user_taken",
        message:
          "an OS user or group of this name exists: name another new user, or send existing: true for an existing user from candidates",
      };
    return null;
  }

  // Whether the step is done now, for the member the ask is for (isDone in
  // server/step-asks.ts).
  async function isDone(
    step: S,
    memberUserId: string,
    _since: number | null,
  ): Promise<boolean> {
    switch (step.kind) {
      // On (as the named user, when the step names one), or off. Not ready,
      // moving and broken are never done.
      case "member-os-user": {
        const now = deps.runs?.memberOsUser(step.userId);
        if (!now) return false;
        if (!step.on) return now.state === "off";
        return (
          now.state === "on" &&
          (step.osUser === undefined || now.osUser?.name === step.osUser)
        );
      }
      // Each field the step names has its value.
      case "member-avatar": {
        const member = deps.runs?.member(step.userId);
        return (
          !!member &&
          (step.avatarColor === undefined ||
            member.avatarColor === step.avatarColor) &&
          (step.avatarVariant === undefined ||
            member.avatarVariant === step.avatarVariant)
        );
      }
      case "agent-access": {
        const agent = deps.runs?.agent(step.agentId);
        return !!agent && sameAccessGrant(agent.grant, step);
      }
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return false;
        // An owner reaches every room by rule.
        if (step.grant && member.role === "owner") return true;
        return member.allowedRooms.includes(step.roomId) === step.grant;
      }
      case "member-role":
        return deps.runs?.member(step.userId)?.role === step.role;
      case "member-pack": {
        const member = deps.runs?.memberSettings(step.userId);
        return !!member && samePack(member.pack, step.pack);
      }
      case "member-preferences": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && allSet(step.set, effectivePreferences(member));
      }
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && onList(member, step.list, step.roomId) === step.on;
      }
      case "member-remove":
        return !!deps.runs && deps.runs.member(step.userId) === null;
      case "member-restore":
        return !!deps.runs?.member(step.userId);
      // Neither removed nor live: a restore since the create is not done.
      case "member-purge":
        return (
          !!deps.runs &&
          deps.runs.removedMember(step.userId) === null &&
          deps.runs.member(step.userId) === null
        );
    }
  }

  // The step as the agent sent it, completed, or why it is refused. The
  // core checked its kind, its keys and its scope.
  function complete(
    body: Record<string, unknown>,
    kind: S["kind"],
    input: CompleteInput,
  ): { ok: true; step: AskStep } | StepFailure {
    const { memberUserId, managerUserId } = input;
    switch (kind) {
      case "member-os-user": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (typeof body.on !== "boolean")
          return invalid(
            "step.on is true (turn the OS user on) or false (turn it off)",
          );
        const { osUser, existing } = body;
        if (!body.on && (osUser !== undefined || existing !== undefined))
          return invalid("step.osUser and step.existing are for on: true");
        if (
          osUser !== undefined &&
          (typeof osUser !== "string" || !OS_USER_NAME_PATTERN.test(osUser))
        )
          return invalid(
            "step.osUser is an OS user name: lowercase letters, digits, _ and -, at most 32",
          );
        if (existing !== undefined && typeof existing !== "boolean")
          return invalid("step.existing is true or false");
        if (existing !== undefined && osUser === undefined)
          return invalid("step.existing needs step.osUser");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step: {
            kind,
            userId,
            on: body.on,
            ...(typeof osUser === "string" ? { osUser } : {}),
            ...(existing === true ? { existing: true } : {}),
          },
        };
      }
      // A colour as the record stores it, a shape it takes, or both.
      case "member-avatar": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        const { avatarColor, avatarVariant } = body;
        if (avatarColor === undefined && avatarVariant === undefined)
          return invalid(
            "a member-avatar step sets avatarColor, avatarVariant or both",
          );
        if (avatarColor !== undefined && !isHexColor(avatarColor))
          return invalid("step.avatarColor is a colour as #rrggbb");
        if (avatarVariant !== undefined && !isGhostVariant(avatarVariant))
          return invalid(
            `step.avatarVariant is one of ${GHOST_VARIANTS.join(", ")}`,
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step: {
            kind,
            userId,
            ...(avatarColor !== undefined
              ? { avatarColor: normalizeHexColor(avatarColor) }
              : {}),
            ...(avatarVariant !== undefined ? { avatarVariant } : {}),
          },
        };
      }
      case "agent-access": {
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        // A pack is refused, not dropped: the stop alone sets the token
        // limits, so a narrow pack would give a wider grant.
        if ("pack" in body) return invalid(packNotAccepted("step.pack"));
        const grant = parseAgentAccessGrant({ access: body.access });
        if (!grant)
          return invalid(
            "step.access is a stop (chat, office, folder, web, standard, privileged)",
          );
        return {
          ok: true,
          step: { kind, agentId: body.agentId, access: grant.access },
        };
      }
      case "member-pack": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        // The stored pack is the parsed one, so the done predicate compares
        // like with like.
        const pack = body.pack === null ? null : parseMemberPack(body.pack);
        if (!("pack" in body) || (pack === null && body.pack !== null))
          return invalid(
            "step.pack is {areas, agentCeiling}: known areas at read or write, and a ceiling of chat, office, folder or web; or null for no pack",
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return { ok: true, step: { kind, userId, pack } };
      }
      case "member-preferences":
      case "member-view": {
        // The member's own record: their agent acts for them already, and
        // another member's preferences and lists are private.
        if (!managerUserId || memberUserId !== managerUserId)
          return invalid(
            "a member's preferences and room lists are their own: ask your manager",
          );
        if (kind === "member-preferences") {
          if (!isObject(body.set))
            return invalid("step.set is an object of preferences");
          const parsed = parsePreferenceChange(body.set, ASK_PREFERENCE_KEYS);
          if (!parsed.ok) return invalid(`step.set: ${parsed.message}`);
          // ASK_PREFERENCE_KEYS refuses the word list and the dismiss list,
          // so this drops nothing.
          const {
            recordingWords: _refused,
            inboxDismissed: _refusedToo,
            ...set
          } = parsed.change;
          return { ok: true, step: { kind, set } };
        }
        if (typeof body.list !== "string" || !VIEW_LISTS.includes(body.list))
          return invalid(`step.list is one of ${VIEW_LISTS.join(", ")}`);
        if (typeof body.roomId !== "string" || body.roomId === "")
          return invalid("step.roomId is one room id");
        if (typeof body.on !== "boolean")
          return invalid("step.on is true (on the list) or false (off it)");
        return {
          ok: true,
          step: {
            kind,
            list: body.list as MemberViewList,
            roomId: body.roomId,
            on: body.on,
          },
        };
      }
      case "member-remove":
      case "member-restore":
      case "member-purge": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (
          kind === "member-restore" &&
          body.agents !== undefined &&
          typeof body.agents !== "boolean"
        )
          return invalid(
            "step.agents is true (their agents, schedules and webhooks come back) or false",
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        // A removal is of a live member; a restore or a delete for good, of
        // a removed one.
        const userId =
          kind === "member-remove"
            ? deps.runs.memberIdByName(body.username)
            : deps.runs.removedMemberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step:
            kind === "member-restore"
              ? { kind, userId, agents: (body.agents as boolean) ?? true }
              : { kind, userId },
        };
      }
      case "member-room":
      case "member-role": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (kind === "member-room") {
          if (typeof body.roomId !== "string" || body.roomId === "")
            return invalid("step.roomId is one room id");
          if (typeof body.grant !== "boolean")
            return invalid(
              "step.grant is true (give the room) or false (take it)",
            );
        } else if (body.role !== "owner" && body.role !== "member")
          return invalid("step.role is owner or member");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step:
            kind === "member-room"
              ? {
                  kind,
                  userId,
                  roomId: body.roomId as string,
                  grant: body.grant as boolean,
                }
              : { kind, userId, role: body.role as "owner" | "member" },
        };
      }
    }
  }

  // The route an action step runs now (routeOf in server/step-asks.ts).
  function routeOf(
    step: S,
    memberUserId: string,
    _callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null {
    switch (step.kind) {
      case "member-os-user": {
        const route = osUserRoute(step, pick);
        if (!route) return unknownMember();
        const refused = osUserRunRefusal(step);
        return refused ?? { ok: true, routes: [route] };
      }
      case "agent-access":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/agents/${encodeURIComponent(step.agentId)}/access`,
              // A step an older version stored with a pack sends the stop
              // alone: the stop decides the token limits.
              body: { access: step.access },
            },
          ],
        };
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        // A member made an owner since the create reaches every room: a
        // removal would write a list that changes nothing they reach.
        if (member.role === "owner") return ownerHasAllRooms();
        if (step.grant && !deps.runs!.roomOpen(step.roomId))
          return unknownRoom();
        const rooms = member.allowedRooms.filter((id) => id !== step.roomId);
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/users/${encodeURIComponent(member.name)}/access`,
              body: {
                allowedRooms: step.grant ? [...rooms, step.roomId] : rooms,
              },
            },
          ],
        };
      }
      case "member-role": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/users/${encodeURIComponent(member.name)}`,
              body: { role: step.role },
            },
          ],
        };
      }
      case "member-pack": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        if (member.role === "owner") return ownerHasNoPack();
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/users/${encodeURIComponent(member.name)}/access`,
              // The rooms now, so a room given since the create stays; null
              // clears the pack (an absent one would keep it).
              body: { allowedRooms: [...member.allowedRooms], pack: step.pack },
            },
          ],
        };
      }
      case "member-preferences":
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: "/api/me/preferences",
              body: step.set,
            },
          ],
        };
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        const rooms = viewList(member, step.list, step.roomId, step.on);
        const [path, field] = {
          shown: ["shown", "shown"],
          tucked: ["tucked", "tucked"],
          notif: ["notif-rooms", "notifRooms"],
          push: ["push-rooms", "pushRooms"],
        }[step.list];
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/me/view/${path}`,
              body: { [field]: rooms },
            },
          ],
        };
      }
      // Only the fields asked: a field changed by hand since stays.
      case "member-avatar": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/users/${encodeURIComponent(member.name)}`,
              body: {
                ...(step.avatarColor !== undefined
                  ? { avatarColor: step.avatarColor }
                  : {}),
                ...(step.avatarVariant !== undefined
                  ? { avatarVariant: step.avatarVariant }
                  : {}),
              },
            },
          ],
        };
      }
      // The name now: a rename since the create does not lose the member.
      case "member-remove": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/users/${encodeURIComponent(member.name)}`,
            },
          ],
        };
      }
      // A member restored or deleted since the create is not in Removed
      // members: the run is refused and deletes nothing.
      case "member-restore":
      case "member-purge": {
        if (!deps.runs?.removedMember(step.userId)) return unknownMember();
        const path = `/api/removed-members/${encodeURIComponent(step.userId)}`;
        return {
          ok: true,
          routes: [
            step.kind === "member-restore"
              ? {
                  method: "POST",
                  path: `${path}/restore`,
                  body: { agents: step.agents },
                }
              : { method: "DELETE", path },
          ],
        };
      }
    }
  }

  // Why the member could not run an action step, or null (actionRefusal
  // in server/step-asks.ts).
  function actionRefusal(
    step: Extract<ActionStepRequest, S>,
    askingAgentId: string | undefined,
    memberUserId: string,
    runs: StepRunDeps,
  ): StepFailure | null {
    switch (step.kind) {
      // The rest is osUserCreateRefusal's, after the done check.
      case "member-os-user": {
        const route = osUserRoute(step, undefined);
        if (!route) return unknownMember();
        return runs.authorizeAs(memberUserId, route)
          ? notAllowed(
              "only an office owner can turn a member's OS user on or off",
            )
          : null;
      }
      // An owner for anyone, a member for themself.
      case "member-avatar":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              "only an office owner can change another member's avatar",
            )
          : null;
      case "agent-access": {
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return {
            ok: false,
            status: 422,
            code: "unknown_agent",
            message: "no agent with this id in a room you can reach",
          };
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("this member cannot change that agent's access");
        const refusal = runs.accessRefusal(step.agentId, step);
        return refusal
          ? {
              ok: false,
              status: 422,
              code: refusal.code,
              message: refusal.message,
            }
          : null;
      }
      case "member-room": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        if (step.roomId === LOBBY_ROOM_ID)
          return {
            ok: false,
            status: 422,
            code: "lobby_open_to_all",
            message: "every member reaches the lobby",
          };
        if (runs.member(step.userId)?.role === "owner")
          return ownerHasAllRooms();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's room access")
          : null;
      }
      case "member-role": {
        // The page lets a member edit their own record, and its handler
        // refuses the role: only an owner changes one.
        if (
          !deps.isOfficeOwner(memberUserId) ||
          runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
        )
          return notAllowed("only an office owner can change a member's role");
        return step.role === "member" && runs.lastOwner(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "last_owner",
              message: "the office must have at least one office owner",
            }
          : null;
      }
      case "member-pack": {
        if (runs.member(step.userId)?.role === "owner") return ownerHasNoPack();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's permission pack")
          : null;
      }
      case "member-preferences":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their preferences")
          : null;
      case "member-view": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        const member = runs.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their room lists")
          : null;
      }
      // The route lets a member remove themself and an owner anyone but
      // themself; the office keeps an owner record and an owner session.
      case "member-remove": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("only an office owner can remove another member");
        if (step.userId === memberUserId && deps.isOfficeOwner(memberUserId))
          return {
            ok: false,
            status: 403,
            code: "owner_self_delete",
            message:
              "An owner can't delete their own user record. Sign out from this session or transfer ownership first.",
          };
        return runs.lastOwner(step.userId) ||
          runs.signOutStrandsOffice(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message: "the office must keep an office owner who is signed in",
            }
          : null;
      }
      case "member-restore":
      case "member-purge":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              step.kind === "member-restore"
                ? "only an office owner can restore a member"
                : "only an office owner can delete a removed member",
            )
          : null;
    }
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: S): string {
    switch (step.kind) {
      case "agent-access":
        return deps.runs?.agent(step.agentId)?.name ?? step.agentId;
      case "member-room":
      case "member-role":
      case "member-pack":
      case "member-os-user":
      case "member-avatar":
        return deps.runs?.member(step.userId)?.name ?? step.userId;
      case "member-view":
        return deps.runs?.roomName(step.roomId) ?? step.roomId;
      // Removed now, or back.
      case "member-remove":
      case "member-restore":
        return (
          deps.runs?.member(step.userId)?.name ??
          deps.runs?.removedMember(step.userId)?.name ??
          step.userId
        );
      default:
        return "";
    }
  }

  // The create's check after the done check.
  async function afterDone(step: S): Promise<StepFailure | null> {
    if (step.kind === "member-os-user") {
      const refused = await osUserCreateRefusal(step);
      if (refused) return refused;
    }
    return null;
  }

  const runRoute = (
    step: Extract<ActionStepRequest, S>,
    memberUserId: string,
  ): StepRoute => firstRoute(routeOf, step, memberUserId);

  return {
    doneLine,
    isDone,
    complete,
    routeOf,
    actionRefusal,
    targetName,
    afterDone,
  };
}
