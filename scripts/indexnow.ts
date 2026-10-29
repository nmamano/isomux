// IndexNow: after each deploy of isomux.com, tell Bing, Yandex and the other
// IndexNow engines which sitemap URLs changed. Run by
// .github/workflows/indexnow.yml after each successful Site image run on main
// (the VPS deploys that image within minutes).
//
// "Changed" is measured on the built site, not on the sources: the workflow
// runs build:docs at this run and at the previous one, and a URL goes in
// the list when its built page differs, is new, or left the sitemap. Doc pages
// carry the nav of every page and build-docs.ts templates all of them, so a
// source-to-URL map would need rules that drift; the built diff needs none.
// /demo is built by build:demo, which the workflow skips, so it is never sent.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Public by design: site/<key>.txt serves it to prove we own the host.
export const INDEXNOW_KEY = "fbffa404de590d880791f3058b42c157";
export const SITE_HOST = "isomux.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";

// One run of the Site image workflow (.github/workflows/site-image.yml), as
// the GitHub actions runs API lists it.
export type SiteImageRun = {
  id: number;
  runNumber: number;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string | null;
};

// The file a sitemap path serves from, resolved as Vercel's cleanUrls does:
// `<path>.html`, else `<path>/index.html`.
function builtFileFor(siteDir: string, urlPath: string): string | null {
  const path = urlPath.replace(/\/+$/, "");
  const candidates = path
    ? [join(siteDir, `${path}.html`), join(siteDir, path, "index.html")]
    : [join(siteDir, "index.html")];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function sitemapUrls(siteDir: string): string[] {
  const xml = readFileSync(join(siteDir, "sitemap.xml"), "utf8");
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function pageBytes(siteDir: string, url: string): Buffer | null {
  const file = builtFileFor(siteDir, new URL(url).pathname);
  return file ? readFileSync(file) : null;
}

// With no base build (first deploy, or the base did not build), every built
// page of the head sitemap counts as changed.
export function changedUrls(
  headSiteDir: string,
  baseSiteDir: string | null,
): string[] {
  const headUrls = sitemapUrls(headSiteDir);
  if (baseSiteDir === null)
    return headUrls.filter((url) => pageBytes(headSiteDir, url) !== null);
  const changed = headUrls.filter((url) => {
    const head = pageBytes(headSiteDir, url);
    const base = pageBytes(baseSiteDir, url);
    if (head === null || base === null) return head !== base;
    return !head.equals(base);
  });
  // IndexNow takes deleted URLs too: the engine then sees the 404 or the
  // vercel.json redirect.
  const removed = sitemapUrls(baseSiteDir).filter(
    (url) => !headUrls.includes(url),
  );
  return [...changed, ...removed];
}

// The head sha of the newest successful Site image run on main numbered
// before the current run, or null when there is none.
export function pickBaseRunSha(
  runs: SiteImageRun[],
  currentRunId: number,
): string | null {
  const current = runs.find((r) => r.id === currentRunId);
  if (!current) return null;
  const candidates = runs
    .filter(
      (r) =>
        r.headBranch === "main" &&
        r.conclusion === "success" &&
        r.runNumber < current.runNumber,
    )
    .sort((a, b) => b.runNumber - a.runNumber);
  return candidates[0]?.headSha ?? null;
}

// 200 is accepted; 202 is accepted while IndexNow validates the key. Any
// other status throws, so the workflow run goes red.
export async function pingIndexNow(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (urls.length === 0) return;
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: SITE_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });
  if (!res.ok) {
    throw new Error(`IndexNow answered ${res.status}: ${await res.text()}`);
  }
}

async function github(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

// Site image runs once per push to main, so the last 50 runs on main hold the
// previous successful one unless 50 in a row failed.
async function fetchRuns(repo: string): Promise<SiteImageRun[]> {
  const page = (await github(
    `/repos/${repo}/actions/workflows/site-image.yml/runs?branch=main&per_page=50`,
  )) as {
    workflow_runs: {
      id: number;
      run_number: number;
      head_branch: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
    }[];
  };
  return page.workflow_runs.map((r) => ({
    id: r.id,
    runNumber: r.run_number,
    headBranch: r.head_branch,
    headSha: r.head_sha,
    status: r.status,
    conclusion: r.conclusion,
  }));
}

// bun scripts/indexnow.ts base-sha <run id>
//   prints the head sha of the previous successful Site image run, or nothing.
// bun scripts/indexnow.ts ping --head <site dir> [--base <site dir>] [--dry-run]
//   prints the changed URLs and, without --dry-run, sends them.
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "base-sha") {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo || !args[0]) throw new Error("usage: base-sha <run id>");
    const sha = pickBaseRunSha(await fetchRuns(repo), Number(args[0]));
    if (sha) console.log(sha);
    return;
  }
  if (command === "ping") {
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const head = flag("--head");
    if (!head)
      throw new Error("usage: ping --head <site dir> [--base <site dir>]");
    const urls = changedUrls(head, flag("--base") ?? null);
    console.log(`${urls.length} changed URL(s)`);
    for (const url of urls) console.log(url);
    if (!args.includes("--dry-run")) await pingIndexNow(urls);
    return;
  }
  throw new Error("usage: indexnow.ts base-sha <id> | ping --head <dir> ...");
}

if (import.meta.main) await main();
