// Reading order and the catalog key for each storage category, shared by the
// two surfaces that render the same measurement: the /isomux-storage chat
// report (server/storage-report.ts) and the owner-only storage panel in office
// settings (ui/components/StoragePane.tsx).
//
// Split out of storage-report.ts when the panel arrived. Duplicating the table
// would let chat and the UI drift into calling the same bytes two different
// things, which is the failure mode internal-docs/documentation.md is about.
// That is also why the KEYS live here rather than in either surface: since S7
// both read the same words in the reader's language.
//
// A LEAF: types only, no runtime imports.

import type { StorageCategoryId } from "./contract-shapes.ts";
import type { MessageKey } from "./i18n/en.ts";

// Reading order, not the contract's order: the biggest, most-explicable things
// first, "everything else" last, and the two out-of-root locations after the
// office-state subtotal.
export const IN_ROOT_ORDER: readonly StorageCategoryId[] = [
  "transcripts",
  "attachments",
  "session-metadata",
  "codex-home",
  "provider-homes",
  "cronjobs",
  "memory",
  "other-state",
];

// Backups and update snapshots live OUTSIDE the state root, so they are listed
// after its subtotal and are never folded into it.
export const OUT_OF_ROOT_ORDER: readonly StorageCategoryId[] = [
  "backups",
  "update-snapshots",
];

// The wire ids are kebab-case keys for an API; nobody reading a report or a
// settings panel should have to know that "other-state" means "the rest of
// ~/.isomux". Memory borrows common.memory rather than minting a second key
// for the same word (ruling 15).
export type StorageCategoryKey =
  | Extract<MessageKey, `settings.storage.category.${string}`>
  | "common.memory";

export const CATEGORY_KEYS: Record<StorageCategoryId, StorageCategoryKey> = {
  transcripts: "settings.storage.category.transcripts",
  attachments: "settings.storage.category.attachments",
  "session-metadata": "settings.storage.category.sessionMetadata",
  "codex-home": "settings.storage.category.codexHome",
  "provider-homes": "settings.storage.category.providerHomes",
  cronjobs: "settings.storage.category.cronjobs",
  memory: "common.memory",
  "other-state": "settings.storage.category.otherState",
  backups: "settings.storage.category.backups",
  "update-snapshots": "settings.storage.category.updateSnapshots",
};
