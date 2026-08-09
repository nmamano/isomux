// Deleting what this slice created, and NOTHING else.
//
// The test account is shared: it is the company's real Stripe account in test
// mode, and other work lives there. So ownership is decided POSITIVELY - an object
// is deleted only when it proves it is ours - and an object that cannot prove it is
// skipped. The earlier version of this deleted every test clock the account
// returned, which would have destroyed unrelated test-mode work.
//
// Two signals, and which one is available depends on the object:
//
//   - `metadata.isomux_test === "slice3"`, where Stripe exposes metadata. This is
//     the strong one: we set it, nobody else does.
//   - a name beginning with `cp3`, for objects that have no metadata field at all.
//     Test clocks are the case that matters: Stripe gives them a name and no
//     metadata, so the name is the only thing they can be identified by.
//
// A missing or non-string name, and absent metadata, mean UNKNOWN - which is
// skipped and counted, never deleted.

import type { StripeClient, FormValue } from "./client.ts";
import { OWNED_NAME_PREFIX, type TestClock } from "./test-clock.ts";

/** The tag this slice writes on everything that accepts metadata. */
export const OWNERSHIP_TAG = "slice3";

export interface Ownable {
  id?: unknown;
  name?: unknown;
  metadata?: unknown;
}

/** The strong signal: our own metadata tag, exactly. */
function taggedOurs(object: Ownable): boolean {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).isomux_test === OWNERSHIP_TAG;
}

/**
 * Ownership for an object type that EXPOSES METADATA: coupons, customers, prices,
 * products.
 *
 * The tag is the only proof, and a name is not a fallback here. There was a
 * fail-open path in the first version of this: one predicate accepted `tag OR
 * name` for every type, so a coupon carrying somebody else's tag would still be
 * deleted if its name happened to start with our prefix. A metadata-bearing object
 * that does not carry OUR tag belongs to someone else, whatever it is called.
 */
export function ownsTaggedObject(object: Ownable): boolean {
  return taggedOurs(object);
}

/**
 * Ownership for a TEST CLOCK, which Stripe gives no metadata field at all.
 *
 * The name is the only signal that exists, so it is the one used - and only here.
 * A missing or non-string name is unknown, which is kept.
 *
 * The match is on the EXACT namespace we mint into, `cp3-`, not on the bare prefix:
 * `cp3other` and `cp3rd-party` are names we never produce, so they belong to
 * somebody else.
 */
export function ownsClock(clock: Pick<TestClock, "name">): boolean {
  const name = clock.name;
  return typeof name === "string" && name.startsWith(OWNED_NAME_PREFIX);
}

export interface Selection<T> {
  owned: T[];
  /** Kept, with why - so an incomplete cleanup is visible rather than implied. */
  skipped: { id: string; why: string }[];
}

/**
 * Split a list into ours and not-ours.
 *
 * The predicate is REQUIRED. A default would be a guess about which ownership rule
 * applies to this object type, and guessing is what deleted other people's work.
 */
export function selectOwned<T extends Ownable>(
  objects: T[],
  owns: (object: T) => boolean,
): Selection<T> {
  const owned: T[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const object of objects) {
    const id = typeof object.id === "string" ? object.id : "(no id)";
    if (owns(object)) {
      owned.push(object);
      continue;
    }
    skipped.push({
      id,
      why: taggedOurs(object)
        ? "not ours"
        : object.metadata
          ? "carries someone else's ownership tag"
          : typeof object.name === "string"
            ? "not ours"
            : "no name and no metadata, so ownership cannot be established",
    });
  }
  return { owned, skipped };
}

/**
 * Every page of a Stripe list, not the first hundred.
 *
 * Treating one page as the whole account is how a cleanup silently leaves objects
 * behind and then reports success. If the walk cannot be completed, the caller is
 * told rather than left to assume.
 */
export async function listAll(
  client: StripeClient,
  path: string,
  query: Record<string, FormValue> = {},
  maxPages = 20,
): Promise<{
  objects: Record<string, unknown>[];
  complete: boolean;
  reason?: string;
}> {
  const objects: Record<string, unknown>[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.get(path, {
      ...query,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (res.kind !== "ok") {
      return { objects, complete: false, reason: res.reason };
    }
    const data = res.body.data;
    if (!Array.isArray(data)) {
      return { objects, complete: false, reason: `${path} returned no list` };
    }
    for (const item of data) {
      if (item && typeof item === "object") {
        objects.push(item as Record<string, unknown>);
      }
    }
    if (res.body.has_more !== true || data.length === 0) {
      return { objects, complete: true };
    }
    const last = data[data.length - 1] as { id?: unknown };
    if (typeof last.id !== "string") {
      return { objects, complete: false, reason: `${path} page had no cursor` };
    }
    startingAfter = last.id;
  }
  return {
    objects,
    complete: false,
    reason: `stopped after ${maxPages} pages`,
  };
}

/**
 * Delete one object and say what actually happened.
 *
 * A loop that counted deletions without looking at the result would report objects
 * as gone while they sat there - and an `ambiguous` result is the case that matters:
 * the request may or may not have been applied, and claiming either is a lie.
 *
 * A 404 is success on purpose: a customer removed along with its test clock is
 * already gone, which is the outcome we wanted.
 */
export async function deleteOwned(
  client: StripeClient,
  path: string,
): Promise<{ deleted: boolean; reason?: string }> {
  const res = await client.del(path);
  if (res.kind === "ok") return { deleted: true };
  if (res.kind === "rejected" && res.status === 404) return { deleted: true };
  return { deleted: false, reason: res.reason };
}
