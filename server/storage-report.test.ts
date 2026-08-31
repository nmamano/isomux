// T0 - the /isomux-storage markdown report (task 1387a9c7).
//
// The renderer is pure: it takes an already-measured StorageUsage, so these
// build the measurement by hand and never touch a disk. What matters here is
// the OWNER/non-owner split (the report must not leak paths or per-agent detail
// into the aggregate projection) and the arithmetic a reader will trust: the
// headline total counts the out-of-root locations on top of the state root.

import { describe, it, expect } from "bun:test";
import { renderStorageReport } from "./storage-report.ts";
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
    "attachments",
    "session-metadata",
    "codex-home",
    "provider-homes",
    "cronjobs",
    "memory",
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

describe("renderStorageReport", () => {
  it("totals the state root plus the locations outside it", () => {
    const out = renderStorageReport(
      usageFixture({ transcripts: 100 * MB, backups: 400 * MB }),
      labels,
    );
    // 100 MB in-root + 400 MB of backups; the headline is the sum, and the
    // state-root subtotal stays separate from it.
    expect(out).toContain("**500.0 MB total:**");
    expect(out).toContain("plus 400.0 MB in backups.");
    expect(out).toContain("| **Total office state** | **100.0 MB** | |");
    expect(out).toContain("| **Total** | **500.0 MB** | |");
  });

  it("says everything is office state when nothing lives outside it", () => {
    const out = renderStorageReport(usageFixture({ transcripts: 2 * MB }), {
      agentLabel: () => ({ name: "x" }),
    });
    expect(out).toContain("**2.0 MB total**, all of it office state.");
    // No phantom credit to locations with nothing in them.
    expect(out).not.toContain("plus");
  });

  it("names only the out-of-root locations that hold bytes", () => {
    const both = renderStorageReport(
      usageFixture({ backups: 1 * MB, "update-snapshots": 1 * MB }),
      labels,
    );
    expect(both).toContain("in backups and update snapshots.");
    const snapshotsOnly = renderStorageReport(
      usageFixture({ "update-snapshots": 1 * MB }),
      labels,
    );
    expect(snapshotsOnly).toContain("in update snapshots.");
  });

  it("marks an unconfigured location as none rather than zero", () => {
    const out = renderStorageReport(
      usageFixture({ transcripts: 1 * MB }, { snapshotsAvailable: false }),
      labels,
    );
    expect(out).toContain("| Update snapshots | none | - |");
    expect(out).toContain("update snapshots (not set up)");
  });

  it("gives the owner paths and the per-agent breakdown", () => {
    const out = renderStorageReport(usageFixture({ transcripts: 1 * MB }), {
      agentLabel: (id) =>
        id === "agent-gone"
          ? { name: "Ghost", killed: true }
          : { name: "Live" },
    });
    expect(out).toContain("office state `/srv/state`");
    expect(out).toContain("### Biggest agents");
    // Sorted by transcripts + attachments, so the killed 40 MB agent leads.
    const ghostRow = out.indexOf("| Ghost _(killed)_ |");
    const liveRow = out.indexOf("| Live |");
    expect(ghostRow).toBeGreaterThan(-1);
    expect(ghostRow).toBeLessThan(liveRow);
    // No transcript mtime at all reads as an em dash, not "just now".
    expect(out).toContain("| 3 | - |");
  });

  it("withholds paths and per-agent detail from the aggregate projection", () => {
    const full = usageFixture({ transcripts: 1 * MB, backups: 2 * MB });
    const out = renderStorageReport(aggregateOnly(full), labels);
    expect(out).not.toContain("/srv/state");
    expect(out).not.toContain("/srv/isomux-backups");
    expect(out).not.toContain("Biggest agents");
    expect(out).not.toContain("name:agent-live");
    expect(out).toContain("owner-only");
    // The sizes themselves still come through - that is the whole point of the
    // projection.
    expect(out).toContain("**3.0 MB total:**");
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
    const out = renderStorageReport(usage, {
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
    // The trusted form: the renderer's own italics, from the flag.
    const trusted = rowFor("Gone", true);
    expect(trusted).toBe("| Gone _(killed)_ | 7.0 MB | 0 B | 1 | - |");

    // A LIVE agent whose name is itself the annotation must not be able to
    // produce that form. The underscores are escaped, so it renders as the
    // literal characters a person typed, not as the report's verdict.
    const forged = rowFor("Gone _(killed)_");
    expect(forged).not.toBe(trusted);
    expect(forged).toBe("| Gone \\_\\(killed\\)\\_ | 7.0 MB | 0 B | 1 | - |");
    // No unescaped copy of the annotation anywhere in the forged row.
    expect(forged.includes(" _(killed)_")).toBe(false);

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
    const out = renderStorageReport(usage, {
      agentLabel: (id) => ({ name: id }),
    });
    expect(out).toContain(
      "Showing the 10 largest of 14 agents with stored data.",
    );
    expect(out).toContain("| agent9 |");
    expect(out).not.toContain("| agent10 |");
  });
});
