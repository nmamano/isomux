// Every GitHub Action the repository runs is pinned to a full commit SHA.
// Whoever takes over an action's repository can move its tags (v4, v4.1.0),
// and the moved tag then runs in our jobs with their secrets: the release
// jobs push the images and publish the browser extension (tj-actions/
// changed-files, 2025). Dependabot moves the SHA and the version comment.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Every workflow, and every composite action wherever it lives.
function scannedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter(
      (f) =>
        /^\.github\/.+\.ya?ml$/.test(f) || /^action\.ya?ml$/.test(basename(f)),
    );
}

// The value of each `uses:` key, found leniently (step, job, flow mapping,
// quoted or not) so a shape the check does not expect fails it instead of
// slipping past. An empty value fails too.
function usesIn(text: string): { line: number; value: string }[] {
  const found: { line: number; value: string }[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const m = /(?:^|[\s{,-])uses\s*:\s*([^\s,}]*)/.exec(line);
    if (!m) return;
    found.push({
      line: index + 1,
      value: m[1].replace(/^(["'])(.*)\1$/, "$2"),
    });
  });
  return found;
}

function pinned(value: string): boolean {
  return (
    /^\.\/\S+$/.test(value) ||
    /^[\w.-]+\/[\w.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/.test(value)
  );
}

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("workflow action pins", () => {
  test("a ref is pinned only by a local path or a full commit SHA", () => {
    const cases: [string, boolean][] = [
      [`actions/checkout@${SHA}`, true],
      [`owner/repo/.github/workflows/build.yml@${SHA}`, true],
      ["./.github/actions/setup", true],
      ["actions/checkout@v4", false],
      ["actions/checkout@v4.1.0", false],
      ["actions/checkout@main", false],
      [`actions/checkout@${SHA.slice(0, 39)}`, false],
      [`actions/checkout@${SHA.slice(0, 7)}`, false],
      [`actions/checkout@${SHA}x`, false],
      [`actions/checkout@${SHA.toUpperCase()}`, false],
      [`actions/checkout@${SHA}@v4`, false],
      ["actions/checkout", false],
      ["docker://alpine:3.20", false],
      ["", false],
    ];
    expect(cases.map(([value]) => [value, pinned(value)])).toStrictEqual(cases);
  });

  test("the scan finds a uses key in every shape YAML allows", () => {
    const text = [
      "jobs:", // 1
      "  call:", // 2
      "    uses: owner/repo/.github/workflows/x.yml@v1", // 3
      "  build:", // 4
      "    steps:", // 5
      "      - uses: actions/checkout@v4 # v4.1.0", // 6
      "      - name: Bun", // 7
      "        uses: 'oven-sh/setup-bun@v2'", // 8
      '      - uses: "actions/upload-artifact@v7"', // 9
      "      - { uses: actions/cache@v4, with: { key: k } }", // 10
      "      - uses:", // 11
      "      # - uses: actions/old@v1", // 12
      "      - run: echo done # uses: nothing", // 13
    ].join("\n");
    expect(usesIn(text)).toStrictEqual([
      { line: 3, value: "owner/repo/.github/workflows/x.yml@v1" },
      { line: 6, value: "actions/checkout@v4" },
      { line: 8, value: "oven-sh/setup-bun@v2" },
      { line: 9, value: "actions/upload-artifact@v7" },
      { line: 10, value: "actions/cache@v4" },
      { line: 11, value: "" },
    ]);
  });

  test("every action the workflows use is pinned to a commit SHA", () => {
    const refs = scannedFiles().flatMap((file) =>
      usesIn(readFileSync(join(ROOT, file), "utf8")).map((u) => ({
        at: `${file}:${u.line}`,
        value: u.value,
      })),
    );
    // The scan reaches the release job that can publish with an id token.
    expect(
      refs.some(
        (r) =>
          r.at.startsWith(".github/workflows/extension-release.yml:") &&
          r.value.startsWith("google-github-actions/auth@"),
      ),
    ).toBe(true);
    expect(
      refs.filter((r) => !pinned(r.value)).map((r) => `${r.at} ${r.value}`),
    ).toStrictEqual([]);
  });
});
