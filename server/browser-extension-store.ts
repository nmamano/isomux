import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./persistence";
import { browserCredentialHash } from "./browser-extension-bridge";

export type BrowserBackend = "headless" | "extension";
type BrowserRecord = { backend: BrowserBackend; hash?: string; origin?: string };
export const extensionOrigin = (value: string): boolean => /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const secret = () => randomBytes(32).toString("base64url");

// Only selected credentials survive restart. Pairing codes are single-use and
// live in memory, so a restarted office cannot redeem an old code.
export class BrowserExtensionStore {
  private records: Record<string, BrowserRecord> = Object.create(null);
  private codes = new Map<string, { member: string; expiresAt: number; replace: boolean }>();
  constructor(private path: string, private now = Date.now) {
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const [member, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as BrowserRecord;
      this.records[member] = {
        backend: r.backend === "extension" ? "extension" : "headless",
        ...(typeof r.hash === "string" && /^[a-f0-9]{64}$/.test(r.hash) && typeof r.origin === "string" && extensionOrigin(r.origin) ? { hash: r.hash, origin: r.origin } : {}),
      };
    }
  }
  record(member: string): Readonly<BrowserRecord> {
    return this.records[member] ?? { backend: "headless" };
  }
  private write(member: string, record: BrowserRecord): void {
    const next = { ...this.records, [member]: record };
    atomicWriteFileSync(this.path, JSON.stringify(next), 0o600);
    this.records = next;
  }
  select(member: string, backend: BrowserBackend): void {
    this.write(member, { ...this.record(member), backend });
  }
  pair(member: string, replace: boolean): { code: string; expiresAt: number } {
    if (this.record(member).hash && !replace) throw new Error("browser_already_paired");
    for (const [hash, code] of this.codes) {
      if (code.member === member || code.expiresAt <= this.now()) this.codes.delete(hash);
    }
    const code = secret();
    const expiresAt = this.now() + 5 * 60_000;
    this.codes.set(browserCredentialHash(code), { member, expiresAt, replace });
    return { code, expiresAt };
  }
  redeem(code: string, origin: string, memberExists: (member: string) => boolean): { member: string; credential: string } {
    if (!extensionOrigin(origin) || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("browser_pairing_refused");
    const hash = browserCredentialHash(code);
    const pending = this.codes.get(hash);
    if (!pending || pending.expiresAt <= this.now() || !memberExists(pending.member)) throw new Error("browser_pairing_refused");
    this.codes.delete(hash);
    if (this.record(pending.member).hash && !pending.replace) throw new Error("browser_pairing_refused");
    const credential = secret();
    this.write(pending.member, { ...this.record(pending.member), hash: browserCredentialHash(credential), origin });
    return { member: pending.member, credential };
  }
  memberForHash(hash: string, origin?: string): string | undefined {
    return Object.keys(this.records).find((member) => {
      const record = this.records[member];
      return record.hash === hash && (origin === undefined || record.origin === origin);
    });
  }
  revoke(member: string): void {
    this.write(member, { backend: this.record(member).backend });
    for (const [hash, code] of this.codes) if (code.member === member) this.codes.delete(hash);
  }
}
