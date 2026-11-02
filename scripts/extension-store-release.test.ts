import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideStoreRelease,
  previousPublishedManifest,
  widenedPermissions,
  type CwsItemStatus,
  type ExtensionManifest,
  type GitReader,
} from "./extension-store-release";

// A revision of the store item: its state and the versions it deploys.
const rev = (state: string, ...versions: string[]) => ({
  state,
  distributionChannels: versions.map((crxVersion) => ({
    crxVersion,
    deployPercentage: 100,
  })),
});
const decide = (
  manifestVersion: string,
  status: CwsItemStatus,
  retryRejected = false,
) => decideStoreRelease({ manifestVersion, status, retryRejected });

describe("decideStoreRelease", () => {
  const published = (version: string) => ({
    publishedItemRevisionStatus: rev("PUBLISHED", version),
  });

  test("a newer manifest than the published version uploads; the same or an older one skips", () => {
    expect(decide("0.7.1", published("0.7.0"))).toEqual({ action: "upload" });
    expect(decide("0.7.1", published("0.7.1"))).toEqual({
      action: "skip",
      reason: "not_newer",
    });
    expect(decide("0.7.1", published("0.7.2"))).toEqual({
      action: "skip",
      reason: "not_newer",
    });
  });

  // A string compare gets both wrong.
  test("versions compare part by part as numbers", () => {
    expect(decide("0.7.10", published("0.7.9"))).toEqual({ action: "upload" });
    expect(decide("0.9.0", published("0.10.0"))).toEqual({
      action: "skip",
      reason: "not_newer",
    });
    expect(decide("1.0", published("0.99.99"))).toEqual({ action: "upload" });
  });

  test("the store version is the highest version a published revision deploys", () => {
    // A partial rollout deploys two versions at once.
    const status = {
      publishedItemRevisionStatus: rev("PUBLISHED", "0.7.0", "0.7.1"),
    };
    expect(decide("0.7.1", status)).toEqual({
      action: "skip",
      reason: "not_newer",
    });
    expect(decide("0.7.2", status)).toEqual({ action: "upload" });
  });

  test("a submission that waits for review skips, also for a newer manifest and for the first listing", () => {
    const waiting = {
      ...published("0.7.0"),
      submittedItemRevisionStatus: rev("PENDING_REVIEW", "0.7.1"),
    };
    for (const version of ["0.7.1", "0.7.2"])
      expect(decide(version, waiting)).toEqual({
        action: "skip",
        reason: "in_review",
      });
    // The first listing, submitted by hand, has no published revision yet.
    expect(
      decide("0.7.1", {
        submittedItemRevisionStatus: rev("PENDING_REVIEW", "0.7.1"),
      }),
    ).toEqual({ action: "skip", reason: "in_review" });
  });

  test("a staged submission fails for any manifest version", () => {
    for (const version of ["0.7.1", "0.7.2"])
      expect(
        decide(version, {
          ...published("0.7.0"),
          submittedItemRevisionStatus: rev("STAGED", "0.7.1"),
        }),
      ).toEqual({ action: "fail", reason: "staged" });
  });

  for (const [state, reason] of [
    ["REJECTED", "rejected"],
    ["CANCELLED", "cancelled"],
  ] as const)
    test(`a ${state} submission of the manifest version fails unless retried; a newer version uploads`, () => {
      const status = {
        ...published("0.7.0"),
        submittedItemRevisionStatus: rev(state, "0.7.1"),
      };
      expect(decide("0.7.1", status)).toEqual({ action: "fail", reason });
      expect(decide("0.7.1", status, true)).toEqual({ action: "upload" });
      expect(decide("0.7.2", status)).toEqual({ action: "upload" });
    });

  test("a retry does not upload a version the store already publishes", () => {
    expect(decide("0.7.1", published("0.7.1"), true)).toEqual({
      action: "skip",
      reason: "not_newer",
    });
  });

  test("a taken-down item fails before any other rule", () => {
    for (const status of [
      published("0.7.0"),
      {
        ...published("0.7.0"),
        submittedItemRevisionStatus: rev("PENDING_REVIEW", "0.7.1"),
      },
      {
        ...published("0.7.0"),
        submittedItemRevisionStatus: rev("REJECTED", "0.7.1"),
      },
    ])
      expect(decide("0.7.1", { ...status, takenDown: true }, true)).toEqual({
        action: "fail",
        reason: "taken_down",
      });
  });

  test("an item with no published revision and nothing in review fails", () => {
    expect(decide("0.7.1", {})).toEqual({
      action: "fail",
      reason: "no_published_revision",
    });
  });
});

describe("widenedPermissions", () => {
  const base: ExtensionManifest = {
    version: "0.7.1",
    permissions: ["debugger", "activeTab", "storage"],
    host_permissions: ["https://example.com/*"],
    content_scripts: [{ matches: ["https://a.example/*"] }],
  };
  const widened = (next: ExtensionManifest) =>
    widenedPermissions(base, next).sort();

  test("the same manifest, a reorder, a version bump and a removal are not a widening", () => {
    expect(widened(base)).toEqual([]);
    expect(
      widened({
        version: "0.8.0",
        permissions: ["storage", "debugger"],
        host_permissions: [],
        content_scripts: [],
      }),
    ).toEqual([]);
  });

  test("each new entry is named with its field", () => {
    expect(
      widened({
        ...base,
        permissions: [...base.permissions!, "tabs", "history"],
        host_permissions: ["<all_urls>"],
        content_scripts: [
          { matches: ["https://a.example/*"] },
          { matches: ["https://b.example/*"] },
        ],
      }),
    ).toEqual(
      [
        "permissions tabs",
        "permissions history",
        "host_permissions <all_urls>",
        "content_scripts.matches https://b.example/*",
      ].sort(),
    );
  });

  test("a field the previous manifest did not have widens with every entry", () => {
    expect(
      widenedPermissions(
        { version: "0.4.1", permissions: ["storage"] },
        {
          version: "0.7.1",
          permissions: ["storage"],
          host_permissions: ["https://*/*"],
          content_scripts: [{ matches: ["https://*/*"] }],
        },
      ).sort(),
    ).toEqual(
      [
        "content_scripts.matches https://*/*",
        "host_permissions https://*/*",
      ].sort(),
    );
  });

  test("a match that moves to another content script is not a widening", () => {
    expect(
      widened({
        ...base,
        content_scripts: [
          { matches: [] },
          { matches: ["https://a.example/*"] },
        ],
      }),
    ).toEqual([]);
  });

  // Optional permissions show no warning at install or update.
  test("optional permissions are not a widening", () => {
    const next = {
      ...base,
      optional_permissions: ["tabs"],
      optional_host_permissions: ["<all_urls>"],
    };
    expect(widened(next)).toEqual([]);
  });
});

describe("previousPublishedManifest", () => {
  let dir: string;
  let git: GitReader;
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  let day = 0;
  // A commit with the extension manifest (or none), tagged as release.sh tags
  // (annotated). Each commit and tag is one day after the one before, so the
  // creation order and the name order agree.
  const release = (tag: string, manifest: ExtensionManifest | null) => {
    const date = `2026-10-${String(++day).padStart(2, "0")}T12:00:00Z`;
    const dated = {
      ...env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const path = join(dir, "browser-extension", "manifest.json");
    if (manifest) writeFileSync(path, JSON.stringify(manifest));
    else rmSync(path, { force: true });
    execFileSync("git", ["add", "-A"], { cwd: dir, env: dated });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", tag], {
      cwd: dir,
      env: dated,
    });
    execFileSync("git", ["tag", "-a", tag, "-m", tag], {
      cwd: dir,
      env: dated,
    });
  };
  const manifest = (version: string, marker: string) => ({
    version,
    permissions: ["storage", marker],
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "extension-store-release-"));
    mkdirSync(join(dir, "browser-extension"));
    execFileSync("git", ["init", "-q"], { cwd: dir, env });
    git = (args) =>
      execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    // A release from before the extension existed.
    release("v2026.9.2", null);
    release("v2026.9.22", manifest("0.4.1", "first"));
    release("v2026.10.1", manifest("0.7.0", "older"));
    // Two releases with the same extension version: the newer one counts.
    release("v2026.10.5", manifest("0.7.0", "newer"));
    release("v2026.10.8.2", manifest("0.7.1", "fourth-part"));
    // Tags that are not release tags, newer than every release.
    release("v2026.10.9-rc1", manifest("0.7.0", "rc"));
    release("ext-0.7.0", manifest("0.7.0", "stray"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the newest release tag with the published version gives the manifest", () => {
    expect(previousPublishedManifest("0.7.0", git)).toEqual(
      manifest("0.7.0", "newer"),
    );
    expect(previousPublishedManifest("0.4.1", git)).toEqual(
      manifest("0.4.1", "first"),
    );
    expect(previousPublishedManifest("0.7.1", git)).toEqual(
      manifest("0.7.1", "fourth-part"),
    );
  });

  test("a version no release tag has gives null, also past a release with no extension", () => {
    expect(previousPublishedManifest("0.9.9", git)).toBeNull();
  });
});
