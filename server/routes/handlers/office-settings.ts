// Office-settings resource handlers — Phase 3a slice 3a.5. The office-wide
// prompt / envFile / display-name surface on the unified REST surface (opIds
// office.{getSettings,setSettings}). Owner-only — the route table gates both with
// office:admin + officeOwner.
//
// Strangler: office.setSettings (REST) delegates to the shared core
// (applyOfficeSettings in the index seam); the legacy update_office_settings WS
// arm that once shared it is retired (the office-prompt UI now PUTs here). The
// core validates COMPLETELY before it mutates/emits, so an invalid env path or
// over-long name never produces a double-signal (no partial write, no
// office_settings_updated). setSettings emits office_settings_updated via the
// existing AgentManager event sink — the handler never emits.
//
// office.getSettings returns the FULL OfficeSettings (incl envFile); envFile is
// owner-only by the route guard and, by design, never rides the office-wide
// office_settings_updated event (see internal-docs/generic-runtime-refactor.md →
// Event registry; the all-event drop is a deferred UI-coordinated Follow-up, so
// the legacy broadcast bridge stays byte-identical for now).
//
// name omitted-vs-null is preserved end to end: an absent `name` (a stale client
// tab from before the field existed) PRESERVES the current name; an explicit
// null/empty CLEARS it. The handler passes undefined for absent so the core can
// tell the two apart.
//
// LEAF over the executor + shared types. Only the injected OfficeSettingsDeps.

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { OfficeSettings } from "../../../shared/types.ts";

// setSettings outcome the seam shapes: ok, or a status-mapped validation failure
// (400 invalid env path / over-long name). The handler maps it 1:1.
export type ApplyOfficeSettingsResult =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; error: string };

export interface OfficeSettingsDeps {
  getSettings(): OfficeSettings;
  // Validate-then-apply. `name === undefined` preserves the current name; null or
  // empty clears it. Throws nothing — invalid input returns { ok: false }.
  applySettings(input: {
    prompt: string | null;
    envFile: string | null;
    name?: string | null;
  }): ApplyOfficeSettingsResult;
}

export function officeSettingsHandlers(
  deps: OfficeSettingsDeps,
): Record<string, RouteHandler> {
  return {
    "office.getSettings": () => ok(deps.getSettings()),

    "office.setSettings": (ctx) => {
      const b = (ctx.body ?? {}) as {
        prompt?: unknown;
        envFile?: unknown;
        name?: unknown;
      };
      const prompt = typeof b.prompt === "string" ? b.prompt : null;
      const envFile = typeof b.envFile === "string" ? b.envFile : null;
      // Distinguish "name omitted" (undefined → preserve) from "name set to
      // null/empty" (→ clear). JSON access yields undefined for an absent key and
      // null for an explicit null, so a direct read carries the distinction.
      const name =
        b.name === undefined
          ? undefined
          : typeof b.name === "string"
            ? b.name
            : null;
      const r = deps.applySettings({ prompt, envFile, name });
      if (!r.ok) return fail(r.status, "set_settings_failed", r.error);
      return noContent();
    },
  };
}
