// T0 - the /isomux-storage markdown report (task 1387a9c7).
//
// The renderer is pure: it takes an already-measured StorageUsage, so these
// build the measurement by hand and never touch a disk. What matters here is
// the OWNER/non-owner split (the report must not leak paths or per-agent detail
// into the aggregate projection) and the arithmetic a reader will trust: the
// headline total counts the out-of-root locations on top of the state root.

import { describe, it, expect } from "bun:test";
import { renderStorageReport } from "./storage-report.ts";
import { english, translatorForLanguage } from "./i18n.ts";
import { aggregateOnly, type StorageUsage } from "./storage-usage.ts";
import type { StorageCategoryId } from "../shared/contract-shapes.ts";

const MB = 1024 * 1024;

// bytes per category; anything omitted renders as an available, empty location.
function usageFixture(
  overrides: Partial<Record<StorageCategoryId, number>> = {},
  opts: { snapshotsAvailable?: boolean } = {},
): StorageUsage {
  const ids: StorageCategoryId[] = [
    "transcripts",
    "token-logs",
    "attachments",
    "session-metadata",
    "codex-home",
    "provider-homes",
    "cronjobs",
    "memory",
    "webhooks",
    "other-state",
    "backups",
    "update-snapshots",
  ];
  const pathFor = (id: StorageCategoryId): string =>
    id === "backups"
      ? "/srv/isomux-backups"
      : id === "update-snapshots"
        ? "/srv/isomux-snapshots"
        : "/srv/state";
  const inRoot = ids.filter(
    (id) => id !== "backups" && id !== "update-snapshots",
  );
  return {
    stateRoot: "/srv/state",
    measuredAt: Date.now(),
    stateRootBytes: inRoot.reduce((sum, id) => sum + (overrides[id] ?? 0), 0),
    categories: ids.map((id) => ({
      id,
      path:
        id === "update-snapshots" && opts.snapshotsAvailable === false
          ? null
          : pathFor(id),
      available:
        id === "update-snapshots" ? opts.snapshotsAvailable !== false : true,
      bytes: overrides[id] ?? 0,
      files: overrides[id] ? 3 : 0,
    })),
    agents: [
      {
        agentId: "agent-live",
        transcriptBytes: 5 * MB,
        attachmentBytes: 1 * MB,
        sessions: 12,
        lastActivityAt: Date.now(),
      },
      {
        agentId: "agent-gone",
        transcriptBytes: 40 * MB,
        attachmentBytes: 0,
        sessions: 3,
        lastActivityAt: null,
      },
    ],
  };
}

const labels = { agentLabel: (id: string) => ({ name: `name:${id}` }) };

// Every assertion below up to the language block is about the arithmetic and
// the owner/non-owner split, on the English translator. Sizes and counts are
// Intl output, so they stay literal; the prose around them is read from the
// catalog (internal-docs/testing-guide.md, principle 15). The language
// assertions live in their own block at the bottom (internal-docs/i18n-loop.md,
// S7).
const { t } = english;
const BACKUPS = t("settings.storage.category.backups");
const SNAPSHOTS = t("settings.storage.category.updateSnapshots");
const KILLED = t("storageReport.killed");

// The totals sentence sits under the heading and one blank line.
function headline(out: string): string {
  const lines = out.split("\n");
  expect(lines[0]).toBe(`## ${t("storageReport.heading")}`);
  expect(lines[1]).toBe("");
  return lines[2];
}

// A bold summary row of the category table, found by its bold size.
function boldRowIndex(out: string, size: string): number {
  return out
    .split("\n")
    .findIndex((l) =>
      new RegExp(
        `^\\| \\*\\*[^*|]+\\*\\* \\| \\*\\*${size}\\*\\* \\| \\|$`,
      ).test(l),
    );
}

describe("renderStorageReport", () => {
  it("totals the state root plus the locations outside it", () => {
    const out = renderStorageReport(
      english,
      usageFixture({ transcripts: 100 * MB, backups: 400 * MB }),
      labels,
    );
    // 100 MB in-root + 400 MB of backups; the headline is the sum, and the
    // state-root subtotal stays separate from it.
    expect(headline(out)).toBe(
      t("storageReport.totalWithOutside", {
        total: "500.0 MB",
        stateRoot: "100.0 MB",
        outside: "400.0 MB",
        locations: BACKUPS.toLowerCase(),
      }),
    );
    const subtotal = boldRowIndex(out, "100.0 MB");
    expect(subtotal).toBeGreaterThan(-1);
    expect(boldRowIndex(out, "500.0 MB")).toBeGreaterThan(subtotal);
  });

  it("says everything is office state when nothing lives outside it", () => {
    const out = renderStorageReport(
      english,
      usageFixture({ transcripts: 2 * MB }),
      {
        agentLabel: () => ({ name: "x" }),
      },
    );
    // No phantom credit to locations with nothing in them.
    expect(headline(out)).toBe(
      t("storageReport.totalOnly", { total: "2.0 MB" }),
    );
  });

  it("names only the out-of-root locations that hold bytes", () => {
    const both = renderStorageReport(
      english,
      usageFixture({ backups: 1 * MB, "update-snapshots": 1 * MB }),
      labels,
    );
    expect(headline(both)).toContain(
      `${BACKUPS.toLowerCase()}${t("storageReport.locationsJoin")}${SNAPSHOTS.toLowerCase()}`,
    );
    const snapshotsOnly = headline(
      renderStorageReport(
        english,
        usageFixture({ "update-snapshots": 1 * MB }),
        labels,
      ),
    );
    expect(snapshotsOnly).toContain(SNAPSHOTS.toLowerCase());
    expect(snapshotsOnly).not.toContain(BACKUPS.toLowerCase());
  });

  it("marks an unconfigured location as none rather than zero", () => {
    const out = renderStorageReport(
      english,
      usageFixture({ transcripts: 1 * MB }, { snapshotsAvailable: false }),
      labels,
    );
    expect(out).toContain(`| ${SNAPSHOTS} | ${t("storageReport.none")} | - |`);
    expect(out).toContain(
      t("storageReport.locationNotSetUp", { label: SNAPSHOTS.toLowerCase() }),
    );
  });

  it("gives the owner paths and the per-agent breakdown", () => {
    const out = renderStorageReport(
      english,
      usageFixture({ transcripts: 1 * MB }),
      {
        agentLabel: (id: string) =>
          id === "agent-gone"
            ? { name: "Ghost", killed: true }
            : { name: "Live" },
      },
    );
    expect(out).toContain("`/srv/state`");
    expect(out).toContain(`### ${t("storageReport.biggestAgents")}`);
    expect(out).not.toContain(t("storageReport.ownerOnly"));
    // Sorted by transcripts + attachments, so the killed 40 MB agent leads.
    const ghostRow = out.indexOf(`| Ghost ${KILLED} |`);
    const liveRow = out.indexOf("| Live |");
    expect(ghostRow).toBeGreaterThan(-1);
    expect(ghostRow).toBeLessThan(liveRow);
    // No transcript mtime at all reads as a dash, not "just now".
    expect(out).toContain("| 3 | - |");
  });

  it("withholds paths and per-agent detail from the aggregate projection", () => {
    const full = usageFixture({ transcripts: 1 * MB, backups: 2 * MB });
    const out = renderStorageReport(english, aggregateOnly(full), labels);
    expect(out).not.toContain("/srv/state");
    expect(out).not.toContain("/srv/isomux-backups");
    expect(out).not.toContain(t("storageReport.biggestAgents"));
    expect(out).not.toContain("name:agent-live");
    expect(out).toContain(t("storageReport.ownerOnly"));
    // The sizes themselves still come through - that is the whole point of the
    // projection.
    expect(headline(out)).toContain("3.0 MB");
  });

  // One-agent report whose single row carries whatever name the case supplies.
  function rowFor(name: string, killed?: boolean): string {
    const usage = usageFixture({ transcripts: 1 * MB });
    usage.agents = [
      {
        agentId: "hostile",
        // 7 MB: distinct from every category size in the fixture, so the row
        // finder below cannot latch onto the category table by accident.
        transcriptBytes: 7 * MB,
        attachmentBytes: 0,
        sessions: 1,
        lastActivityAt: null,
      },
    ];
    const out = renderStorageReport(english, usage, {
      agentLabel: () => ({ name, ...(killed ? { killed } : {}) }),
    });
    return out
      .split("\n")
      .find((l) => l.includes("| 7.0 MB | 0 B | 1 |"))!
      .trim();
  }

  it("escapes an agent name that could break out of its table cell", () => {
    const row = rowFor("Ev|il\nrow | 9 TB | 9 | now\\");
    // One row, pipes escaped, newline flattened, trailing backslash doubled so
    // it cannot escape the cell delimiter that follows it.
    expect(row).toBe(
      "| Ev\\|il row \\| 9 TB \\| 9 \\| now\\\\ | 7.0 MB | 0 B | 1 | - |",
    );
  });

  it("renders inline markdown in a name as literal text", () => {
    // Emphasis, code, a link, and raw HTML: none of it may reach the renderer
    // as markup, because none of it is the report's own.
    expect(rowFor("**boss**")).toContain("| \\*\\*boss\\*\\* |");
    expect(rowFor("`rm -rf`")).toContain("| \\`rm \\-rf\\` |");
    expect(rowFor("[click](http://evil.test)")).toContain(
      "| \\[click\\]\\(http\\:\\/\\/evil\\.test\\) |",
    );
    expect(rowFor("<img src=x>")).toContain("| \\<img src\\=x\\> |");
  });

  it("keeps the killed annotation renderer-owned, not forgeable by a name", () => {
    // The annotation is live markdown, which is what a forgery would exploit.
    expect(KILLED).toMatch(/[_*]/u);
    // The trusted form: the renderer's own markup, from the flag.
    const trusted = rowFor("Gone", true);
    expect(trusted).toBe(`| Gone ${KILLED} | 7.0 MB | 0 B | 1 | - |`);

    // A LIVE agent whose name is itself the annotation must not be able to
    // produce that form. The markup is escaped, so it renders as the literal
    // characters a person typed, not as the report's verdict.
    const forged = rowFor(`Gone ${KILLED}`);
    expect(forged).not.toBe(trusted);
    expect(forged.includes(KILLED)).toBe(false);
    expect(forged.endsWith(" | 7.0 MB | 0 B | 1 | - |")).toBe(true);

    // And an ordinary alive name stays clean.
    expect(rowFor("Gone")).toBe("| Gone | 7.0 MB | 0 B | 1 | - |");
  });

  it("states how many agents the table left out", () => {
    const usage = usageFixture({ transcripts: 1 * MB });
    usage.agents = Array.from({ length: 14 }, (_, i) => ({
      agentId: `agent${i}`,
      transcriptBytes: (14 - i) * MB,
      attachmentBytes: 0,
      sessions: 1,
      lastActivityAt: null,
    }));
    // Punctuation-free names here: this case is about the cap, not escaping.
    const out = renderStorageReport(english, usage, {
      agentLabel: (id) => ({ name: id }),
    });
    expect(out).toContain(
      t("storageReport.showing", { shown: "10", total: "14" }),
    );
    expect(out).toContain("| agent9 |");
    expect(out).not.toContain("| agent10 |");
  });
});

// The same measurement, read by a Spanish and a Catalan user: the words, the
// decimal mark and the thousands separator all follow the reader
// (internal-docs/i18n-loop.md, S7, rulings 1 and 12). Each element is compared
// with the same element of the English report, so a line that falls back to
// English fails without the test freezing the translation (principle 15).
describe("renderStorageReport in the reader's language", () => {
  function both(
    language: "es" | "ca",
    usage: StorageUsage,
  ): { en: string[]; local: string[] } {
    return {
      en: renderStorageReport(english, usage, labels).split("\n"),
      local: renderStorageReport(
        translatorForLanguage(language),
        usage,
        labels,
      ).split("\n"),
    };
  }

  it("gives a Spanish reader Spanish words and Spanish number marks", () => {
    const { en, local } = both(
      "es",
      usageFixture({ transcripts: 100 * MB, backups: 400 * MB }),
    );
    expect(local.length).toBe(en.length);
    // Heading and totals sentence, then the table header cell by cell.
    for (const index of [0, 2]) {
      expect(en[index].length).toBeGreaterThan(0);
      expect(local[index]).not.toBe(en[index]);
    }
    const header = (lines: string[]) =>
      lines[6]
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
    expect(header(en).length).toBe(3);
    for (const [index, cell] of header(local).entries())
      expect([index, cell]).not.toEqual([index, header(en)[index]]);
    expect(local[2]).toContain("500,0 MB");
    expect(local[2]).toContain("400,0 MB");
    expect(local[2]).not.toContain("500.0 MB");
    const subtotal = (lines: string[]) =>
      lines.find(
        (l) => l.includes("**100.0 MB**") || l.includes("**100,0 MB**"),
      );
    expect(subtotal(en)).toBeDefined();
    expect(subtotal(local)).toBeDefined();
    expect(subtotal(local)).not.toBe(subtotal(en));
    // The category names are the storage panel's keys, so chat and the panel
    // still call the same bytes the same thing.
    const key = "settings.storage.category.transcripts";
    const spanish = translatorForLanguage("es").t(key);
    expect(spanish).not.toBe(t(key));
    expect(local).toContain(`| ${spanish} | 100,0 MB | 3 |`);
  });

  it("gives a Catalan reader Catalan", () => {
    const { en, local } = both(
      "ca",
      usageFixture({ transcripts: 1 * MB }, { snapshotsAvailable: false }),
    );
    expect(local.length).toBe(en.length);
    expect(local[0]).not.toBe(en[0]);
    // The unconfigured location's row, cell by cell: its name and its "none".
    const unset = (lines: string[]) => {
      const row = lines.find((l) => /^\| [^|]+ \| [^|]+ \| - \|$/u.test(l));
      expect(row).toBeDefined();
      return row!.split(" | ").slice(0, 2);
    };
    for (const [index, cell] of unset(local).entries())
      expect([index, cell]).not.toEqual([index, unset(en)[index]]);
    // ...and its entry in the locations line.
    const locations = (lines: string[]) => {
      const line = lines.find((l) => l.includes("`/srv/state`"));
      expect(line).toBeDefined();
      return line!.split(", ").at(-1);
    };
    expect(locations(local)).not.toBe(locations(en));
  });
});
