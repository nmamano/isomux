// Local Chrome probes for the DPR capture policy, 2026-09-16.
import { chromium } from "playwright-core";
import { launchOptions } from "../../server/browser-session";
function jpegSize(data: string) {
  const b = Buffer.from(data, "base64");
  let i = 2;
  while (i < b.length) {
    if (b[i++] !== 255) continue;
    const t = b[i++];
    if ([192, 193, 194].includes(t))
      return [b.readUInt16BE(i + 5), b.readUInt16BE(i + 3)];
    i += b.readUInt16BE(i);
  }
  throw Error("JPEG size missing");
}
for (const force of [false, true]) {
  const opts = launchOptions("/usr/bin/google-chrome");
  const browser = await chromium.launch({
    ...opts,
    args: [
      ...opts.args,
      "--headless=new",
      ...(force ? ["--force-device-scale-factor=2"] : []),
    ],
  });
  try {
    console.log(
      JSON.stringify({
        date: new Date().toISOString(),
        binary: "/usr/bin/google-chrome",
        version: browser.version(),
        newHeadless: true,
        forceDeviceScaleFactor: force,
      }),
    );
    const context = await browser.newContext({
      viewport: { width: 400, height: 680 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.setContent(
      '<style>body{margin:0;height:3000px}button{position:absolute;left:300px;top:500px;width:70px;height:40px;background:#f00;border:0}</style><button id="far" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">far</button>',
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 400,
      height: 680,
      deviceScaleFactor: 2,
      mobile: false,
    });
    let latest = "";
    let metadata = {};
    cdp.on("Page.screencastFrame", (e) => {
      latest = e.data;
      metadata = e.metadata;
      void cdp
        .send("Page.screencastFrameAck", { sessionId: e.sessionId })
        .catch(() => {});
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      maxWidth: 800,
      maxHeight: 1360,
      everyNthFrame: 1,
    });
    await page.locator("#far").click({ timeout: 2000 });
    await page.mouse.click(330, 520);
    await page.evaluate(() => scrollTo(0, 300));
    await Bun.sleep(150);
    const image = await context.newPage();
    const redBounds = await image.evaluate(async (data) => {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + data;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      let minX = Infinity,
        minY = Infinity,
        maxX = 0,
        maxY = 0;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (pixels[i] > 200 && pixels[i + 1] < 70 && pixels[i + 2] < 70) {
            minX = Math.min(x, minX);
            minY = Math.min(y, minY);
            maxX = Math.max(x, maxX);
            maxY = Math.max(y, maxY);
          }
        }
      return { minX, minY, maxX, maxY };
    }, latest);
    await image.close();
    console.log(
      JSON.stringify({
        force,
        frame: jpegSize(latest),
        metadata,
        redBounds,
        page: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollY,
          clicks: document.querySelector("button")!.getAttribute("data-clicks"),
        })),
      }),
    );
    await cdp.send("Page.stopScreencast");
    const agentPng = await page.screenshot({ scale: "css" });
    console.log(
      JSON.stringify({
        agentScreenshot: [agentPng.readUInt32BE(16), agentPng.readUInt32BE(20)],
        dprAfter: await page.evaluate(() => devicePixelRatio),
      }),
    );
    if (!force)
      for (const [width, height, dpr] of [
        [400, 680, 2],
        [390, 844, 3],
      ]) {
        await page.setViewportSize({ width, height });
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: dpr,
          mobile: false,
        });
        const times: number[] = [];
        let data = "";
        for (let i = 0; i < 25; i++) {
          const start = performance.now();
          data = (
            await cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: 50,
            })
          ).data;
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            capture: "Page.captureScreenshot",
            width,
            height,
            dpr,
            image: jpegSize(data),
            trials: times.length,
            medianMs: times[12],
            p95Ms: times[23],
            minMs: times[0],
            maxMs: times[24],
          }),
        );
      }
  } finally {
    await browser.close();
  }
}
