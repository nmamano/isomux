// Slide Mode sidecar store (design: internal-docs/slide-mode-design.md).
//
// One JSON file per conversation, keyed by the turn's user_message entry id:
//   ~/.isomux/state/slides/<agentId>/<rootSessionId>.json
//   { "slides": { "<entryId>": SlideRecord, ... } }
//
// Deliberately NOT log entries: on-demand backfill arrives out of order and the
// log files stay pure chat. Keying by rootSessionId means edit-forks of the same
// conversation share a deck (orphaned keys from abandoned branches are harmless
// and can be pruned against the live log). Reads never throw - a missing or
// corrupt file yields an empty deck.
//
// Writes are synchronous read-modify-write via atomicWriteFileSync. Because JS
// is single-threaded and there is no await between the read and the write, two
// concurrent generations for the same conversation can't interleave and clobber
// each other's keys.

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import type { SlideRecord } from "../shared/types.ts";

const SLIDES_DIR = join(STATE_ROOT, "state", "slides");

export type SlideDeck = Record<string, SlideRecord>;

function deckFilePath(agentId: string, rootSessionId: string): string {
  return join(SLIDES_DIR, agentId, `${rootSessionId}.json`);
}

// Read the whole slide map for a conversation. {} when absent or unreadable.
export function readDeck(agentId: string, rootSessionId: string): SlideDeck {
  const path = deckFilePath(agentId, rootSessionId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      slides?: SlideDeck;
    };
    return parsed.slides && typeof parsed.slides === "object"
      ? parsed.slides
      : {};
  } catch {
    return {};
  }
}

export function readSlide(
  agentId: string,
  rootSessionId: string,
  entryId: string,
): SlideRecord | null {
  return readDeck(agentId, rootSessionId)[entryId] ?? null;
}

// Insert / overwrite one slide (regeneration overwrites in place).
export function writeSlide(
  agentId: string,
  rootSessionId: string,
  entryId: string,
  record: SlideRecord,
): void {
  const deck = readDeck(agentId, rootSessionId);
  deck[entryId] = record;
  atomicWriteFileSync(
    deckFilePath(agentId, rootSessionId),
    JSON.stringify({ slides: deck }, null, 2),
  );
}

// NOTE: we deliberately do NOT prune the deck. A root deck is SHARED by every
// resumable fork branch under that root; keys the current leaf can't see may be
// live entries of a sibling/parent branch (reachable via /resume), not orphans.
// Pruning against one leaf's visible turns would erase another branch's slides,
// breaking "decks persist per conversation, forever". The design accepts the
// truly-abandoned keys as harmless; a correct sweep would need the union of all
// descendant leaves, which isn't worth the complexity (Reviewer1, 2026-07-24).
