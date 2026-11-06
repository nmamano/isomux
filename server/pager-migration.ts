// The pager migration (task 74e8fc07): at each boot, every page of the old
// pager store becomes a paged ask or a closed ask in the history, with its
// page id. pager.json and pager-resolved.jsonl are only read, never written,
// so a rollback finds them as they were. pager-migration.json records the
// archive's size at the last complete run, so a boot reads the archive again
// only when it grew. A page whose id is in the history's
// page index (open or closed) is skipped, so a second run changes nothing.
//
// An open or acked page becomes a paged ask for its target member, P1, with
// the page's id, times, raise count, key, send record and ack. A page whose
// agent, app or target member is gone, and every resolved page, becomes a
// history record instead: a resolved page at its resolve time, in resolve
// order, the others at the migration. A "resolved" message still owed is
// dropped.

import { existsSync, readFileSync, statSync } from "fs";
import { atomicWriteFileSync } from "./persistence.ts";
import type { AskHistory } from "./ask-history.ts";
import type { AskStore } from "./asks.ts";
import { errMessage } from "../shared/errors.ts";
import {
  comparePagerResolve,
  generatePagerId,
  type AskClosure,
  type AskEntry,
  type AskPage,
  type PagerEntry,
} from "../shared/types.ts";
import { pagePrompt } from "./pager-compat.ts";
import { isPagerEntry } from "./pager-store.ts";

export interface PagerMigrationDeps {
  asks: Pick<AskStore, "create">;
  history: Pick<AskHistory, "pageAskId" | "record" | "recordPage">;
  now(): number;
  // The agent is live.
  agentLive(agentId: string): boolean;
  // The user is a member now.
  isMember(userId: string): boolean;
  // The member with this display name now, or null.
  memberIdByName(name: string): string | null;
  // The app with this name and registration generation as it is now: its
  // createdAt and its message target when that is a live agent. Null when
  // the app is gone or was registered again.
  app(
    name: string,
    registrationGen: number,
  ): { createdAt: number; targetAgentId: string | null } | null;
  // Runs the whole migration in one history transaction, so a large archive
  // writes in one commit. Absent: each record commits on its own.
  transaction?<T>(fn: () => T): T;
}

export interface PagerMigrationResult {
  // Open or acked pages that became paged asks.
  opened: number;
  // Pages written to the history: resolved ones, and open ones whose agent,
  // app or member is gone.
  closed: number;
  // Pages already migrated.
  skipped: number;
}

// The ask fields a page's source gives: its agent (or "" for none), and the
// app or the office feature. `live` is false when the agent or app is gone.
function sourceFields(
  page: PagerEntry,
  deps: PagerMigrationDeps,
): {
  live: boolean;
  agentId: string;
  app?: { name: string; createdAt: number };
  office?: { feature: string; name: string };
} {
  const source = page.source;
  switch (source.kind) {
    case "agent":
      return { live: deps.agentLive(source.agentId), agentId: source.agentId };
    case "app": {
      const app = deps.app(source.appName, source.registrationGen);
      return {
        live: app !== null,
        agentId: app?.targetAgentId ?? "",
        // createdAt 0: no app of today is that registration.
        app: { name: source.appName, createdAt: app?.createdAt ?? 0 },
      };
    }
    case "office":
      return {
        live: true,
        agentId: "",
        office: { feature: source.feature, name: source.name },
      };
  }
}

// Migrates `pages`: the pages of pager.json and of the archive, in any order.
// The first page with an id wins (pager.json's, when a crashed move left a
// page in both). A throw from the history stops the run; what it wrote
// stands, and the next run does the rest. A page whose ask cannot be made is
// logged and left for the next run; the other pages go on.
export function migratePages(
  pages: readonly PagerEntry[],
  deps: PagerMigrationDeps,
): PagerMigrationResult {
  return migrateCounting(pages, deps).result;
}

// The run, with the pages left for the next run (`failed`).
function migrateCounting(
  pages: readonly PagerEntry[],
  deps: PagerMigrationDeps,
): { result: PagerMigrationResult; failed: number } {
  return deps.transaction
    ? deps.transaction(() => migrateEach(pages, deps))
    : migrateEach(pages, deps);
}

function migrateEach(
  pages: readonly PagerEntry[],
  deps: PagerMigrationDeps,
): { result: PagerMigrationResult; failed: number } {
  const result: PagerMigrationResult = { opened: 0, closed: 0, skipped: 0 };
  let failed = 0;
  const seen = new Set<string>();
  const todo: PagerEntry[] = [];
  for (const page of pages) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    if (deps.history.pageAskId(page.id) !== null) result.skipped++;
    else todo.push(page);
  }
  const ackOf = (page: PagerEntry) =>
    page.acked
      ? {
          byUserId: deps.memberIdByName(page.acked.by) ?? "",
          at: page.acked.at,
        }
      : undefined;

  // A page as a closed ask in the history, with its page index row.
  const close = (page: PagerEntry, closure: AskClosure) => {
    const fields = sourceFields(page, deps);
    const acked = ackOf(page);
    const { resolvedNotice: _owed, ...delivery } = page.delivery;
    const pageRecord: AskPage = {
      ...(acked
        ? { state: "acked", ackedByUserId: acked.byUserId, ackedAt: acked.at }
        : { state: "ringing" }),
      pageId: page.id,
      ...(page.key !== undefined ? { key: page.key } : {}),
      raiseCount: page.raiseCount,
      lastRaisedAt: page.lastRaisedAt,
      delivery: { [page.targetUserId]: delivery },
    };
    const entry: AskEntry = {
      // 16 hex: no ask id of 8 can be the same.
      id: generatePagerId(),
      agentId: fields.agentId,
      memberUserId: page.targetUserId,
      prompt: pagePrompt(page.title, page.body),
      priority: "P1",
      createdAt: page.createdAt,
      updatedAt: page.lastRaisedAt,
      ...(fields.app ? { app: fields.app } : {}),
      ...(fields.office ? { office: fields.office } : {}),
      page: pageRecord,
    };
    deps.history.record(entry, closure, [page.targetUserId]);
    result.closed++;
  };

  // Resolved pages first, in resolve order, so the history's close order is
  // the order the pager listed them in.
  const resolved = todo
    .filter((p) => p.state === "resolved")
    .sort(comparePagerResolve);
  for (const page of resolved) {
    const by = page.resolved?.by ?? "";
    const at = page.resolved?.at ?? page.lastRaisedAt;
    const byUserId = deps.memberIdByName(by);
    close(
      page,
      by === page.source.name
        ? {
            outcome: "withdrawn",
            ...(page.source.kind === "app" ? { app: page.source.appName } : {}),
            at,
          }
        : {
            outcome: "dismissed",
            ...(byUserId !== null ? { byUserId } : {}),
            at,
          },
    );
  }

  for (const page of todo.filter((p) => p.state !== "resolved")) {
    const fields = sourceFields(page, deps);
    if (!fields.live) {
      close(
        page,
        page.source.kind === "app"
          ? { outcome: "withdrawn", app: page.source.appName, at: deps.now() }
          : { outcome: "agent_removed", at: deps.now() },
      );
      continue;
    }
    if (!deps.isMember(page.targetUserId)) {
      close(page, { outcome: "dismissed", at: deps.now() });
      continue;
    }
    const acked = ackOf(page);
    let made: ReturnType<PagerMigrationDeps["asks"]["create"]>;
    try {
      made = deps.asks.create({
        agentId: fields.agentId,
        memberUserId: page.targetUserId,
        prompt: pagePrompt(page.title, page.body),
        priority: "P1",
        ...(fields.app ? { app: fields.app } : {}),
        ...(fields.office ? { office: fields.office } : {}),
        page: {
          recipients: [page.targetUserId],
          ...(page.key !== undefined ? { key: page.key } : {}),
        },
        migrated: {
          pageId: page.id,
          createdAt: page.createdAt,
          raiseCount: page.raiseCount,
          lastRaisedAt: page.lastRaisedAt,
          delivery: page.delivery,
          ...(acked ? { acked } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[pager] page ${page.id} could not become an ask: ${errMessage(err)}`,
      );
      failed++;
      continue;
    }
    if (!made.ok) {
      console.error(
        `[pager] page ${page.id} could not become an ask: ${made.code}`,
      );
      failed++;
      continue;
    }
    result.opened++;
  }
  return { result, failed };
}

// The old files, and the record of the last complete run: the archive's
// size then. The archive only grows (an older release appends to it after a
// rollback), so the same size means nothing new to read in it.
export interface PagerMigrationFiles {
  pager: string;
  archive: string;
  done: string;
}

const fileSize = (path: string): number | null =>
  existsSync(path) ? statSync(path).size : null;

function doneArchiveSize(path: string): number | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const size = (value as { archiveSize?: unknown } | null)?.archiveSize;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}

// The pages of pager.json and of pager-resolved.jsonl, pager.json's first.
// Read only. A file that is not there has no pages; a pager.json that cannot
// be read or parsed throws, and a line of the archive that is not a page is
// skipped. `readArchive` false skips the archive.
export function readOldPages(
  pagerPath: string,
  archivePath: string,
  readArchive = true,
): PagerEntry[] {
  const pages: PagerEntry[] = [];
  if (existsSync(pagerPath)) {
    const value: unknown = JSON.parse(readFileSync(pagerPath, "utf-8"));
    if (!Array.isArray(value)) throw new Error("pager.json is not a list");
    pages.push(...value.filter(isPagerEntry));
  }
  if (readArchive && existsSync(archivePath)) {
    for (const line of readFileSync(archivePath, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isPagerEntry(value)) pages.push(value);
      } catch {
        // A cut line from a crashed append.
      }
    }
  }
  return pages;
}

// The boot run: read the old files and migrate them. Returns the pages it
// read. Any failure is logged and the boot goes on; the next boot tries
// again.
export function migratePagerAtBoot(
  files: PagerMigrationFiles,
  deps: PagerMigrationDeps,
): PagerEntry[] {
  try {
    const archiveSize = fileSize(files.archive);
    const pages = readOldPages(
      files.pager,
      files.archive,
      archiveSize !== null && archiveSize !== doneArchiveSize(files.done),
    );
    if (pages.length === 0) return [];
    const { result, failed } = migrateCounting(pages, deps);
    if (result.opened + result.closed > 0)
      console.log(
        `[pager] migrated ${result.opened} open and ${result.closed} closed pages into asks`,
      );
    // A run that left pages for the next one is not complete: the next boot
    // reads the archive again.
    if (archiveSize !== null && failed === 0)
      atomicWriteFileSync(files.done, JSON.stringify({ archiveSize }));
    return pages;
  } catch (err) {
    console.error(`[pager] the page migration stopped: ${errMessage(err)}`);
    return [];
  }
}
