// Gives each script and style a page links to a new URL when its content
// changes: src="/x.js" becomes src="/x.js?v=<assetVersion>" in every .html of
// the site. The image workflow runs it after the site build; the site host
// caches a matching ?v= as immutable. Only the image gets it: it rewrites the
// tracked pages in place, so a local build and Vercel serve the plain names.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assetVersion } from "./server.ts";

// A script's src or a stylesheet's href that names a path of the site, with no
// query or fragment of its own (a versioned reference has one).
const REFERENCE =
  /(?<=\s)(?:src="(\/(?!\/)[^"?#]+\.js)"|href="(\/(?!\/)[^"?#]+\.css)")/g;

/**
 * Rewrites the script and style references of every .html file under siteDir.
 * Returns the count of references it rewrote.
 */
export async function versionAssets(siteDir: string): Promise<number> {
  const root = resolve(siteDir);
  const versions = new Map<string, string | null>();
  async function version(path: string): Promise<string | null> {
    if (!versions.has(path)) {
      const file = resolve(root, `.${path}`);
      versions.set(
        path,
        file.startsWith(root + sep)
          ? await readFile(file).then(assetVersion, () => null)
          : null,
      );
    }
    return versions.get(path)!;
  }

  let count = 0;
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries.filter((name) => name.endsWith(".html"))) {
    const page = join(root, entry);
    const html = await readFile(page, "utf8");
    const parts: string[] = [];
    let last = 0;
    for (const match of html.matchAll(REFERENCE)) {
      const path = match[1] ?? match[2];
      const v = await version(path);
      if (v === null) continue;
      // The closing quote is the match's last character.
      const end = match.index + match[0].length - 1;
      parts.push(html.slice(last, end), `?v=${v}`);
      last = end;
      count++;
    }
    if (last > 0) await writeFile(page, parts.join("") + html.slice(last));
  }
  return count;
}

// `bun site-host/version-assets.ts <siteDir>`. The site always links scripts
// and styles, so a run that rewrites none means this rewrite is broken.
if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun site-host/version-assets.ts <siteDir>");
    process.exit(2);
  }
  const count = await versionAssets(dir);
  if (count === 0) {
    console.error(`version-assets: no script or style reference in ${dir}`);
    process.exit(1);
  }
  console.log(`version-assets: ${count} references versioned in ${dir}`);
}
