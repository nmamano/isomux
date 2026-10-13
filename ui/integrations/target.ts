// Whose items a card of the Integrations page shows: the office's, the
// viewer's own, or (for an owner) another member's. Every route path and every
// "whose" word on the page comes from here, so the three cannot disagree.

import { ApiError } from "../api.ts";
import type { MessageKey, Translator } from "../../shared/i18n/translate.ts";

export type Target =
  | { kind: "office" }
  | { kind: "self"; username: string }
  | { kind: "member"; username: string };

export type Role = "owner" | "member";

// The base of the item routes: /api/office or /api/users/<name>.
export function basePath(target: Target): string {
  return target.kind === "office"
    ? "/api/office"
    : `/api/users/${encodeURIComponent(target.username)}`;
}

export function targetKey(target: Target): string {
  return target.kind === "office" ? "office" : `user:${target.username}`;
}

// Office items are owner-managed; your own are yours; another member's reach
// an owner only (a member is never given that target).
export function canEdit(target: Target, role: Role): boolean {
  return target.kind === "self" || role === "owner";
}

// Show reveals a secret's value to its own member, and an office secret's to
// an owner. An owner never reads a member's personal value (Nil, 2026-10-13).
// Agent tokens never get the capability behind it; this page is for people.
export function canShowSecret(target: Target, role: Role): boolean {
  return (
    target.kind === "self" || (target.kind === "office" && role === "owner")
  );
}

// A member route answers 404 not_found for a username that is gone: the
// member left the office (or was renamed) while the card showed them.
export function isGone(caught: unknown, target: Target): boolean {
  return (
    target.kind === "member" &&
    caught instanceof ApiError &&
    caught.status === 404 &&
    caught.code === "not_found"
  );
}

// Members read the office's items as names, hosts and notes only.
export function summaryOnly(target: Target, role: Role): boolean {
  return target.kind === "office" && role !== "owner";
}

// A sentence that names whose item it is. Each base has three variants:
// ".self", ".office" and ".member" (which takes {member}), each a whole
// sentence, never a translated phrase inside another one (CJK spacing). The
// variants share their other placeholders, which `vars` fills.
type WhoseBase<K> = K extends `${infer B}.self` ? B : never;
export type WhoseKey = WhoseBase<MessageKey>;

export function whose(
  t: Translator["t"],
  base: WhoseKey,
  target: Target,
  vars: Record<string, string> = {},
): string {
  // The key is built at run time, so t() cannot check its placeholders here;
  // catalog.test.ts holds every variant to the English placeholder set.
  const lookup = t as unknown as (
    key: string,
    params: Record<string, string>,
  ) => string;
  return lookup(
    `${base}.${target.kind}`,
    target.kind === "member" ? { ...vars, member: target.username } : vars,
  );
}
