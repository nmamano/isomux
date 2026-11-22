// scripts/reference-headroom.ts: the gate fails the diff that makes an agent
// reference page grow while it is over AGENT_REFERENCE_WARN_AT of the cap
// (task f3858003). The pure check first, then the CLI on a real git repo.
// Zero LLM, no network.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AGENT_REFERENCE_PAGE_CAP,
  AGENT_REFERENCE_WARN_AT,
} from "../server/agent-reference-size.ts";
import { referenceHeadroom } from "./reference-headroom.ts";

const CLI = join(import.meta.dir, "reference-headroom.ts");
/** The largest served size that is not over the share. */
const AT_SHARE = Math.floor(AGENT_REFERENCE_PAGE_CAP * AGENT_REFERENCE_WARN_AT);
const PAGE = "server/agent-reference/headroom-probe.md";

/** A page of exactly `bytes` served bytes, with no table in it. */
const page = (bytes: number) => "a".repeat(bytes - 1) + "\n";

describe("referenceHeadroom", () => {
  it("fails a page that grows while over the share, with its served bytes", () => {
    expect(
      referenceHeadroom([
        {
          path: PAGE,
          before: page(AT_SHARE + 100),
          after: page(AT_SHARE + 101),
        },
      ]),
    ).toEqual([{ path: PAGE, before: AT_SHARE + 100, after: AT_SHARE + 101 }]);
  });

  it("fails a page that grows from under the share to over it", () => {
    expect(
      referenceHeadroom([
        { path: PAGE, before: page(5_000), after: page(AT_SHARE + 1) },
      ]),
    ).toEqual([{ path: PAGE, before: 5_000, after: AT_SHARE + 1 }]);
  });

  // The share is a strict bound, as in the CI warning: AT_SHARE is not over.
  it("passes a page that grows to the share and no further", () => {
    expect(
      referenceHeadroom([
        { path: PAGE, before: page(5_000), after: page(AT_SHARE) },
      ]),
    ).toEqual([]);
  });

  it("passes a page over the share that stays the same size or shrinks", () => {
    expect(
      referenceHeadroom([
        {
          path: PAGE,
          before: page(AT_SHARE + 500),
          // Same size, other text.
          after: "b".repeat(AT_SHARE + 499) + "\n",
        },
        {
          path: "server/agent-reference/other.md",
          before: page(AT_SHARE + 500),
          after: page(AT_SHARE + 1),
        },
      ]),
    ).toEqual([]);
  });

  it("counts a new page from 0 bytes", () => {
    expect(
      referenceHeadroom([
        { path: PAGE, before: undefined, after: page(AT_SHARE + 1) },
        {
          path: "server/agent-reference/small.md",
          before: undefined,
          after: page(AT_SHARE),
        },
      ]),
    ).toEqual([{ path: PAGE, before: 0, after: AT_SHARE + 1 }]);
  });

  it("never fails a deleted page", () => {
    expect(
      referenceHeadroom([
        { path: PAGE, before: page(AT_SHARE + 100), after: undefined },
      ]),
    ).toEqual([]);
  });

  // An agent receives the page with its table padding dropped, so the padding
  // counts for nothing: this page is over the share on disk only.
  it("measures tables as an agent receives them, not as padded on disk", () => {
    const padded = (rows: number) =>
      "| a" +
      " ".repeat(40) +
      "| b" +
      " ".repeat(40) +
      "|\n" +
      "| " +
      "-".repeat(42) +
      " | " +
      "-".repeat(42) +
      " |\n" +
      ("| x" + " ".repeat(40) + "| y" + " ".repeat(40) + "|\n").repeat(rows);
    const before = padded(90);
    const after = padded(100);
    // On disk both are over the share and the page grew.
    expect(Buffer.byteLength(before)).toBeGreaterThan(AT_SHARE);
    expect(Buffer.byteLength(after)).toBeGreaterThan(Buffer.byteLength(before));
    expect(referenceHeadroom([{ path: PAGE, before, after }])).toEqual([]);

    // The same table rows, served size over the share: the reported numbers
    // are the served bytes.
    const big = padded(800);
    const bigger = padded(801);
    const served = (rows: number) =>
      "| a | b |\n| --- | --- |\n" + "| x | y |\n".repeat(rows);
    expect(
      referenceHeadroom([{ path: PAGE, before: big, after: bigger }]),
    ).toEqual([
      {
        path: PAGE,
        before: Buffer.byteLength(served(800)),
        after: Buffer.byteLength(served(801)),
      },
    ]);
  });

  // The cap is in bytes: a page of 3-byte characters is over the share with a
  // third as many characters.
  it("counts bytes, not characters", () => {
    const arrows = (n: number) => "→".repeat(n) + "\n";
    const n = Math.ceil(AT_SHARE / 3) + 10;
    expect(
      referenceHeadroom([
        { path: PAGE, before: arrows(n - 1), after: arrows(n) },
      ]),
    ).toEqual([{ path: PAGE, before: (n - 1) * 3 + 1, after: n * 3 + 1 }]);
  });

  it("reports only the pages that fail, in the order given", () => {
    const pages = ["a", "b", "c", "d"].map(
      (name) => `server/agent-reference/${name}.md`,
    );
    expect(
      referenceHeadroom([
        {
          path: pages[0]!,
          before: page(AT_SHARE + 1),
          after: page(AT_SHARE + 2),
        },
        { path: pages[1]!, before: page(100), after: page(200) },
        { path: pages[2]!, before: undefined, after: page(AT_SHARE + 9) },
        {
          path: pages[3]!,
          before: page(AT_SHARE + 9),
          after: page(AT_SHARE + 3),
        },
      ]).map((v) => v.path),
    ).toEqual([pages[0], pages[2]]);
  });
});

// --- CLI: bun scripts/reference-headroom.ts <base>, run in the repo ---------

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-headroom-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "probe@probe");
  git(dir, "config", "user.name", "Probe");
  mkdirSync(join(dir, "server", "agent-reference"), { recursive: true });
  mkdirSync(join(dir, "docs"));
  return dir;
}

function commit(dir: string, files: Record<string, string | null>): string {
  // Writes first: removing a folder's last file removes the folder.
  const entries = Object.entries(files);
  for (const [path, text] of entries) {
    if (text === null) continue;
    writeFileSync(join(dir, path), text);
    git(dir, "add", path);
  }
  for (const [path, text] of entries)
    if (text === null) git(dir, "rm", "-q", path);
  git(dir, "commit", "-qm", "change");
  return git(dir, "rev-parse", "HEAD");
}

function cli(dir: string, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const lines = (out: string) => out.split("\n").filter(Boolean);

describe("reference-headroom CLI", () => {
  it("exits 1 and names the page and its bytes when a page over the share grew", () => {
    const dir = repo();
    const base = commit(dir, {
      [PAGE]: page(AT_SHARE + 100),
      "server/agent-reference/calm.md": page(1_000),
    });
    commit(dir, {
      [PAGE]: page(AT_SHARE + 150),
      "server/agent-reference/calm.md": page(1_200),
    });
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(1);
    const flagged = lines(r.out).filter((l) => l.includes("headroom-probe"));
    expect(flagged, r.out).toHaveLength(1);
    for (const n of [AT_SHARE + 100, AT_SHARE + 150, AGENT_REFERENCE_PAGE_CAP])
      expect(flagged[0]).toContain(String(n));
    expect(r.out).not.toContain("calm");
  });

  it("exits 0 with one line when the changed pages pass", () => {
    const dir = repo();
    const base = commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir, { [PAGE]: page(AT_SHARE + 10) });
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(0);
    expect(lines(r.out), r.out).toHaveLength(1);
    expect(r.out).not.toContain("headroom-probe");
  });

  it("exits 0 with one line when the diff changes no page", () => {
    const dir = repo();
    const base = commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    // A markdown file outside the reference pages is not a page.
    commit(dir, { "docs/guide.md": page(AGENT_REFERENCE_PAGE_CAP) });
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(0);
    expect(lines(r.out), r.out).toHaveLength(1);
  });

  it("fails a new page over the share and passes a deleted one", () => {
    const dir = repo();
    const base = commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir, {
      [PAGE]: null,
      "server/agent-reference/fresh.md": page(AT_SHARE + 1),
    });
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(1);
    expect(r.out).toContain("fresh");
    expect(r.out).not.toContain("headroom-probe");
  });

  // The gate tests a commit: a page grown on disk only is not in it.
  it("reads the pages at the base and at HEAD, not on disk", () => {
    const dir = repo();
    const base = commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir, { "docs/guide.md": "x\n" });
    writeFileSync(join(dir, PAGE), page(AT_SHARE + 500));
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(0);

    // And the other way: grown at HEAD, cut back on disk.
    const dir2 = repo();
    const base2 = commit(dir2, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir2, { [PAGE]: page(AT_SHARE + 500) });
    writeFileSync(join(dir2, PAGE), page(100));
    const r2 = cli(dir2, base2);
    expect(r2.status, r2.out + r2.err).toBe(1);
  });

  // The diff is from the base it is given, not from that base's parent or
  // from the last commit only.
  it("compares HEAD with the given base across several commits", () => {
    const dir = repo();
    const base = commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir, { [PAGE]: page(AT_SHARE + 300) });
    commit(dir, { [PAGE]: page(AT_SHARE + 200) });
    // The last commit shrank the page; from the base, it grew.
    const r = cli(dir, base);
    expect(r.status, r.out + r.err).toBe(1);
    expect(r.out).toContain(String(AT_SHARE + 200));

    // The page grew in an earlier commit, and the last one does not touch it.
    const dir2 = repo();
    const base2 = commit(dir2, { [PAGE]: page(AT_SHARE + 100) });
    commit(dir2, { [PAGE]: page(AT_SHARE + 300) });
    commit(dir2, { "docs/guide.md": "x\n" });
    const r2 = cli(dir2, base2);
    expect(r2.status, r2.out + r2.err).toBe(1);
    expect(r2.out).toContain(String(AT_SHARE + 300));
  });

  it("exits 2 on a base git cannot resolve, or with no base", () => {
    const dir = repo();
    commit(dir, { [PAGE]: page(AT_SHARE + 100) });
    expect(cli(dir, "no-such-ref").status).toBe(2);
    expect(cli(dir).status).toBe(2);
    expect(cli(dir, "HEAD", "HEAD").status).toBe(2);
  });
});
