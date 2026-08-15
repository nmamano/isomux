import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareDns, type TxtRecord } from "./cloudflare-dns.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function fake(initial: TxtRecord[] = []) {
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
      return Response.json({ success: true, result: records });
    }
    if (method === "POST") {
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
