// Local fixture only. Run under a 2 GiB systemd scope from the worktree root.
import { BrowserPool } from "../../server/browser-session.ts";
import { mkdtempSync } from "node:fs";
const label = process.env.LABEL || "before";
const dir = "prototypes/browser-panel-measure/evidence/";
const pool = new BrowserPool({ stateRoot: mkdtempSync(dir + "state-") });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(
      "<style>body{font:16px sans-serif}button{position:absolute;left:110px;top:230px;width:100px;height:40px}</style><h1>DPR fixture</h1><p>Small text at CSS resolution.</p><button onclick=\"this.textContent='clicked'\">Click here</button>",
      { headers: { "Content-Type": "text/html" } },
    ),
});
function jpegSize(data: string) {
  const b = Buffer.from(data, "base64");
  let i = 2;
  while (i < b.length) {
    if (b[i++] !== 255) continue;
    const tag = b[i++];
    if ([192, 193, 194].includes(tag))
      return [b.readUInt16BE(i + 5), b.readUInt16BE(i + 3)];
    i += b.readUInt16BE(i);
  }
  throw new Error("JPEG size missing");
}
const rawFrames: any[] = [];
let frames: any[] = [];
let stop: () => void = () => {};
try {
  await pool.run("dpr", {
    action: "goto",
    url: `http://127.0.0.1:${server.port}`,
    viewport: { width: 390, height: 700 },
  });
  const session = (pool as any).sessions.get("dpr");
  stop = pool.watch(
    "dpr",
    (f) => {
      if (f) frames.push(f);
    },
    () => true,
    { maxWidth: 780, maxHeight: 1400, deviceScaleFactor: 2 } as any,
  );
  async function record(phase: string) {
    await Bun.sleep(400);
    const f = frames.at(-1);
    if (!f) throw new Error("No frame");
    const pageDpr = await session.page.evaluate(() => devicePixelRatio);
    const raw = rawFrames.at(-1);
    const shot = await pool.run("dpr", { action: "screenshot" });
    if (!shot.ok || !shot.png) throw new Error("Screenshot failed");
    await Bun.write(dir + label + "-" + phase + ".png", shot.png);
    console.log(
      JSON.stringify({
        date: new Date().toISOString(),
        label,
        phase,
        css: session.page.viewportSize(),
        pageDpr,
        raw: raw ? { size: jpegSize(raw.data), metadata: raw.metadata } : null,
        requestedDpr: 2,
        delivered: jpegSize(f.data),
        metadata: [f.width, f.height],
        agentPng: [shot.png.readUInt32BE(16), shot.png.readUInt32BE(20)],
        frames: frames.length,
      }),
    );
  }
  await record("start");
  frames = [];
  await pool.humanInput("dpr", { kind: "viewport", width: 400, height: 680 });
  await record("resize");
  if (label === "before") {
    // Measurement-only CDP candidate: apply both the render DPR and physical bounds.
    const cdp = session.screencast;
    frames = [];
    cdp.on("Page.screencastFrame", (event: any) => rawFrames.push(event));
    await cdp.send("Page.stopScreencast");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 400,
      height: 680,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      maxWidth: 780,
      maxHeight: 1400,
      everyNthFrame: 1,
    });
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(100);
      await session.page.evaluate(
        (i) => (document.body.style.background = i % 2 ? "#eee" : "#fff"),
        i,
      );
    }
    console.log(
      "probeFrames",
      JSON.stringify(
        rawFrames.map((f) => ({
          size: jpegSize(f.data),
          metadata: f.metadata,
        })),
      ),
    );
    const rawShot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
    });
    console.log("rawScreenshot", jpegSize(rawShot.data));
    await record("cdp-probe");
  }
} finally {
  stop();
  await pool.shutdown();
  server.stop(true);
}
