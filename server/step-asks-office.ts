// Action steps on the office: settings, backup, access, update, storage
// and instructions lines. One family of server/step-asks.ts
// (STEP_FAMILY in server/step-asks-common.ts).

import type {
  ActionStepRequest,
  AskStep,
  InstructionsLineStep,
  InstructionsLineStepRun,
  InstructionsScope,
} from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { ASK_RULE_LINE_MAX } from "./asks.ts";
import { isRunnableCommand } from "../shared/runnable-command.ts";
import { backupSettingsShapeError } from "./backup.ts";
import { hostedAccessRule } from "./install-kind.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import {
  OFFICE_NAME_MAX,
  OFFICE_SETTINGS_SWITCHES,
  officeSettingsFieldError,
} from "./routes/handlers/office-settings.ts";
import {
  MIN_OLDER_THAN_DAYS,
  parsePruneRequest,
} from "./routes/handlers/storage.ts";
import { compareCalver } from "./update-checker.ts";
import type { StorageApplied } from "./office-storage-routes.ts";
import { logRetentionSettingsShapeError } from "./storage-retention.ts";
import type {
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
  type CompleteInput,
  type FamilyStep,
  type StepFamily,
} from "./step-asks-common.ts";

type S = FamilyStep<"office">;

// An instructions-line step's text (task 33891b5b), as the scope's
// instructions hold it, and the text with the line added at its end, on its
// own line. A line is in the text when one of its lines, trimmed, is it.
function holdsLine(text: string | null, line: string): boolean {
  const want = line.trim();
  return (text ?? "").split("\n").some((l) => l.trim() === want);
}
function withLine(text: string | null, line: string): string {
  const now = text ?? "";
  if (now === "") return line;
  return now.endsWith("\n") ? `${now}${line}` : `${now}\n${line}`;
}
// Why a line cannot be an instructions line, or null: it goes verbatim into
// a system prompt, so one line that shows all it holds.
function lineRefusal(line: unknown): string | null {
  if (typeof line !== "string" || line.trim() === "")
    return "step.line is the line to add";
  if (line.includes("\n")) return "step.line is one line";
  if (line.length > ASK_RULE_LINE_MAX)
    return `step.line is at most ${ASK_RULE_LINE_MAX} characters`;
  if (!isRunnableCommand(line))
    return "step.line has characters that do not show";
  return null;
}
const INSTRUCTIONS_SCOPES: readonly InstructionsScope[] = [
  "agent",
  "room",
  "member",
];

// Whether an applied prune or compress covers the step: applied since the ask
// opened, at the step's age line or a newer one, keeping as many per agent or
// fewer.
function covers(
  applied: StorageApplied | null,
  since: number,
  olderThanDays: number,
  keepPerAgent: number,
): boolean {
  return (
    !!applied &&
    applied.at >= since &&
    applied.olderThanDays <= olderThanDays &&
    applied.keepPerAgent <= keepPerAgent
  );
}

// The keys a settings step may set.
const OFFICE_SET_KEYS: readonly string[] = [
  "name",
  "memberUsageShare",
  ...OFFICE_SETTINGS_SWITCHES,
];
const BACKUP_SET_KEYS: readonly string[] = [
  "intervalHours",
  "retention",
  "dir",
];

const RETENTION_SET_KEYS: readonly string[] = [
  "compressAfterDays",
  "deleteAfterDays",
];

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: S, _target: string): LogMessage {
  switch (step.kind) {
    case "office-settings":
      return msg("systemEntries.stepAsk.officeSettingsSet");
    case "backup-settings":
      return msg("systemEntries.stepAsk.backupSettingsSet");
    case "office-access":
      return msg("systemEntries.stepAsk.officeAccessSet");
    case "office-update":
      return msg("systemEntries.stepAsk.officeUpdated", { release: step.tag });
    case "storage-prune":
      return msg("systemEntries.stepAsk.storagePruned");
    case "storage-compress":
      return msg("systemEntries.stepAsk.storageCompressed");
    case "storage-retention":
      return msg("systemEntries.stepAsk.storageRetentionSet");
    case "instructions-line":
      return msg("systemEntries.stepAsk.instructionsLineAdded");
  }
}

export function createOfficeSteps(deps: StepAskDeps): StepFamily<S> {
  // The one PUT that adds an instructions line, with the version read now:
  // a write between this read and the PUT is the route's own 409.
  function instructionsRoute(step: InstructionsLineStep): StepRun {
    const runs = deps.runs;
    const now = runs?.instructions(step.scope, step.targetId);
    const name =
      step.scope === "member" ? runs?.member(step.targetId)?.name : undefined;
    const path =
      step.scope === "agent"
        ? `/api/agents/${encodeURIComponent(step.targetId)}/instructions`
        : step.scope === "room"
          ? `/api/rooms/${encodeURIComponent(step.targetId)}/instructions`
          : name
            ? `/api/users/${encodeURIComponent(name)}/instructions`
            : null;
    if (!runs || !now || !path)
      return {
        ok: false,
        status: 422,
        code: "unknown_target",
        message: "these instructions are gone",
      };
    return {
      ok: true,
      routes: [
        {
          method: "PUT",
          path,
          body: {
            instructions: withLine(now.text, step.line),
            version: now.version,
          },
        },
      ],
    };
  }

  // Whether the step is done now, for the member the ask is for (isDone in
  // server/step-asks.ts).
  async function isDone(
    step: S,
    _memberUserId: string,
    since: number | null,
  ): Promise<boolean> {
    switch (step.kind) {
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        return !!now && allSet(step.set, now);
      }
      case "backup-settings": {
        const now = deps.runs?.backupSettings();
        return !!now && allSet(step.set, now);
      }
      case "office-access": {
        const now = deps.runs?.officeAccess();
        return (
          !!now &&
          now.externalAccess === step.externalAccess &&
          (now.publicOrigin ?? "") === step.publicOrigin
        );
      }
      // The release asked for or a later one runs.
      case "office-update": {
        const running = deps.runs?.updateStatus().current.release;
        return !!running && compareCalver(running, step.tag) >= 0;
      }
      // At the create: nothing to take. Then: an apply that covers the step
      // (the office's stamp, not a plan, so reconcile walks no disk).
      case "storage-prune": {
        const runs = deps.runs;
        if (!runs) return false;
        const keep = step.keepPerAgent ?? 0;
        return since === null
          ? runs.pruneCandidates(step.target, step.olderThanDays, keep) === 0
          : covers(
              runs.lastPrune(step.target),
              since,
              step.olderThanDays,
              keep,
            );
      }
      case "storage-compress": {
        const runs = deps.runs;
        if (!runs) return false;
        return since === null
          ? runs.compressCandidates(step.olderThanDays) === 0
          : covers(runs.lastCompress(), since, step.olderThanDays, 0);
      }
      case "storage-retention": {
        const now = deps.runs?.logRetention();
        return !!now && allSet(step.set, now);
      }
      case "instructions-line":
        return holdsLine(
          deps.runs?.instructions(step.scope, step.targetId)?.text ?? null,
          step.line,
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
    const { managerUserId } = input;
    switch (kind) {
      case "office-settings":
      case "backup-settings": {
        const keys =
          kind === "office-settings" ? OFFICE_SET_KEYS : BACKUP_SET_KEYS;
        const set = body.set;
        if (!isObject(set) || Object.keys(set).length === 0)
          return invalid(
            `step.set is an object of one or more of ${keys.join(", ")}`,
          );
        const unknown = Object.keys(set).filter((key) => !keys.includes(key));
        if (unknown.length > 0)
          return invalid(`step.set takes only ${keys.join(", ")}`);
        if (kind === "backup-settings") {
          const bad = backupSettingsShapeError(set);
          if (bad) return invalid(`step.set: ${bad}`);
          return { ok: true, step: { kind, set } };
        }
        if ("name" in set && set.name !== null && typeof set.name !== "string")
          return invalid("step.set: name is a string, or null for none");
        const bad = officeSettingsFieldError(set);
        if (bad) return invalid(`step.set: ${bad}`);
        if (!deps.runs) return invalid("this office runs no action steps");
        // The name as the save stores it: trimmed, and none when empty.
        if (typeof set.name === "string") {
          const name = set.name.trim();
          if (name.length > OFFICE_NAME_MAX)
            return invalid(
              `step.set: the office name is ${OFFICE_NAME_MAX} characters or fewer`,
            );
          return {
            ok: true,
            step: { kind, set: { ...set, name: name || null } },
          };
        }
        return { ok: true, step: { kind, set } };
      }
      // The address as the save stores it: trimmed and normalised, "" for
      // none.
      case "office-access": {
        if (typeof body.externalAccess !== "boolean")
          return invalid("step.externalAccess is true or false");
        if (typeof body.publicOrigin !== "string")
          return invalid('step.publicOrigin is an address, or "" for none');
        const raw = body.publicOrigin.trim();
        const origin = raw ? normalizePublicOrigin(raw) : null;
        if (raw && !origin)
          return invalid(
            "step.publicOrigin is https://<host> or http://localhost (no path, query, or fragment)",
          );
        if (body.externalAccess && !origin)
          return invalid("outside access needs step.publicOrigin");
        return {
          ok: true,
          step: {
            kind,
            externalAccess: body.externalAccess,
            publicOrigin: origin ?? "",
          },
        };
      }
      // The latest release the checker knows, on a box whose updater the
      // page runs (release mode, applied by the host).
      case "office-update": {
        if (!deps.runs) return invalid("this office runs no action steps");
        const status = deps.runs.updateStatus();
        if (status.mode !== "release" || status.apply.kind !== "host")
          return {
            ok: false,
            status: 409,
            code: "not_managed",
            message:
              "this office has no updater to run: it updates as its host deploys it",
          };
        if (!status.latest)
          return {
            ok: false,
            status: 409,
            code: "no_release",
            message: "the update checker knows no release yet",
          };
        return { ok: true, step: { kind, tag: status.latest.tag } };
      }
      // As the route parses an apply.
      case "storage-prune": {
        const { kind: _, ...rest } = body;
        const parsed = parsePruneRequest(rest, true);
        if (!parsed.ok) return invalid(`step: ${parsed.message}`);
        const { target, olderThanDays, keepPerAgent } = parsed.req;
        return {
          ok: true,
          step: {
            kind,
            target,
            olderThanDays,
            ...(keepPerAgent === undefined ? {} : { keepPerAgent }),
          },
        };
      }
      case "storage-compress": {
        const days = body.olderThanDays;
        if (
          typeof days !== "number" ||
          !Number.isInteger(days) ||
          days < MIN_OLDER_THAN_DAYS
        )
          return invalid(
            `step.olderThanDays is an integer of at least ${MIN_OLDER_THAN_DAYS}`,
          );
        return { ok: true, step: { kind, olderThanDays: days } };
      }
      case "storage-retention": {
        const set = body.set;
        if (!isObject(set) || Object.keys(set).length === 0)
          return invalid(
            `step.set is an object of one or more of ${RETENTION_SET_KEYS.join(", ")}`,
          );
        if (!Object.keys(set).every((key) => RETENTION_SET_KEYS.includes(key)))
          return invalid(
            `step.set takes only ${RETENTION_SET_KEYS.join(", ")}`,
          );
        const bad = logRetentionSettingsShapeError(set);
        if (bad) return invalid(`step.set: ${bad}`);
        return { ok: true, step: { kind, set } };
      }
      // The target is the asking agent's own: itself, its room or its
      // manager, fixed here (task 33891b5b).
      case "instructions-line": {
        const scope = body.scope as InstructionsScope;
        if (!INSTRUCTIONS_SCOPES.includes(scope))
          return invalid(
            `step.scope is one of ${INSTRUCTIONS_SCOPES.join(", ")}`,
          );
        const bad = lineRefusal(body.line);
        if (bad) return invalid(bad);
        const targetId =
          scope === "agent"
            ? input.agentId
            : scope === "room"
              ? input.roomId
              : managerUserId;
        if (!targetId)
          return invalid(
            scope === "member"
              ? "this agent has no manager"
              : "a step the member runs needs the asking agent",
          );
        return {
          ok: true,
          step: { kind, scope, line: body.line as string, targetId },
        };
      }
    }
  }

  // The route an action step runs now (routeOf in server/step-asks.ts).
  function routeOf(
    step: S,
    _memberUserId: string,
    _callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null {
    switch (step.kind) {
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        if (!now) return invalid("this office runs no action steps");
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/office/settings",
              // The version now: an omitted setting keeps its value.
              body: { version: now.version, ...step.set },
            },
          ],
        };
      }
      case "backup-settings":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/backup/settings",
              body: step.set,
            },
          ],
        };
      case "office-access":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/office/access",
              body: {
                externalAccess: step.externalAccess,
                publicOrigin: step.publicOrigin,
              },
            },
          ],
        };
      case "office-update":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/office/update",
              body: { tag: step.tag },
            },
          ],
        };
      case "storage-prune":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/storage/prune",
              body: {
                target: step.target,
                olderThanDays: step.olderThanDays,
                ...(step.keepPerAgent === undefined
                  ? {}
                  : { keepPerAgent: step.keepPerAgent }),
                apply: true,
              },
            },
          ],
        };
      case "storage-compress":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/storage/compress",
              body: { olderThanDays: step.olderThanDays, apply: true },
            },
          ],
        };
      case "storage-retention":
        return {
          ok: true,
          routes: [
            { method: "PUT", path: "/api/storage/retention", body: step.set },
          ],
        };
      // The scope and the line the card showed (InstructionsLineStepRun): an
      // agent's edit since then refuses the Apply, so only the line the
      // member saw is written.
      case "instructions-line": {
        const run = (
          isObject(pick) ? pick : {}
        ) as Partial<InstructionsLineStepRun>;
        if (run.scope !== step.scope || run.line !== step.line)
          return {
            ok: false,
            status: 409,
            code: "step_changed",
            message: "The agent changed this rule. Read it again.",
          };
        return instructionsRoute(step);
      }
    }
  }

  // Why the member could not run an action step, or null (actionRefusal
  // in server/step-asks.ts).
  function actionRefusal(
    step: Extract<ActionStepRequest, S>,
    _askingAgentId: string | undefined,
    memberUserId: string,
    runs: StepRunDeps,
  ): StepFailure | null {
    switch (step.kind) {
      case "office-settings":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can change the office settings")
          : null;
      case "backup-settings": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed(
            "only an office owner can change the backup settings",
          );
        const dir = step.set.dir;
        return dir !== undefined &&
          dir !== runs.backupSettings().dir &&
          runs.backupDirFromEnv()
          ? {
              ok: false,
              status: 409,
              code: "backup_dir_from_env",
              message: "ISOMUX_BACKUP_DIR sets the backup folder",
            }
          : null;
      }
      // Hosted Isomux keeps the address, as the save does.
      case "office-access": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("only an office owner can change outside access");
        const rule = hostedAccessRule(
          runs.officeAccess(),
          step.externalAccess,
          step.publicOrigin || null,
        );
        return rule === "managed"
          ? {
              ok: false,
              status: 403,
              code: "hosted_access_managed",
              message:
                "Hosted Isomux manages this office's address; it cannot be changed.",
            }
          : null;
      }
      case "office-update":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can update the office")
          : null;
      case "storage-prune":
      case "storage-compress":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can clean up storage")
          : null;
      case "storage-retention":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              "only an office owner can change the automatic cleanup settings",
            )
          : null;
      case "instructions-line": {
        const route = instructionsRoute(step);
        if (!route.ok) return route;
        return runs.authorizeAs(memberUserId, route.routes[0])
          ? notAllowed("this member cannot change these instructions")
          : null;
      }
    }
  }

  // When each link, session or token a step's predicate reads by the
  // ask's age was made; none for the other kinds.
  function stateTimes(
    step: S,
    _memberUserId: string,
    runs: StepRunDeps,
  ): number[] {
    switch (step.kind) {
      // An apply from before the ask does not share its millisecond.
      case "storage-prune":
        return [runs.lastPrune(step.target)?.at ?? 0];
      case "storage-compress":
        return [runs.lastCompress()?.at ?? 0];
      default:
        return [];
    }
  }

  const runRoute = (
    step: Extract<ActionStepRequest, S>,
    memberUserId: string,
  ): StepRoute => firstRoute(routeOf, step, memberUserId);

  return { doneLine, isDone, complete, routeOf, actionRefusal, stateTimes };
}
