import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflareDns,
  type ARecord,
  type TxtRecord,
} from "./cloudflare-dns.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function fake(initial: (TxtRecord | ARecord)[] = []) {
  const records = [...initial];
  let next = 1;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const request = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body: rawBody && JSON.parse(rawBody) });
    if (method === "GET") {
      const parsed = new URL(url);
      const name = parsed.searchParams.get("name");
      const type = parsed.searchParams.get("type");
      return Response.json({
        success: true,
        result: records.filter(
          (record) =>
            (!name || record.name === name) &&
            (!type || ("proxied" in record ? type === "A" : type === "TXT")),
        ),
      });
    }
    if (method === "POST") {
      if (url.endsWith("/dns_records/batch")) {
        const body = JSON.parse(rawBody ?? "") as {
          deletes?: { id: string }[];
          posts?: Omit<ARecord, "id">[];
        };
        for (const deleted of body.deletes ?? []) {
          const index = records.findIndex((record) => record.id === deleted.id);
          if (index >= 0) records.splice(index, 1);
        }
        for (const posted of body.posts ?? []) {
          records.push({ id: `new-${next++}`, ...posted });
        }
        return Response.json({ success: true, result: {} });
      }
      const body = JSON.parse(rawBody ?? "") as {
        name: string;
        content: string;
      };
      const made = {
        id: `new-${next++}`,
        name: body.name,
        content: body.content,
      };
      records.push(made);
      return Response.json({ success: true, result: made });
    }
    const id = decodeURIComponent(url.split("/").pop()!);
    const index = records.findIndex((record) => record.id === id);
    if (index >= 0) records.splice(index, 1);
    return Response.json({ success: true, result: { id } });
  };
  dir = mkdtempSync(join(tmpdir(), "isomux-cf-intents-"));
  const dns = new CloudflareDns({
    baseUrl: "http://127.0.0.1:9999/client/v4",
    zoneId: "fake-zone",
    apiToken: "fake",
    intentsDir: dir,
    fetch: request,
    now: () => 10_000,
  });
  return { dns, records, calls };
}

describe("crash-safe Cloudflare TXT ownership", () => {
  test("adopts exact content instead of creating a duplicate", async () => {
    const { dns, records, calls } = fake([
      { id: "ours", name: "_acme.example", content: "value-a" },
      { id: "sibling", name: "_acme.example", content: "value-b" },
    ]);
    expect(await dns.present("_acme.example.", "value-a")).toEqual(["ours"]);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await dns.cleanup("_acme.example", "value-a");
    expect(records).toEqual([
      { id: "sibling", name: "_acme.example", content: "value-b" },
    ]);
  });

  test("an ambiguous duplicate retry deletes every exact sibling only", async () => {
    const { dns, records } = fake([
      { id: "a", name: "_acme.example", content: "same" },
      { id: "b", name: "_acme.example", content: "same" },
      { id: "keep", name: "_acme.example", content: "other" },
    ]);
    await dns.present("_acme.example", "same");
    await dns.cleanup("_acme.example", "same");
    expect(records.map((record) => record.id)).toEqual(["keep"]);
  });
});

describe("permanent office A records", () => {
  test("replaces both exact record sets together and explicitly disables proxying", async () => {
    const { dns, records, calls } = fake([
      {
        id: "old-office",
        name: "office.example",
        content: "192.0.2.1",
        proxied: false,
      },
      {
        id: "old-wild",
        name: "*.office.example",
        content: "192.0.2.2",
        proxied: true,
      },
      { id: "aaaa", name: "office.example", content: "2001:db8::1" },
    ]);
    await dns.replaceOfficeARecords("office.example", "192.0.2.9");
    expect(records).toContainEqual({
      id: "aaaa",
      name: "office.example",
      content: "2001:db8::1",
    });
    expect(records.filter((record) => "proxied" in record)).toEqual([
      {
        id: "new-1",
        name: "office.example",
        content: "192.0.2.9",
        ttl: 120,
        proxied: false,
        type: "A",
      },
      {
        id: "new-2",
        name: "*.office.example",
        content: "192.0.2.9",
        ttl: 120,
        proxied: false,
        type: "A",
      },
    ]);
    const batch = calls.find((call) => call.url.endsWith("/dns_records/batch"));
    expect(batch?.body).toMatchObject({
      posts: [
        { name: "office.example", proxied: false },
        { name: "*.office.example", proxied: false },
      ],
    });
  });

  test("removes only office A records and proves their authoritative absence", async () => {
    const { dns, records } = fake([
      {
        id: "office",
        name: "office.example",
        content: "192.0.2.9",
        proxied: false,
      },
      {
        id: "wild",
        name: "*.office.example",
        content: "192.0.2.9",
        proxied: false,
      },
      { id: "aaaa", name: "office.example", content: "2001:db8::1" },
    ]);
    expect(await dns.removeOfficeARecords("office.example")).toBe(true);
    expect(records).toEqual([
      { id: "aaaa", name: "office.example", content: "2001:db8::1" },
    ]);
  });

  test("normalizes office names and omits an empty delete batch", async () => {
    const { dns, calls } = fake();
    await dns.replaceOfficeARecords("Office.Example.", "192.0.2.9");
    const batch = calls.find((call) => call.url.endsWith("/dns_records/batch"));
    expect(batch?.body).toEqual({
      posts: [
        {
          type: "A",
          name: "office.example",
          content: "192.0.2.9",
          ttl: 120,
          proxied: false,
        },
        {
          type: "A",
          name: "*.office.example",
          content: "192.0.2.9",
          ttl: 120,
          proxied: false,
        },
      ],
    });
  });

  test("refuses an unsafe office name before any request", async () => {
    const { dns, calls } = fake();
    expect(dns.removeOfficeARecords("*.other.example")).rejects.toThrow(
      /unsafe office DNS name/,
    );
    expect(calls).toHaveLength(0);
  });
});
