import { chromium } from "playwright-core";
import { launchOptions } from "../../server/browser-session";
const fixture = `<style>body{margin:0;font:18px sans-serif}img,canvas{display:block}button{position:absolute;left:280px;top:500px;width:100px;height:40px}</style><p>Sharp text ABC 012345</p><img width=160 height=60 src=/one.svg srcset="/one.svg 1x, /two.svg 2x"><canvas style="width:160px;height:60px"></canvas><button onclick="window.hits++">target</button><script>window.hits=0;const c=document.querySelector('canvas');c.width=160*devicePixelRatio;c.height=60*devicePixelRatio;const x=c.getContext('2d');x.scale(devicePixelRatio,devicePixelRatio);x.font='18px sans-serif';x.fillText('Canvas DPR '+devicePixelRatio,0,25);for(let i=0;i<160;i+=3){x.fillRect(i,35,1,20)};</script>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    return p.endsWith(".svg")
      ? new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="${p === "/one.svg" ? "#faa" : "#afa"}"/><text x="5" y="30" font-size="20">${p === "/one.svg" ? "1x image" : "2x image"}</text></svg>`,
          { headers: { "Content-Type": "image/svg+xml" } },
        )
      : new Response(fixture, { headers: { "Content-Type": "text/html" } });
  },
});
const browser = await chromium.launch(launchOptions("/usr/bin/google-chrome"));
try {
  for (const dsf of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 400, height: 680 },
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (dsf > 1)
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 400,
        height: 680,
        deviceScaleFactor: dsf,
        mobile: false,
      });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page
      .locator("img")
      .evaluate(async (img: HTMLImageElement) => await img.decode());
    const capture = () =>
      cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 400, height: 680, scale: 2 / dsf },
      });
    const shot = await capture();
    const png = Buffer.from(shot.data, "base64");
    await Bun.write(
      `prototypes/browser-panel-measure/evidence/clip-dsf-${dsf}.png`,
      png,
    );
    let run = true,
      shots = 0;
    const capturing = (async () => {
      while (run) {
        await capture();
        shots++;
      }
    })();
    let clickErrors = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await page.locator("button").click({ timeout: 2000 });
      } catch {
        clickErrors++;
      }
      await page.mouse.click(330, 520);
    }
    run = false;
    await capturing;
    console.log(
      JSON.stringify({
        date: new Date().toISOString(),
        dsf,
        clipScale: 2 / dsf,
        image: [png.readUInt32BE(16), png.readUInt32BE(20)],
        shots,
        clickErrors,
        expectedHits: 40,
        page: await page.evaluate(() => ({
          dpr: devicePixelRatio,
          w: innerWidth,
          h: innerHeight,
          hits: (window as any).hits,
          src: document.querySelector("img")!.currentSrc.split("/").at(-1),
          canvas: [
            document.querySelector("canvas")!.width,
            document.querySelector("canvas")!.height,
          ],
        })),
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
