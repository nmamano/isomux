import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface TxtRecord {
  id: string;
  name: string;
  content: string;
}

export interface ARecord {
  id: string;
  name: string;
  content: string;
  proxied: boolean;
  type?: "A";
  ttl?: number;
}

export interface OfficeDnsWriter {
  officeARecords(host: string): Promise<ARecord[]>;
  replaceOfficeARecords(host: string, ipv4: string): Promise<void>;
  removeOfficeARecords(host: string): Promise<boolean>;
}

interface CloudflareAnswer<T> {
  success: boolean;
  result: T;
  errors?: { message?: string }[];
}

export interface CloudflareDnsOptions {
  baseUrl: string;
  zoneId: string;
  apiToken: string;
  intentsDir: string;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

interface Intent {
  name: string;
  content: string;
  recordIds: string[];
  createdAt: number;
}

function intentName(name: string, content: string): string {
  return `${createHash("sha256").update(`${name}\0${content}`).digest("hex")}.json`;
}

function normalName(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function writeIntent(dir: string, intent: Intent): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = join(dir, intentName(intent.name, intent.content));
  const temp = `${final}.${process.pid}.partial`;
  writeFileSync(temp, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, final);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return final;
}

function readIntent(file: string): Intent | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Intent;
    if (
      typeof value.name !== "string" ||
      typeof value.content !== "string" ||
      !Array.isArray(value.recordIds) ||
      !Number.isSafeInteger(value.createdAt)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export class CloudflareDns {
  private readonly request: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly now: () => number;

  constructor(private readonly opts: CloudflareDnsOptions) {
    this.request = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(
      `${this.opts.baseUrl.replace(/\/$/, "")}/zones/${encodeURIComponent(this.opts.zoneId)}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.opts.apiToken}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      },
    );
    let answer: CloudflareAnswer<T>;
    try {
      answer = (await response.json()) as CloudflareAnswer<T>;
    } catch {
      throw new Error(`Cloudflare DNS returned HTTP ${response.status}`);
    }
    if (!response.ok || !answer.success) {
      throw new Error(
        answer.errors?.[0]?.message ??
          `Cloudflare DNS returned HTTP ${response.status}`,
      );
    }
    return answer.result;
  }

  async listExact(name: string, content: string): Promise<TxtRecord[]> {
    const clean = normalName(name);
    const records = await this.api<TxtRecord[]>(
      `/dns_records?type=TXT&name=${encodeURIComponent(clean)}&per_page=100`,
    );
    return records.filter(
      (record) => record.name === clean && record.content === content,
    );
  }

  private officeNames(host: string): [string, string] {
    const clean = normalName(host).toLowerCase();
    if (!clean || clean.startsWith("*.") || clean.includes("/")) {
      throw new Error(
        `refusing unsafe office DNS name ${JSON.stringify(host)}`,
      );
    }
    return [clean, `*.${clean}`];
  }

  private async listA(name: string): Promise<ARecord[]> {
    const records = await this.api<ARecord[]>(
      `/dns_records?type=A&name=${encodeURIComponent(name)}&per_page=100`,
    );
    return records.filter(
      (record) => record.name === name && record.content.length > 0,
    );
  }

  async officeARecords(host: string): Promise<ARecord[]> {
    const names = this.officeNames(host);
    return (await Promise.all(names.map((name) => this.listA(name)))).flat();
  }

  private officeARecordsMatch(
    names: readonly string[],
    records: readonly ARecord[],
    ipv4: string,
  ): boolean {
    return (
      records.length === 2 &&
      names.every((name) =>
        records.some(
          (record) =>
            record.name === name &&
            record.content === ipv4 &&
            record.proxied === false,
        ),
      )
    );
  }

  async replaceOfficeARecords(host: string, ipv4: string): Promise<void> {
    const names = this.officeNames(host);
    const existing = await this.officeARecords(host);
    if (this.officeARecordsMatch(names, existing, ipv4)) {
      return;
    }
    await this.api("/dns_records/batch", {
      method: "POST",
      body: JSON.stringify({
        ...(existing.length > 0
          ? { deletes: existing.map((record) => ({ id: record.id })) }
          : {}),
        posts: names.map((name) => ({
          type: "A",
          name,
          content: ipv4,
          ttl: 120,
          proxied: false,
        })),
      }),
    });
    if (
      !this.officeARecordsMatch(names, await this.officeARecords(host), ipv4)
    ) {
      throw new Error(
        `Cloudflare did not converge office A records for ${host}`,
      );
    }
  }

  async removeOfficeARecords(host: string): Promise<boolean> {
    const existing = await this.officeARecords(host);
    if (existing.length > 0) {
      await this.api("/dns_records/batch", {
        method: "POST",
        body: JSON.stringify({
          deletes: existing.map((record) => ({ id: record.id })),
        }),
      });
    }
    return (await this.officeARecords(host)).length === 0;
  }

  /**
   * Persist intent before the first write. A retry adopts every exact-content
   * sibling created by an earlier crash and never touches a different value at
   * the same challenge name.
   */
  async present(name: string, content: string): Promise<string[]> {
    const clean = normalName(name);
    const intent: Intent = {
      name: clean,
      content,
      recordIds: [],
      createdAt: this.now(),
    };
    const file = writeIntent(this.opts.intentsDir, intent);
    const existing = await this.listExact(clean, content);
    if (existing.length > 0) {
      intent.recordIds = existing.map((record) => record.id).sort();
      writeIntent(this.opts.intentsDir, intent);
      return intent.recordIds;
    }
    const made = await this.api<TxtRecord>("/dns_records", {
      method: "POST",
      body: JSON.stringify({ type: "TXT", name: clean, content, ttl: 120 }),
    });
    intent.recordIds = [made.id];
    writeIntent(this.opts.intentsDir, intent);
    // `file` is intentionally retained until cleanup. It is the crash journal.
    void file;
    return intent.recordIds;
  }

  async cleanup(name: string, content: string): Promise<void> {
    const clean = normalName(name);
    const file = join(this.opts.intentsDir, intentName(clean, content));
    // Re-list instead of trusting only persisted ids. This catches a create
    // whose response landed after the process died and duplicate exact-content
    // siblings from an ambiguous retry.
    const records = await this.listExact(clean, content);
    for (const record of records) {
      await this.api(`/dns_records/${encodeURIComponent(record.id)}`, {
        method: "DELETE",
      });
    }
    rmSync(file, { force: true });
  }

  async reapOrphans(olderThanMs: number): Promise<number> {
    let removed = 0;
    let names;
    try {
      names = readdirSync(this.opts.intentsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const name of names) {
      if (!name.isFile() || !name.name.endsWith(".json")) continue;
      const intent = readIntent(join(this.opts.intentsDir, name.name));
      if (!intent || this.now() - intent.createdAt < olderThanMs) continue;
      await this.cleanup(intent.name, intent.content);
      removed++;
    }
    return removed;
  }
}
