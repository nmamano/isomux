import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extensionOutdated,
  validExtensionPackage,
} from "../shared/browser-extension-protocol";

// Uploads the browser extension of the newest release to the Chrome Web Store
// and submits it for review. .github/workflows/extension-release.yml runs it;
// internal-docs/browser-extension.md ("Chrome Web Store") has the flow.

// The parts of the store's fetchStatus answer (Chrome Web Store API v2) that
// the release reads.
export interface CwsRevisionStatus {
  state?: string;
  distributionChannels?: { crxVersion?: string; deployPercentage?: number }[];
}
export interface CwsItemStatus {
  takenDown?: boolean;
  publishedItemRevisionStatus?: CwsRevisionStatus;
  submittedItemRevisionStatus?: CwsRevisionStatus;
  lastAsyncUploadState?: string;
}
export type StoreDecision =
  | { action: "upload" }
  | { action: "skip"; reason: "not_newer" | "in_review" }
  | {
      action: "fail";
      reason:
        | "taken_down"
        | "staged"
        | "rejected"
        | "cancelled"
        | "no_published_revision";
    };
// manifestVersion is the extension version at the release tag (for example
// 0.7.1), not the tag. The rules, in order: a taken-down item fails; then the
// submitted revision: one in review skips (also the first listing), a staged
// one fails (a member staged it in the dashboard), and a rejected or
// cancelled one of this version fails unless retryRejected; then a version
// that is not newer than every published one skips; then an item with no
// published revision fails (the first listing is a dashboard step).
export function decideStoreRelease(input: {
  manifestVersion: string;
  status: CwsItemStatus;
  retryRejected: boolean;
}): StoreDecision {
  const { manifestVersion, status, retryRejected } = input;
  if (status.takenDown) return { action: "fail", reason: "taken_down" };
  const submitted = status.submittedItemRevisionStatus;
  if (submitted?.state === "PENDING_REVIEW")
    return { action: "skip", reason: "in_review" };
  if (submitted?.state === "STAGED")
    return { action: "fail", reason: "staged" };
  if (
    (submitted?.state === "REJECTED" || submitted?.state === "CANCELLED") &&
    !retryRejected &&
    versions(submitted).some((version) => sameVersion(version, manifestVersion))
  )
    return {
      action: "fail",
      reason: submitted.state === "REJECTED" ? "rejected" : "cancelled",
    };
  const published = versions(status.publishedItemRevisionStatus);
  if (published.some((version) => !extensionOutdated(version, manifestVersion)))
    return { action: "skip", reason: "not_newer" };
  if (!published.length)
    return { action: "fail", reason: "no_published_revision" };
  return { action: "upload" };
}
const versions = (revision: CwsRevisionStatus | undefined): string[] =>
  (revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter(validExtensionPackage);
const sameVersion = (a: string, b: string) =>
  !extensionOutdated(a, b) && !extensionOutdated(b, a);

export interface ExtensionManifest {
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
}
// What next asks for that previous did not, as "<field> <value>" with field
// permissions, host_permissions or content_scripts.matches. Empty: no
// widening. A store update that adds a permission with a new warning turns
// the extension off for every member until each one accepts it. Optional
// permissions show no warning, so they do not count.
export function widenedPermissions(
  previous: ExtensionManifest,
  next: ExtensionManifest,
): string[] {
  const fields: [string, (m: ExtensionManifest) => string[]][] = [
    ["permissions", (m) => m.permissions ?? []],
    ["host_permissions", (m) => m.host_permissions ?? []],
    [
      "content_scripts.matches",
      (m) =>
        (m.content_scripts ?? []).flatMap((script) => script.matches ?? []),
    ],
  ];
  return fields.flatMap(([field, read]) => {
    const before = new Set(read(previous));
    return [...new Set(read(next))]
      .filter((entry) => !before.has(entry))
      .map((entry) => `${field} ${entry}`);
  });
}

// Runs git with args and returns its stdout; throws when git fails.
export type GitReader = (args: string[]) => string;
// The release tags, as container-release.yml takes them.
const RELEASE_TAG = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;
// The manifest at the newest release tag whose extension version is
// publishedVersion, or null when no release tag has it.
export function previousPublishedManifest(
  publishedVersion: string,
  git: GitReader,
): ExtensionManifest | null {
  const tags = git(["tag", "--list", "--sort=-creatordate"])
    .split("\n")
    .filter((tag) => RELEASE_TAG.test(tag));
  for (const tag of tags) {
    let manifest: ExtensionManifest;
    try {
      manifest = JSON.parse(
        git(["show", `${tag}:browser-extension/manifest.json`]),
      ) as ExtensionManifest;
    } catch {
      // A release from before the extension.
      continue;
    }
    if (manifest.version === publishedVersion) return manifest;
  }
  return null;
}

const API = "https://chromewebstore.googleapis.com";
// How long the upload may stay in progress before the run gives up.
const UPLOAD_POLLS = 30;
const UPLOAD_POLL_MS = 10_000;

// Usage: bun scripts/extension-store-release.ts <checkout of the release tag>,
// after bun run build:extension there. Env: CWS_PUBLISHER_ID, CWS_ITEM_ID,
// CWS_ACCESS_TOKEN, RETRY_REJECTED (non-empty to submit again a rejected or
// cancelled version).
async function main(dir: string): Promise<number> {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_ITEM_ID")}`;
  const auth = { Authorization: `Bearer ${env("CWS_ACCESS_TOKEN")}` };
  // Prints the API's error body, never the request.
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      headers: { ...auth, ...init.headers },
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${init.method ?? "GET"} ${url}: ${response.status} ${text}`,
      );
    return JSON.parse(text) as Record<string, unknown>;
  };
  const fetchStatus = async () =>
    (await call(`${API}/v2/${item}:fetchStatus`)) as CwsItemStatus;

  const dist = join(dir, "browser-extension", "dist");
  // The manifest that goes into dist.zip.
  const manifest = JSON.parse(
    readFileSync(join(dist, "manifest.json"), "utf8"),
  ) as ExtensionManifest;
  if (!validExtensionPackage(manifest.version))
    throw new Error("The built manifest has no valid version");
  const status = await fetchStatus();
  const decision = decideStoreRelease({
    manifestVersion: manifest.version,
    status,
    retryRejected: !!process.env.RETRY_REJECTED,
  });
  console.log(`extension ${manifest.version}: ${JSON.stringify(decision)}`);
  if (decision.action === "skip") return 0;
  if (decision.action === "fail") return 1;

  const published = versions(status.publishedItemRevisionStatus).reduce(
    (a, b) => (extensionOutdated(a, b) ? b : a),
  );
  const previous = previousPublishedManifest(published, (args) =>
    // A release before the extension has no manifest: keep git's message
    // for that out of the log.
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (!previous) {
    console.log(`No release tag has the published extension ${published}.`);
    return 1;
  }
  const widened = widenedPermissions(previous, manifest);
  if (widened.length) {
    console.log(
      `New permissions since the published ${published}: ${widened.join(", ")}. A member decides; upload this version in the dashboard.`,
    );
    return 1;
  }

  const upload = await call(`${API}/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: readFileSync(join(dir, "browser-extension", "dist.zip")),
  });
  let state = upload.uploadState;
  for (let poll = 0; state === "IN_PROGRESS" && poll < UPLOAD_POLLS; poll++) {
    await Bun.sleep(UPLOAD_POLL_MS);
    state = (await fetchStatus()).lastAsyncUploadState;
  }
  console.log(`upload: ${String(state)}`);
  if (state !== "SUCCEEDED") return 1;
  const submit = await call(`${API}/v2/${item}:publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
      blockOnWarnings: true,
    }),
  });
  console.log(`submitted: ${String(submit.state)}`);
  return 0;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error(
      "Usage: bun scripts/extension-store-release.ts <release checkout>",
    );
    process.exit(2);
  }
  process.exit(await main(dir));
}
