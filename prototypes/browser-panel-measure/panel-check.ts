// Real production panel over a loopback WebSocket; no office state or accounts.
import { chromium } from "playwright-core";
import { BrowserPool, launchOptions } from "../../server/browser-session.ts";
import { encodeBrowserFrame } from "../../shared/browser-frame.ts";
import { BrowserFrameSender } from "../../server/browser-frame-sender.ts";
import { mkdtempSync } from "node:fs";
import { CSS } from "../../ui/styles.ts";
const dir =
  process.env.PANEL_EVIDENCE_DIR ||
  "prototypes/browser-panel-measure/evidence/";
const pool = new BrowserPool({ stateRoot: mkdtempSync(dir + "state-") });
const build = await Bun.build({
  entrypoints: ["prototypes/browser-panel-measure/panel.tsx"],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!build.success) throw Error("build");
const js = await build.outputs[0].text();
let stop = () => {};
const frames: any[] = [];
const inputs: any[] = [];
let casts = 0,
  stills = 0,
  barriers = 0;
const senders = new Map<any, BrowserFrameSender>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, s) {
    const path = new URL(req.url).pathname;
    if (path === "/ws") {
      s.upgrade(req);
      return;
    }
    if (path === "/fixture")
      return new Response(
        "<style>body{margin:0;font:16px sans-serif}button{position:fixed;left:110px;top:230px;width:100px;height:40px}main{height:4000px}</style><main><h1>Retina text</h1><button onclick=\"this.textContent='clicked'\">target</button></main>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/panel.js")
      return new Response(js, {
        headers: { "Content-Type": "text/javascript" },
      });
    return new Response(
      "<style>" +
        CSS.split("\n")
          .filter((line) => !line.trim().startsWith("@import"))
          .join("\n") +
        "</style><style>body{margin:0}#root{width:400px;height:800px}</style><div id=root></div><script type=module src=/panel.js></script>",
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    open(ws) {
      senders.set(
        ws,
        new BrowserFrameSender(
          ws,
          () => true,
          () => pool.refreshCapture("bench"),
        ),
      );
      ws.send(JSON.stringify({ type: "full_state" }));
    },
    drain(ws) {
      senders.get(ws)?.flush();
    },
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.type === "browser_watch" && m.watching) {
        stop();
        stop = pool.watch(
          "bench",
          (f) => {
            ws.send(
              JSON.stringify({
                type: "browser_status",
                agentId: "bench",
                ...pool.status("bench"),
              }),
            );
            if (f) {
              frames.push({ ms: performance.now(), ...f });
              senders.get(ws)!.send(
                encodeBrowserFrame({
                  agentId: "bench",
                  generation: m.generation,
                  width: f.width,
                  height: f.height,
                  jpeg: Buffer.from(f.data, "base64"),
                }),
              );
            }
          },
          () => true,
          m,
          () => senders.get(ws)!.pressure.level,
          () => senders.get(ws)!.canCapture(),
        );
      }
      if (m.type === "browser_input" && m.input.kind === "navigate")
        ws.send(
          JSON.stringify({
            type: "browser_status",
            agentId: "bench",
            ...pool.status("bench"),
            busy: false,
          }),
        );
      if (m.type === "browser_input" && m.input.kind !== "navigate") {
        inputs.push(m.input);
        void pool.humanInput("bench", m.input);
      }
    },
    close(ws) {
      senders.get(ws)?.stop();
    },
  },
});
const browser = await chromium.launch(launchOptions("/usr/bin/google-chrome"));
const viewer = await browser.newPage({
  viewport: { width: 700, height: 1000 },
  deviceScaleFactor: Number(process.env.DPR || 2),
});
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
  throw Error("jpeg");
}
try {
  await pool.run("bench", {
    action: "goto",
    url: `http://127.0.0.1:${server.port}/fixture`,
  });
  const s = (pool as any).sessions.get("bench");
  const original = s.context.newCDPSession.bind(s.context);
  s.context.newCDPSession = async (...args: any[]) => {
    const c = await original(...args),
      send = c.send.bind(c);
    c.send = async (method: string, ...rest: any[]) => {
      if (method === "Page.startScreencast") casts++;
      if (method === "Page.captureScreenshot") stills++;
      if (method === "Runtime.evaluate") barriers++;
      return send(method, ...rest);
    };
    return c;
  };
  await viewer.goto(`http://127.0.0.1:${server.port}`);
  await viewer.waitForSelector("canvas");
  await Bun.sleep(800);
  async function record(phase: string) {
    await Bun.sleep(250);
    const f = frames.at(-1);
    const info = await s.page.evaluate(() => ({
      dpr: devicePixelRatio,
      w: innerWidth,
      h: innerHeight,
      scrollY,
      button: document.querySelector("button")?.textContent,
    }));
    const shot = await pool.run("bench", { action: "screenshot" });
    if (!shot.ok || !shot.png) throw Error("agent shot");
    await Bun.write(dir + "panel-" + phase + ".png", shot.png);
    console.log(
      JSON.stringify({
        date: new Date().toISOString(),
        phase,
        info,
        metadata: [f.width, f.height],
        delivered: jpegSize(f.data),
        bytes: Buffer.from(f.data, "base64").length,
        agentPng: [shot.png.readUInt32BE(16), shot.png.readUInt32BE(20)],
        afterAgentDpr: await s.page.evaluate(() => devicePixelRatio),
        casts,
        stills,
      }),
    );
  }
  async function click() {
    const box = await viewer.locator("canvas").boundingBox();
    if (!box) throw Error("canvas");
    const v = s.page.viewportSize();
    const scale = Math.min(box.width / v.width, box.height / v.height);
    await viewer.mouse.click(
      box.x + (box.width - v.width * scale) / 2 + 150 * scale,
      box.y + (box.height - v.height * scale) / 2 + 250 * scale,
    );
    await Bun.sleep(250);
    if (
      (await s.page.evaluate(
        () => document.querySelector("button")?.textContent,
      )) !== "clicked"
    )
      throw Error("misdirected click");
  }
  await click();
  await record("start");
  await viewer.screenshot({ path: dir + "panel-viewer.png" });
  await viewer.evaluate(
    () => (document.getElementById("root")!.style.width = "410px"),
  );
  await Bun.sleep(500);
  await record("resize");
  await s.page.goto(`http://127.0.0.1:${server.port}/fixture`);
  await Bun.sleep(300);
  await click();
  await record("navigation");
  await s.page.evaluate(() => window.scrollTo(0, 600));
  await click();
  await record("scroll");
  const scrollBefore = await s.page.evaluate(() => scrollY);
  await pool.humanInput("bench", {
    kind: "mouse",
    event: "mouseWheel",
    x: 200,
    y: 300,
    deltaX: 0,
    deltaY: 100,
  });
  await Bun.sleep(350);
  const delta = (await s.page.evaluate(() => scrollY)) - scrollBefore;
  console.log("wheel", JSON.stringify({ delta }));
  if (delta !== 100) throw Error("wheel moved wrong CSS distance");
  await Bun.sleep(200);
  const n = stills,
    nb = barriers;
  for (let i = 0; i < 50; i++) {
    await pool.humanInput("bench", {
      kind: "mouse",
      event: "mouseMoved",
      x: 50 + i,
      y: 100,
    });
    await Bun.sleep(5);
  }
  await Bun.sleep(450);
  console.log(
    "drag",
    JSON.stringify({
      moves: 50,
      stills: stills - n,
      inputPaintBarriers: barriers - nb,
    }),
  );
  if (stills === n) throw Error("drag delivered no capture");
  const ncasts = casts;
  const low = pool.watch(
    "bench",
    () => {},
    () => false,
    { deviceScaleFactor: 1 },
  );
  await Bun.sleep(150);
  console.log("lowerJoin", JSON.stringify({ restarts: casts - ncasts }));
  stop();
  await Bun.sleep(250);
  console.log(
    "highLeaves",
    JSON.stringify({
      dpr: await s.page.evaluate(() => devicePixelRatio),
      casts,
    }),
  );
  low();
  await Bun.sleep(150);
  console.log(
    "lastLeaves",
    JSON.stringify({
      dpr: await s.page.evaluate(() => devicePixelRatio),
      screencast: !!s.screencast,
    }),
  );
  console.log(
    "pointerInputs",
    JSON.stringify(inputs.filter((i) => i.kind === "mouse")),
  );
} finally {
  stop();
  for (const s of senders.values()) s.stop();
  await browser.close();
  await pool.shutdown();
  server.stop(true);
}
