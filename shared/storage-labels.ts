// Reading order and plain-language names for the storage categories, shared by
// the two surfaces that render the same measurement: the /isomux-storage chat
// report (server/storage-report.ts) and the owner-only storage panel in office
// settings (ui/components/StorageModal.tsx).
//
// Split out of storage-report.ts when the panel arrived. Duplicating the table
// would let chat and the UI drift into calling the same bytes two different
// things, which is the failure mode internal-docs/documentation.md is about.
//
// A LEAF: types only, no runtime imports.

import type { StorageCategoryId } from "./contract-shapes.ts";

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
// ~/.isomux".
export const CATEGORY_LABELS: Record<StorageCategoryId, string> = {
  transcripts: "Conversation transcripts",
  attachments: "Chat attachments",
  "session-metadata": "Session metadata",
  "codex-home": "Codex home",
  "provider-homes": "Personal provider homes",
  cronjobs: "Schedule history",
  memory: "Memory",
  "other-state": "Everything else",
  backups: "Backups",
  "update-snapshots": "Update snapshots",
};
