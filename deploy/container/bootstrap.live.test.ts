import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { createSetupHandler } from "./bootstrap.ts";

// Real Chrome through the container hand-off: the setup listener, then a gap
// in which the proxy answers 502 for longer than the measured boot (4.6-6.8 s
// on 2 CPUs, 2026-10-07), then the office.
test.skipIf(process.env.ISOMUX_TEST_LIVE !== "1")(
  "after the claim, the owner lands in the office without a reload through a slow boot",
  async () => {
    const key = "synthetic-setup-key-32-characters-long";
    const gapMs = 8000;
    let phase: "setup" | "gap" | "office" = "setup";
    const front = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        if (phase === "setup") return handler(req, "127.0.0.1");
        if (phase === "gap")
          return new Response("Bad Gateway", { status: 502 });
        return req.headers.get("cookie")?.includes("isomux_fixture=owner")
          ? new Response("<!doctype html><title>Fixture office</title>", {
              headers: { "Content-Type": "text/html" },
            })
          : new Response("unauthenticated", { status: 401 });
      },
    });
    // The listener calls it only after this line runs.
    const handler = createSetupHandler({
      key,
      hasOwner: () => false,
      claim: async () => ({
        ok: true,
        cookie: "isomux_fixture=owner; Path=/; HttpOnly",
      }),
      complete: () => {
        phase = "gap";
        setTimeout(() => (phase = "office"), gapMs);
      },
    });
    const browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      timeout: 10_000,
    });
    try {
      const page = await browser.newPage();
      const documents: number[] = [];
      page.on("response", (response) => {
        const request = response.request();
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        )
          documents.push(response.status());
      });
      await page.goto(`http://127.0.0.1:${front.port}/`);
      await page.locator('input[name="name"]').fill("Owner");
      await page.locator('input[name="key"]').fill(key);
      const submitted = Date.now();
      await page.locator("form button").click();
      await page.waitForFunction(
        () => document.title === "Fixture office",
        null,
        { timeout: gapMs + 10_000 },
      );
      expect(Date.now() - submitted).toBeGreaterThan(gapMs);
      // Setup form, the starting page, the office: never the proxy's 502.
      expect(documents).toEqual([200, 200, 200]);
    } finally {
      await browser.close();
      await front.stop(true);
    }
  },
  30_000,
);
