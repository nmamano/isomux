import { describe, expect, it } from "bun:test";
import type { AppRecord } from "../shared/types.ts";
import {
  APP_PREVIEW_CACHE_TTL_MS,
  createAppPreviewCapture,
} from "./app-preview.ts";

const app: AppRecord = {
  name: "hello",
  hostLabel: "hello",
  hostGen: 1,
  port: 21000,
  command: "bun run start",
  cwd: "/tmp",
  dataDir: "/tmp/hello",
  userId: "u1",
  username: "Boss",
  createdBy: "Agent",
  createdAt: 1,
};

describe("app preview capture", () => {
  it("captures loopback at the card viewport, caches, and expires on demand", async () => {
    let now = 1_000;
    const calls: unknown[] = [];
    const capture = async (body: unknown) => {
      calls.push(body);
      return {
        ok: true as const,
        png: Buffer.from(`png-${calls.length}`),
        caption: "hello",
        filename: "hello.png",
      };
    };
    const previews = createAppPreviewCapture(capture, () => now);

    expect((await previews.capture(app)).ok).toBe(true);
    expect((await previews.capture(app)).ok).toBe(true);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:21000/",
        viewport: { width: 800, height: 500 },
        wait: 0,
      },
    ]);

    now += APP_PREVIEW_CACHE_TTL_MS;
    await previews.capture(app);
    expect(calls).toHaveLength(2);
  });

  it("coalesces concurrent requests and can invalidate a registration", async () => {
    let release!: () => void;
    let calls = 0;
    const capture = async () => {
      calls++;
      await new Promise<void>((resolve) => (release = resolve));
      return {
        ok: true as const,
        png: Buffer.from("png"),
        caption: "hello",
        filename: "hello.png",
      };
    };
    const previews = createAppPreviewCapture(capture);
    const first = previews.capture(app);
    const second = previews.capture(app);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);

    previews.invalidate(app.name);
    const third = previews.capture(app);
    release();
    await third;
    expect(calls).toBe(2);
  });

  it("keeps one capture slot free for agent preview cards", async () => {
    let release!: () => void;
    const capture = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return {
        ok: true as const,
        png: Buffer.from("png"),
        caption: "hello",
        filename: "hello.png",
      };
    };
    const previews = createAppPreviewCapture(capture);
    const first = previews.capture(app);
    const busy = await previews.capture({ ...app, name: "other" });
    expect(busy).toMatchObject({
      ok: false,
      status: 429,
      code: "capture_busy",
    });
    release();
    await first;
  });
});
