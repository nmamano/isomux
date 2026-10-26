// Office-settings resource handlers. The office-wide
// settings and instructions on the unified REST surface (opIds
// office.{getSettings,setSettings,getMemberUsageStatus,readInstructions,
// setInstructions}). The route table gates all of them with
// office:settings + officeSettingsOwner: an owner, or a privileged agent whose
// manager is an office owner.
//
// Strangler: office.setSettings (REST) delegates to the shared core
// (applyOfficeSettings in the index seam); the legacy update_office_settings WS
// arm that once shared it is retired (the office-prompt UI now PUTs here). The
// core validates COMPLETELY before it mutates/emits, so an over-long name never
// produces a double-signal (no partial write, no
// office_settings_updated). setSettings emits office_settings_updated via the
// existing AgentManager event sink - the handler never emits.
//
// office.{read,set}Instructions read and write the prompt alone, with a
// version over the text only. The settings routes do not carry it.
//
// office.getSettings returns the display name, the member usage cap switch
// and the member share. office.getMemberUsageStatus returns the cap's status
// lines, which read the providers.
// The legacy envFile field remains persistence-only until
// the boot migration clears it.
//
// name omitted-vs-null is preserved end to end: an absent `name` (an agent
// that changes one field, or a stale client tab from before the name existed)
// PRESERVES the stored value; an explicit null CLEARS it (Lead, 2026-10-14).
// The handler passes undefined for absent so the core can tell the two apart.
//
// LEAF over the executor + shared types. Only the injected OfficeSettingsDeps.

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type RouteHandlerContext,
  type HandlerErrorStatus,
} from "../executor.ts";
import type {
  OfficeSettingsRes,
  OfficeUsageStatusRes,
} from "../../../shared/contract-shapes.ts";
import type { ProviderAccountProvider } from "../../../shared/types.ts";
import { validMemberShare } from "../../../shared/member-usage-share.ts";
import {
  instructionsConflict,
  instructionsRes,
  parseInstructionsWrite,
  refuseOldFields,
} from "./instructions.ts";

// setSettings outcome the seam shapes: ok, a status-mapped validation failure
// (400 over-long name), or a version conflict carrying the
// CURRENT version (409 - the settings changed since the caller's read). The
// handler maps them 1:1.
export type ApplyOfficeSettingsResult =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; error: string }
  | { ok: false; conflict: true; version: string };

export interface OfficeSettingsDeps {
  getSettings(): OfficeSettingsRes;
  // The cap's status lines: every provider, or only `provider`. Empty while
  // the cap is off.
  getMemberUsageStatus(
    provider?: ProviderAccountProvider,
  ): Promise<OfficeUsageStatusRes>;
  // Validate-then-apply, guarded by the version from a preceding getSettings.
  // `name === undefined` preserves the current name; null or empty clears it.
  // `memberUsageCap === undefined` preserves the switch, and
  // `memberUsageShare === undefined` the share, and `recordTerminals ===
  // undefined` the "Record terminals" switch.
  // Throws nothing - invalid input returns { ok: false }. `ctx` names the
  // writer for the switch's own audit row.
  applySettings(
    input: {
      name?: string | null;
      memberUsageCap?: boolean;
      memberUsageShare?: number;
      recordTerminals?: boolean;
      expectedVersion: string;
    },
    ctx: RouteHandlerContext,
  ): ApplyOfficeSettingsResult;
  // The office instructions. Their version covers the text only, so a name
  // change does not touch it.
  readInstructions(): string | null;
  // Writes the text alone, guarded by the version of the text.
  applyInstructions(
    instructions: string | null,
    expectedVersion: string,
  ): { ok: true; instructions: string | null } | { ok: false; version: string };
}

export function officeSettingsHandlers(
  deps: OfficeSettingsDeps,
): Record<string, RouteHandler> {
  return {
    "office.getSettings": () => ok(deps.getSettings()),

    // `provider` names one provider; absent, both. The reads can take
    // seconds, so the settings read does not carry them.
    "office.getMemberUsageStatus": async (ctx) => {
      const named = ctx.query.getAll("provider");
      if (named.length === 0) return ok(await deps.getMemberUsageStatus());
      const provider = named[0];
      if (named.length > 1 || (provider !== "claude" && provider !== "codex"))
        return fail(400, "invalid_request", "provider must be claude or codex");
      return ok(await deps.getMemberUsageStatus(provider));
    },

    "office.readInstructions": () =>
      ok(instructionsRes(deps.readInstructions())),

    "office.setInstructions": (ctx) => {
      const input = parseInstructionsWrite(ctx.body);
      if (!input.ok) return input.result;
      const r = deps.applyInstructions(input.instructions, input.version);
      return r.ok
        ? ok(instructionsRes(r.instructions))
        : instructionsConflict(r.version);
    },

    "office.setSettings": (ctx) => {
      const old = refuseOldFields(ctx.body, {
        prompt: "instructions to PUT /api/office/instructions",
      });
      if (old) return old;
      const b = (ctx.body ?? {}) as {
        name?: unknown;
        version?: unknown;
        memberUsageCap?: unknown;
        memberUsageShare?: unknown;
        recordTerminals?: unknown;
      };
      // Distinguish "omitted" (undefined → preserve) from "set to null" (→
      // clear) for the name. JSON access yields undefined for an absent key and
      // null for an explicit null, so a direct read carries the distinction.
      const name =
        b.name === undefined
          ? undefined
          : typeof b.name === "string"
            ? b.name
            : null;
      // The PUT replaces the whole settings blob, so it must carry the version
      // from a preceding GET - same rail as memory.replace.
      if (typeof b.version !== "string" || b.version.length === 0) {
        return fail(
          400,
          "invalid_version",
          "version is required (from a preceding GET of the settings)",
        );
      }
      if (
        b.memberUsageCap !== undefined &&
        typeof b.memberUsageCap !== "boolean"
      ) {
        return fail(400, "invalid_request", "memberUsageCap must be a boolean");
      }
      if (
        b.recordTerminals !== undefined &&
        typeof b.recordTerminals !== "boolean"
      ) {
        return fail(
          400,
          "invalid_request",
          "recordTerminals must be a boolean",
        );
      }
      if (
        b.memberUsageShare !== undefined &&
        !validMemberShare(b.memberUsageShare)
      ) {
        return fail(
          400,
          "invalid_request",
          "memberUsageShare must be a multiple of 10 from 10 to 100",
        );
      }
      const r = deps.applySettings(
        {
          name,
          memberUsageCap: b.memberUsageCap,
          memberUsageShare: b.memberUsageShare,
          recordTerminals: b.recordTerminals,
          expectedVersion: b.version,
        },
        ctx,
      );
      if (!r.ok) {
        if ("conflict" in r) {
          return fail(
            409,
            "version_conflict",
            "the office settings changed since your read; re-read and retry",
            { version: r.version },
          );
        }
        return fail(r.status, "set_settings_failed", r.error);
      }
      return noContent();
    },
  };
}
