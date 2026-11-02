import {
  mkdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";
import { CATALOGS } from "../shared/i18n/translate";
import type { Catalog } from "../shared/i18n/translate";
import { extensionZip } from "./extension-zip";

export const EXTENSION_ENTRIES = [
  "background.js",
  "connection.css",
  "connection.html",
  "connection.js",
  "manifest.json",
  "icon.png",
] as const;
export async function buildBrowserExtension(
  outdir = resolve("browser-extension/dist"),
): Promise<void> {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      resolve("browser-extension/background.ts"),
      resolve("browser-extension/connection.ts"),
    ],
    outdir,
    target: "browser",
    plugins: [extensionCatalogs()],
  });
  if (!result.success) throw new Error("Browser extension build failed");
  for (const file of ["manifest.json", "connection.html", "connection.css"])
    copyFileSync(resolve("browser-extension", file), resolve(outdir, file));
  copyFileSync(resolve("ui/icons/icon-192.png"), resolve(outdir, "icon.png"));
  const archive = `${outdir}.zip`;
  const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      extensionZip(
        EXTENSION_ENTRIES.map((name) => ({
          name,
          data: readFileSync(resolve(outdir, name)),
        })),
      ),
    );
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
}
// Replaces each catalog in `catalogs` with its browser.* keys only, so the
// extension build changes only when a string the extension shows changes.
export function extensionCatalogs(
  catalogs: Record<string, Catalog> = CATALOGS,
): BunPlugin {
  const codes = new Map(
    Object.keys(catalogs).map((code) => [
      resolve(import.meta.dir, "../shared/i18n", `${code}.ts`),
      code,
    ]),
  );
  const escaped = [...codes.keys()].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return {
    name: "extension-catalogs",
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`^(${escaped.join("|")})$`) },
        (args) => {
          const code = codes.get(args.path)!;
          const kept = Object.entries(catalogs[code]).filter(([key]) =>
            key.startsWith("browser."),
          );
          if (kept.length === 0)
            throw new Error(`Catalog ${code} has no browser.* key`);
          return {
            contents: `export const ${code} = ${JSON.stringify(Object.fromEntries(kept))};\n`,
            loader: "ts",
          };
        },
      );
    },
  };
}

// sha256 hex of `${outdir}.zip`.
export function distFingerprint(outdir: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(readFileSync(`${outdir}.zip`))
    .digest("hex");
}

const VERSION = /^\d+\.\d+\.\d+$/;
function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// Writes {version, sha256} of the build in outdir to recordPath. Throws with
// the reason when the version is lower, malformed, or equal with a new hash:
// a new build needs a new version (internal-docs/browser-extension.md).
export function recordFingerprint(
  outdir: string,
  recordPath: string,
): "written" | "unchanged" {
  const version = JSON.parse(
    readFileSync(resolve(outdir, "manifest.json"), "utf8"),
  ).version as string;
  if (!VERSION.test(version))
    throw new Error(`Version ${version} is not x.y.z`);
  const sha256 = distFingerprint(outdir);
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      version: string;
      sha256: string;
    };
    if (!VERSION.test(record.version))
      throw new Error(
        `Recorded version ${record.version} is not x.y.z; version ${version} not recorded`,
      );
    const order = compareVersions(version, record.version);
    if (order < 0)
      throw new Error(
        `Version ${version} is lower than the recorded version ${record.version}`,
      );
    if (order === 0) {
      if (sha256 === record.sha256) return "unchanged";
      throw new Error(
        `The build changed but version ${version} is already recorded. Raise the version in browser-extension/manifest.json`,
      );
    }
  }
  writeFileSync(
    recordPath,
    `${JSON.stringify({ version, sha256 }, null, 2)}\n`,
  );
  return "written";
}

if (import.meta.main) {
  await buildBrowserExtension();
  if (process.argv.includes("--record"))
    try {
      const outcome = recordFingerprint(
        resolve("browser-extension/dist"),
        resolve("browser-extension/dist-fingerprint.json"),
      );
      console.log(`Fingerprint record ${outcome}`);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
}
