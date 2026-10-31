// The systemd user units the office owns: its own unit and its app units.
// A leaf module, so the safety policy (and the Codex hook bundle built from
// it) can name them without importing the app supervisor.

import { createHash } from "crypto";

// The unit-name prefix for an office on `stateRoot`.
//
// The production office (default state root) gets the bare `isomux-app-`
// namespace, which is the locked production naming. Every other state root gets
// a namespace of its own, derived from the root's path, for the reason in the
// app supervisor's header: two offices on one box must not be able to name
// each other's units. The digest is what makes it derived rather than
// configured - there is no knob to set wrong, and an isolated instance cannot
// opt back into production.
//
// THE DOT IS THE WHOLE ISOLATION ARGUMENT. An app name cannot contain `.` (the
// grammar is `[a-z0-9-]`, because the name has to survive as a DNS label), so
// no production app - however it is named, and whoever names it - can render to
// a unit name in this namespace. Without it the separation would rest on a
// digest being hard to guess, which is not a property anyone should have to
// rely on: the state root is not a secret, so a name that collides is something
// an app author could construct on purpose. A forbidden character makes the two
// namespaces disjoint by construction instead. systemd accepts a `.` inside a
// unit name (verified with systemd-analyze; it splits the type suffix off the
// LAST dot), and the result still matches the `isomux-app-test-*` glob the
// standing rail asks test units to be findable under.
//
// The full digest, not a prefix of it, for the same reason: truncating to eight
// hex characters would squeeze every state root on the box into a 32-bit space
// for no saving that matters.
export function unitPrefixFor(stateRoot: string, isDefault: boolean): string {
  if (isDefault) return "isomux-app-";
  const digest = createHash("sha256").update(stateRoot).digest("hex");
  return `isomux-app-test-.${digest}-`;
}

export const unitNameFor = (prefix: string, appName: string): string =>
  `${prefix}${appName}.service`;

// The office's own user unit, from the text of /proc/self/cgroup: the
// `*.service` leaf when it runs under the user manager (`user@<uid>.service/`).
// Null for a session scope or a system unit: the user unit paths do not apply
// to a system unit, which is root-owned.
export function officeUnitFromCgroup(text: string): string | null {
  // The unified (v2) line; on a hybrid hierarchy it comes after the v1 lines.
  const line = text.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return null;
  const parts = line.slice("0::".length).split("/");
  const leaf = parts[parts.length - 1];
  const underUserManager = parts.some((p) => /^user@\d+\.service$/.test(p));
  if (!underUserManager || !leaf.endsWith(".service")) return null;
  // The user manager itself is not the office.
  if (/^user@\d+\.service$/.test(leaf)) return null;
  return leaf;
}

// True when `name`, one entry of a systemd user unit directory, is a unit
// file or a drop-in directory that can apply to a unit the office owns: the
// office unit or `<officeUnit>.d`, an app unit or its `.d`, the top-level
// `service.d`, or a dash-prefix drop-in (`<prefix>-.service.d`) of either.
export function isProtectedUnitEntry(
  name: string,
  ctx: { appPrefix: string; officeUnit: string | null },
): boolean {
  if (name === "service.d") return true;
  const dropIn = name.endsWith(".d");
  const unit = dropIn ? name.slice(0, -".d".length) : name;
  if (!unit.endsWith(".service")) return false;
  if (unit === ctx.officeUnit || unit.startsWith(ctx.appPrefix)) return true;
  // systemd also reads <prefix>-.service.d/ for a unit whose name starts with
  // <prefix>-, at each dash of the name.
  const stem = unit.slice(0, -".service".length);
  if (!dropIn || !stem.endsWith("-")) return false;
  const officeStem = ctx.officeUnit?.slice(0, -".service".length);
  return (
    (officeStem !== undefined && officeStem.startsWith(stem)) ||
    ctx.appPrefix.startsWith(stem) ||
    stem.startsWith(ctx.appPrefix)
  );
}
