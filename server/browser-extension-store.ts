import { randomBytes } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { atomicWriteFileSync } from "./persistence";
import { browserCredentialHash } from "./browser-extension-bridge";
import { browserDisplay } from "./browser-extension-display";

// One paired Chrome (a computer or a Chrome profile). `id` is a non-secret
// handle for settings; the credential itself is never saved.
export type PairedBrowser = {
  id: string;
  name: string;
  hash: string;
  origin: string;
  pairedAt: number | null;
};
export const BROWSER_NAME_MAX = 40;
export const extensionOrigin = (value: string): boolean =>
  /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const secret = () => randomBytes(32).toString("base64url");
const browserId = () => randomBytes(9).toString("base64url");
const validHash = (hash: unknown): hash is string =>
  typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);

// Display sanitization, then trim. Undefined means the name is too long.
export function browserName(name: string): string | undefined {
  const clean = browserDisplay("", name.slice(0, 200)).name.trim();
  return clean.length > BROWSER_NAME_MAX ? undefined : clean;
}

// Only selected credentials survive restart. Pairing codes are single-use and
// live in memory, so a restarted office cannot redeem an old code.
export class BrowserExtensionStore {
  private records: Record<string, PairedBrowser[]> = Object.create(null);
  private codes = new Map<
    string,
    { member: string; expiresAt: number; name: string }
  >();
  private preserveSource = false;
  constructor(
    private path: string,
    private now = Date.now,
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error();
      let members: object = raw;
      const version = "version" in raw ? raw.version : undefined;
      if (version !== undefined) {
        const envelope = raw as {
          selectionRequired?: unknown;
          members?: unknown;
        };
        if (
          (version !== 1 && version !== 2) ||
          (version === 1 && typeof envelope.selectionRequired !== "boolean") ||
          !envelope.members ||
          typeof envelope.members !== "object" ||
          Array.isArray(envelope.members)
        )
          throw new Error();
        members = envelope.members;
      }
      for (const [member, entry] of Object.entries(members)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          this.preserveSource = true;
          continue;
        }
        if (version === 2) {
          const browsers: unknown = (entry as { browsers?: unknown }).browsers;
          if (!Array.isArray(browsers)) {
            this.preserveSource = true;
            continue;
          }
          const kept = browsers.filter(
            (b): b is PairedBrowser =>
              !!b &&
              typeof b === "object" &&
              typeof b.id === "string" &&
              /^[A-Za-z0-9_-]{1,64}$/.test(b.id) &&
              typeof b.name === "string" &&
              browserName(b.name) !== undefined &&
              validHash(b.hash) &&
              typeof b.origin === "string" &&
              extensionOrigin(b.origin) &&
              (b.pairedAt === null || Number.isFinite(b.pairedAt)),
          );
          if (kept.length !== browsers.length) this.preserveSource = true;
          if (kept.length)
            this.records[member] = kept.map((b) => ({
              id: b.id,
              name: browserName(b.name)!,
              hash: b.hash,
              origin: b.origin,
              pairedAt: b.pairedAt,
            }));
          continue;
        }
        // Version 1 and the legacy flat map hold one credential per member.
        // A wrapped null backend never kept a credential. Old headless
        // choices keep a valid credential as the member's first browser.
        const r = entry as {
          backend?: unknown;
          hash?: unknown;
          origin?: unknown;
        };
        if (version === 1 && r.backend === null) continue;
        if (r.backend !== "headless" && r.backend !== "extension") {
          this.preserveSource = true;
          continue;
        }
        if (
          validHash(r.hash) &&
          typeof r.origin === "string" &&
          extensionOrigin(r.origin)
        )
          this.records[member] = [
            {
              id: browserId(),
              name: "Browser 1",
              hash: r.hash,
              origin: r.origin,
              pairedAt: null,
            },
          ];
      }
    } catch (error) {
      // Only a genuinely absent file gets the migration default. Never log
      // browser state or error content. Invalid state requires fresh pairing.
      if ((error as { code?: string }).code === "ENOENT") return;
      this.records = Object.create(null);
      this.preserveSource = true;
    }
  }
  browsers(member: string): readonly Readonly<PairedBrowser>[] {
    return this.records[member] ?? [];
  }
  paired(member: string): boolean {
    return this.browsers(member).length > 0;
  }
  private write(member: string, browsers: PairedBrowser[]): void {
    const next = { ...this.records, [member]: browsers };
    if (!browsers.length) delete next[member];
    let preserved: string | undefined;
    if (this.preserveSource) {
      // Rename also preserves an unreadable directory at the state path.
      preserved = `${this.path}.unavailable-${secret()}`;
      renameSync(this.path, preserved);
    }
    try {
      atomicWriteFileSync(
        this.path,
        JSON.stringify({
          version: 2,
          members: Object.fromEntries(
            Object.entries(next).map(([m, list]) => [m, { browsers: list }]),
          ),
        }),
        0o600,
      );
    } catch (error) {
      // A failed repair must not become an absent-file migration on restart.
      if (preserved) renameSync(preserved, this.path);
      throw error;
    }
    this.preserveSource = false;
    this.records = next;
  }
  // Every code adds a browser. One pending code per member: a new code voids
  // the previous one. An empty name gets the smallest unused "Browser N".
  pair(member: string, name = ""): { code: string; expiresAt: number } {
    const clean = browserName(name);
    if (clean === undefined) throw new Error("browser_name_too_long");
    for (const [hash, code] of this.codes) {
      if (code.member === member || code.expiresAt <= this.now())
        this.codes.delete(hash);
    }
    const code = secret();
    const expiresAt = this.now() + 5 * 60_000;
    this.codes.set(browserCredentialHash(code), {
      member,
      expiresAt,
      name: clean,
    });
    return { code, expiresAt };
  }
  private defaultName(member: string): string {
    const taken = new Set(this.browsers(member).map((b) => b.name));
    let n = 1;
    while (taken.has(`Browser ${n}`)) n++;
    return `Browser ${n}`;
  }
  redeem(
    code: string,
    origin: string,
    memberExists: (member: string) => boolean,
  ): { member: string; browser: string; credential: string } {
    if (!extensionOrigin(origin) || !/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new Error("browser_pairing_refused");
    const hash = browserCredentialHash(code);
    const pending = this.codes.get(hash);
    if (
      !pending ||
      pending.expiresAt <= this.now() ||
      !memberExists(pending.member)
    )
      throw new Error("browser_pairing_refused");
    this.codes.delete(hash);
    const credential = secret();
    const browser: PairedBrowser = {
      id: browserId(),
      name: pending.name || this.defaultName(pending.member),
      hash: browserCredentialHash(credential),
      origin,
      pairedAt: this.now(),
    };
    this.write(pending.member, [...this.browsers(pending.member), browser]);
    return { member: pending.member, browser: browser.id, credential };
  }
  browserForHash(
    hash: string,
    origin?: string,
  ): { member: string; browser: Readonly<PairedBrowser> } | undefined {
    for (const member of Object.keys(this.records)) {
      const browser = this.records[member].find(
        (b) => b.hash === hash && (origin === undefined || b.origin === origin),
      );
      if (browser) return { member, browser };
    }
    return undefined;
  }
  memberForHash(hash: string, origin?: string): string | undefined {
    return this.browserForHash(hash, origin)?.member;
  }
  // Revokes one browser of this member and returns its credential hash. Ids
  // of other members are not visible here. A pending code stays valid.
  revokeBrowser(member: string, id: string): string | undefined {
    const browser = this.browsers(member).find((b) => b.id === id);
    if (!browser) return undefined;
    this.write(
      member,
      this.browsers(member).filter((b) => b !== browser),
    );
    return browser.hash;
  }
  // Revokes every browser of this member and its pending code.
  revoke(member: string): void {
    this.write(member, []);
    for (const [hash, code] of this.codes)
      if (code.member === member) this.codes.delete(hash);
  }
}
