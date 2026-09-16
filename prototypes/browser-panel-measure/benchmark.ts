// Run inside a 2 GiB systemd scope. No office state or authenticated page is used.
import { chromium } from "playwright-core";

import { readFileSync, mkdtempSync } from "node:fs";
import { createSocket } from "node:dgram";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const evidence = root + "/prototypes/browser-panel-measure/evidence/";
const dpr = Number(process.env.DPR || 1);
const mode = process.env.MODE || "jpeg";
const width = Number(process.env.WIDTH || 1280);
const pageKind = process.env.PAGE || "busy";
const videoMode = mode === "h264" || mode === "h264rtp";
const { encodeBrowserFrame } = await import(root + "/shared/browser-frame.ts");
const { BrowserFrameSender } = await import(
  root + "/server/browser-frame-sender.ts"
);
const { BrowserPool, launchOptions } = await import(
  root + "/server/browser-session.ts"
);
const bundle = await Bun.build({
  entrypoints: [root + "/prototypes/browser-panel-measure/panel.tsx"],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!bundle.success) throw new Error(String(bundle.logs));
const js = await bundle.outputs[0].text();
const display = ":" + String(200 + (process.pid % 10000));
let xvfb: any, encoder: any;
let rtpSocket: ReturnType<typeof createSocket> | undefined;
if (videoMode) {
  xvfb = Bun.spawn(
    ["Xvfb", display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
    { stderr: Bun.file(evidence + process.env.BENCH_RUN + "-xvfb.log") },
  );
  await Bun.sleep(400);
}
const pool = new BrowserPool(
  videoMode
    ? {
        launch: async (path: string) =>
          await chromium.launch({
            ...launchOptions(path),
            headless: false,
            env: { ...process.env, DISPLAY: display },
            args: [
              ...launchOptions(path).args,
              "--kiosk",
              "--window-position=0,0",
              "--window-size=1280,800",
            ],
          }),
      }
    : {},
);
let candidateSocket: any;
let actualCaptures = 0;
let frames = 0,
  jpegBytes = 0;
const captureSources = { stream: 0, still: 0 };
const bufferSamples: any[] = [];
const inputSamples: any[] = [];
const loopLags: number[] = [];
let lastTick = performance.now();
const loopTimer = setInterval(() => {
  const now = performance.now();
  loopLags.push(Math.max(0, now - lastTick - 100));
  lastTick = now;
}, 100);
const captures = new Map<
  string,
  { serverMs: number; wallMs: number; timestamp?: number }
>();
const senders = new Map<any, BrowserFrameSender>();
const protectedMode = true;
const stops = new Map<any, () => void>();
const busy = `<!doctype html><title>Isomux benchmark target</title><style>body{margin:0}canvas{display:block}</style><canvas width=1280 height=800></canvas><script>
const c=document.querySelector('canvas'),x=c.getContext('2d');let green=false;
addEventListener('mousedown',()=>green=!green);
function paint(t){x.fillStyle='#172337';x.fillRect(0,0,1280,800);for(let i=0;i<160;i++){x.fillStyle='hsl('+i*11+' 65% 50%)';x.fillRect((i*137+t*.15)%1280,(i*59)%800,80,30);x.fillStyle='white';x.fillText('Item '+i, (i*137+t*.15)%1280,(i*59)%800+18)}x.fillStyle=green?'#ffffff':'#000000';x.fillRect(0,0,200,200);requestAnimationFrame(paint)}requestAnimationFrame(paint);</script>`;
const ordinary = `<!doctype html><style>body{margin:0;font:16px sans-serif}#marker{position:fixed;left:0;top:0;width:200px;height:200px;background:black;z-index:2}main{margin-left:220px}input{position:fixed;left:240px;top:12px;z-index:3}</style><div id=marker></div><input id=entry><main>${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i}: a normal text page with links, forms, and enough content to scroll. <a href=#>Read more</a></p>`).join("")}</main><script>let white=false;addEventListener('mousedown',e=>{if(e.clientX<200&&e.clientY<200){white=!white;marker.style.background=white?'white':'black'}})</script>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/ws") {
      server.upgrade(req);
      return;
    }
    if (path === "/helper")
      return new Response("<title>Capture helper</title>", {
        headers: { "Content-Type": "text/html" },
      });
    if (path === "/busy")
      return new Response(pageKind === "busy" ? busy : ordinary, {
        headers: { "Content-Type": "text/html" },
      });
    if (path === "/panel.js")
      return new Response(js, {
        headers: { "Content-Type": "text/javascript" },
      });
    return new Response(
      `<html><style>body{margin:0}#root{height:500px;width:${process.env.BENCH_PANEL_WIDTH || 650}px}</style><div id="root"></div><script type="module" src="/panel.js"></script></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    drain(ws) {
      senders.get(ws)?.flush();
    },
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
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.type === "probe") {
        ws.send(
          JSON.stringify({ type: "probe", id: m.id, captures: actualCaptures }),
        );
        return;
      }
      if (m.type === "resetCapture") {
        void (async () => {
          const session = (pool as any).sessions.get("bench");
          await (pool as any).stopScreencast(session);
          await (pool as any).startScreencast("bench", session);
          if (mode === "jpeg60") {
            await session.screencast.send("Page.stopScreencast");
            await session.screencast.send("Page.startScreencast", {
              format: "jpeg",
              quality: 50,
              maxWidth: width,
              maxHeight: (width * 800) / 1280,
              everyNthFrame: 1,
            });
          }
          ws.send(JSON.stringify({ type: "resetDone" }));
        })();
        return;
      }
      if (m.type === "exercise") {
        const p = (pool as any).sessions.get("bench").page;
        void p
          .evaluate((i: number) => {
            document.querySelector("input")?.focus();
            window.scrollTo(0, (i % 5) * 240);
          }, m.index)
          .then(() => p.keyboard.insertText("sample " + m.index))
          .then(() => ws.send(JSON.stringify({ type: "exerciseDone" })));
        return;
      }
      if (m.type === "candidate_ready") candidateSocket = ws;
      if (m.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (m.type === "browser_watch" && m.watching) {
        stops.get(ws)?.();
        stops.set(
          ws,
          pool.watch(
            "bench",
            (frame) => {
              if (!frame) return;
              actualCaptures++;
              if (videoMode) return;
              const received = captures.get(frame.data);
              captureSources[received ? "stream" : "still"]++;
              const trace = {
                frame: frames,
                serverMs: performance.now(),
                bufferedBytes: ws.getBufferedAmount(),
                captureEpoch: received?.timestamp,
                receiveEpoch: received?.wallMs,
                receiveToSendMs: received
                  ? performance.now() - received.serverMs
                  : undefined,
              };
              bufferSamples.push(trace);
              const msg = encodeBrowserFrame({
                agentId: "bench",
                generation: m.generation,
                width: frame.width,
                height: frame.height,
                jpeg: Buffer.from(frame.data, "base64"),
              });
              frames++;
              jpegBytes += Buffer.from(frame.data, "base64").length;
              if (protectedMode) senders.get(ws)!.send(msg);
              else ws.send(msg);
            },
            () => true,
            {
              maxWidth: Math.min(2560, width * dpr),
              maxHeight: Math.min(2560, ((width * 800) / 1280) * dpr),
              deviceScaleFactor: dpr,
            },
            () => senders.get(ws)!.pressure.level,
            () => senders.get(ws)!.canCapture(),
          ),
        );
      }
      if (
        m.type === "browser_input" &&
        m.input.kind !== "navigate" &&
        m.input.kind !== "viewport"
      ) {
        const received = performance.now();
        void pool.humanInput("bench", m.input).then(() => {
          if (m.input.event === "mousePressed")
            inputSamples.push({
              index: inputSamples.length,
              receivedMs: received,
              dispatchMs: performance.now() - received,
            });
        });
      }
    },
    close(ws) {
      senders.get(ws)?.stop();
      senders.delete(ws);
      stops.get(ws)?.();
      stops.delete(ws);
    },
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const portHolder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(""),
});
const viewerPort = portHolder.port;
portHolder.stop(true);
const viewerHome = mkdtempSync(
  "./prototypes/browser-panel-measure/evidence/viewer-",
);
const viewerUnit = "browser-bench-viewer-" + process.pid;
const viewerProcess = Bun.spawn(
  [
    "systemd-run",
    "--user",
    "--scope",
    "--unit=" + viewerUnit,
    "-p",
    "MemoryMax=2G",
    "/usr/bin/google-chrome",
    "--headless",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--no-first-run",
    "--remote-debugging-port=" + viewerPort,
    "--user-data-dir=" + viewerHome,
    "about:blank",
  ],
  {
    stdout: "ignore",
    stderr: Bun.file(
      "./prototypes/browser-panel-measure/evidence/" + viewerUnit + ".log",
    ),
  },
);
const viewerOrigin = "http://127.0.0.1:" + viewerPort;
for (let i = 0; i < 300; i++) {
  try {
    if ((await fetch(viewerOrigin + "/json/version")).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const bridge = Bun.spawn(
  ["node", "./prototypes/browser-panel-measure/bridge.cjs"],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
);
let rpcId = 0;
const pending = new Map<number, any>();
void (async () => {
  let buffer = "";
  for await (const chunk of bridge.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const r = JSON.parse(line);
      const p = pending.get(r.id);
      pending.delete(r.id);
      if (r.error) p.reject(new Error(r.error));
      else p.resolve(r.result);
    }
  }
})();
function rpc(method: string, ...args: any[]) {
  return new Promise<any>((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    bridge.stdin.write(
      JSON.stringify({
        id,
        method,
        args: args.map((a) =>
          typeof a === "function" ? { __function: a.toString() } : a,
        ),
      }) + "\n",
    );
    bridge.stdin.flush();
  });
}
await rpc("connect", viewerOrigin);
console.log("viewerBackend", JSON.stringify(await rpc("gpuInfo")));
const remotePage: any = new Proxy(
  {
    then: undefined,
    on: () => {},
    locator: (selector: string) => ({
      dispatchEvent: (event: string, options: any) =>
        rpc("dispatch", selector, event, options),
    }),
  },
  {
    get: (obj, key) =>
      key in obj ? obj[key] : (...args: any[]) => rpc(String(key), ...args),
  },
);
const viewer = {
  newPage: async (options: any) => {
    await rpc("newPage", options);
    return remotePage;
  },
  close: async () => {
    await rpc("close");
    bridge.stdin.end();
    await bridge.exited;
  },
};
function processParts(base: string) {
  const out: any = {};
  for (const id of readFileSync(base + "/cgroup.procs", "utf8")
    .trim()
    .split("\n")) {
    try {
      const name = readFileSync("/proc/" + id + "/comm", "utf8").trim();
      const part = name.includes("chrome")
        ? "chrome"
        : name === "ffmpeg"
          ? "encoder"
          : name === "Xvfb"
            ? "display"
            : name === "node"
              ? "controller"
              : "harness";
      const stat = readFileSync("/proc/" + id + "/stat", "utf8")
        .split(") ")[1]
        .split(" ");
      const mem = readFileSync("/proc/" + id + "/smaps_rollup", "utf8");
      const pss = Number(mem.match(/^Pss:\s+(\d+)/m)?.[1] || 0) * 1024;
      out[part] ??= { cpuUsec: 0, pssBytes: 0, processes: 0 };
      out[part].cpuUsec += (+stat[11] + +stat[12]) * 10000;
      out[part].pssBytes += pss;
      out[part].processes++;
    } catch {}
  }
  return out;
}
function scopeStats() {
  const cg = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
  const base = "/sys/fs/cgroup" + cg;
  const viewerCg = execFileSync("systemctl", [
    "--user",
    "show",
    viewerUnit + ".scope",
    "--property=ControlGroup",
    "--value",
  ])
    .toString()
    .trim();
  const v = "/sys/fs/cgroup" + viewerCg;
  const stat = readFileSync("/proc/" + bridge.pid + "/stat", "utf8")
    .split(") ")[1]
    .split(" ");
  return {
    parts: processParts(base),
    controllerCpuUsec: (+stat[11] + +stat[12]) * 10000,
    memoryCurrent: +readFileSync(base + "/memory.current", "utf8"),
    clock: { epochMs: Date.now(), monotonicMs: performance.now() },
    viewer: {
      cpu: readFileSync(v + "/cpu.stat", "utf8"),
      memoryPeak: +readFileSync(v + "/memory.peak", "utf8"),
    },
    load: readFileSync("/proc/loadavg", "utf8").trim(),
    cpu: readFileSync(base + "/cpu.stat", "utf8").trim(),
    memoryPeak: +readFileSync(base + "/memory.peak", "utf8").trim(),
    memoryLimit: readFileSync(base + "/memory.max", "utf8").trim(),
  };
}
console.log("scopeStart", JSON.stringify(scopeStats()));
try {
  console.log("target goto");
  const result = await pool.run("bench", {
    action: "goto",
    url: origin + "/busy",
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  console.log("viewer newPage");
  const page = await viewer.newPage({
    viewport: { width: 1320, height: 920 },
    deviceScaleFactor: dpr,
  });
  page.on("pageerror", (e) => console.error("viewer error", String(e)));
  console.log("viewer goto");
  await page.goto(origin + (videoMode ? "?candidate&width=" + width : ""));
  console.log("viewer loaded");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(2000);
  const session = (pool as any).sessions.get("bench");
  if (videoMode)
    session.screencast = await session.page
      .context()
      .newCDPSession(session.page);
  const cdp = session.screencast;
  if (mode === "jpeg60") {
    await cdp.send("Page.stopScreencast");
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      maxWidth: width,
      maxHeight: (width * 800) / 1280,
      everyNthFrame: 1,
    });
  }
  cdp.prependListener("Page.screencastFrame", (event: any) => {
    captures.set(event.data, {
      serverMs: performance.now(),
      wallMs: Date.now(),
      timestamp: event.metadata?.timestamp,
    });
    if (captures.size > 100) captures.delete(captures.keys().next().value!);
  });
  if (videoMode) {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "fullscreen" },
    });
    await Bun.sleep(500);
    await cdp.send("Page.stopScreencast");
    if (mode === "h264rtp") {
      rtpSocket = createSocket("udp4");
      let pieces: Buffer[] = [];
      let key = false;
      let sequence = -1;
      let gaps = 0;
      rtpSocket.on("message", (packet) => {
        const seq = packet.readUInt16BE(2);
        if (sequence >= 0 && seq !== ((sequence + 1) & 65535)) {
          gaps++;
          console.log("rtpGap", sequence, seq, gaps);
        }
        sequence = seq;
        let start = 12 + (packet[0] & 15) * 4;
        if (packet[0] & 16) start += 4 + packet.readUInt16BE(start + 2) * 4;
        const end = packet.length - (packet[0] & 32 ? packet.at(-1)! : 0);
        const data = packet.subarray(start, end);
        const type = data[0] & 31;
        const add = (nal: Buffer) => {
          if ((nal[0] & 31) === 5) key = true;
          pieces.push(Buffer.from([0, 0, 0, 1]), nal);
        };
        if (type === 24) {
          let pos = 1;
          while (pos + 2 <= data.length) {
            const size = data.readUInt16BE(pos);
            pos += 2;
            add(data.subarray(pos, pos + size));
            pos += size;
          }
        } else if (type === 28) {
          if (data[1] & 128)
            add(Buffer.from([(data[0] & 224) | (data[1] & 31)]));
          pieces.push(data.subarray(2));
        } else add(data);
        if (packet[1] & 128) {
          actualCaptures++;
          candidateSocket?.send(
            Buffer.concat([Buffer.from([key ? 1 : 0]), ...pieces]),
          );
          pieces = [];
          key = false;
        }
      });
      await new Promise<void>((resolve) =>
        rtpSocket!.bind(0, "127.0.0.1", resolve),
      );
      rtpSocket.setRecvBufferSize(4 * 1024 * 1024);
      const address = rtpSocket.address();
      if (typeof address === "string") throw new Error("UDP address");
      encoder = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "warning",
          "-f",
          "x11grab",
          "-framerate",
          "30",
          "-video_size",
          "1280x800",
          "-i",
          display,
          "-vf",
          `scale=${width}:${(width * 800) / 1280}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "23",
          "-g",
          "30",
          "-threads",
          "2",
          "-x264-params",
          "repeat-headers=1",
          "-flush_packets",
          "1",
          "-f",
          "rtp",
          `rtp://127.0.0.1:${address.port}?pkt_size=60000`,
        ],
        {
          stdout: "ignore",
          stderr: Bun.file(evidence + process.env.BENCH_RUN + "-encoder.log"),
        },
      );
    } else {
      encoder = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "warning",
          "-f",
          "x11grab",
          "-framerate",
          "30",
          "-video_size",
          "1280x800",
          "-i",
          display,
          "-vf",
          `scale=${width}:${(width * 800) / 1280}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "23",
          "-g",
          "30",
          "-threads",
          "2",
          "-x264-params",
          "aud=1:repeat-headers=1",
          "-flush_packets",
          "1",
          "-f",
          "h264",
          "pipe:1",
        ],
        {
          stdout: "pipe",
          stderr: Bun.file(evidence + process.env.BENCH_RUN + "-encoder.log"),
        },
      );
      void (async () => {
        let held = Buffer.alloc(0);
        for await (const chunk of encoder.stdout) {
          held = Buffer.concat([held, chunk]);
          const cuts: number[] = [];
          for (let i = 0; i + 4 < held.length; i++) {
            if (
              held[i] === 0 &&
              held[i + 1] === 0 &&
              held[i + 2] === 1 &&
              (held[i + 3] & 31) === 9
            )
              cuts.push(i > 0 && held[i - 1] === 0 ? i - 1 : i);
          }
          while (cuts.length > 1) {
            const from = cuts.shift()!;
            const to = cuts[0];
            const frame = held.subarray(from, to);
            let key = false;
            for (let i = 0; i + 4 < frame.length; i++)
              if (
                frame[i] === 0 &&
                frame[i + 1] === 0 &&
                frame[i + 2] === 1 &&
                (frame[i + 3] & 31) === 5
              )
                key = true;
            actualCaptures++;
            candidateSocket?.send(
              Buffer.concat([Buffer.from([key ? 1 : 0]), frame]),
            );
          }
          if (cuts.length) held = held.subarray(cuts[0]);
        }
      })();
    }
    await page.waitForTimeout(3000);
    if (process.env.DIAGNOSTIC)
      await page.screenshot({
        path: evidence + process.env.BENCH_RUN + "-viewer.png",
      });
    if (process.env.DIAGNOSTIC)
      await session.page.screenshot({
        path: evidence + process.env.BENCH_RUN + "-target.png",
      });
  }

  frames = 0;
  jpegBytes = 0;
  bufferSamples.length = 0;
  inputSamples.length = 0;
  loopLags.length = 0;
  lastTick = performance.now();
  await page.evaluate(() => {
    const m = (window as any).metrics;
    m.draws = 0;
    m.markerFrames = [];
    m.latencies = [];
    m.clicks = [];
    m.intervals = [];
    m.lastDraw = 0;
    m.transport = [];
    m.render = [];
  });
  const resourceBefore = scopeStats();
  console.log("measurementStart", JSON.stringify(resourceBefore));
  const start = performance.now();
  const m = await page
    .evaluate(
      async ({ count, pageKind }) => {
        const m = (window as any).metrics;
        const rtc = async () => {
          const pc = (window as any).receiver;
          if (!pc) return null;
          return [...(await pc.getStats()).values()].find(
            (s: any) => s.type === "inbound-rtp" && s.kind === "video",
          );
        };
        if (m.last !== 0)
          throw new Error("initial marker is not black: " + m.last);
        m.rtcBefore = await rtc();
        m.draws = 0;
        m.intervals = [];
        m.lastDraw = 0;
        m.messageBytes = 0;
        m.receivedFrames = 0;
        m.startedMs = performance.now();
        m.decodeLoads = 0;
        m.decodeErrors = 0;
        m.decodeReplaced = 0;
        m.measuring = true;
        m.trials = [];
        const socket = (window as any).benchSocket;
        let probeId = 0;
        const probe = () =>
          new Promise<number>((resolve) => {
            const id = ++probeId;
            const on = (e: MessageEvent) => {
              if (typeof e.data !== "string") return;
              const r = JSON.parse(e.data);
              if (r.type === "probe" && r.id === id) {
                socket.removeEventListener("message", on);
                resolve(r.captures);
              }
            };
            socket.addEventListener("message", on);
            socket.send(JSON.stringify({ type: "probe", id }));
          });
        for (let i = 0; i < count; i++) {
          if (pageKind === "ordinary") {
            await new Promise<void>((resolve) => {
              const on = (e: MessageEvent) => {
                if (
                  typeof e.data === "string" &&
                  JSON.parse(e.data).type === "exerciseDone"
                ) {
                  socket.removeEventListener("message", on);
                  resolve();
                }
              };
              socket.addEventListener("message", on);
              socket.send(JSON.stringify({ type: "exercise", index: i }));
            });
            await new Promise((r) => setTimeout(r, 100));
          }
          const capturedBefore = await probe();
          const receivedBefore = m.receivedFrames;
          const successes = m.latencies.length;
          socket.send(
            JSON.stringify({
              type: "browser_input",
              input: {
                kind: "mouse",
                event: "mousePressed",
                x: 30,
                y: 30,
                button: "left",
                clickCount: 1,
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "browser_input",
              input: {
                kind: "mouse",
                event: "mouseReleased",
                x: 30,
                y: 30,
                button: "left",
                clickCount: 1,
              },
            }),
          );
          const start = performance.now();
          while (
            m.latencies.length === successes &&
            performance.now() - start < 2000
          )
            await new Promise((r) => setTimeout(r, 10));
          const failed = m.latencies.length === successes;
          const capturedAfter = await probe();
          m.trials.push({
            index: i,
            latency: failed ? null : m.latencies.at(-1),
            captured: capturedAfter - capturedBefore,
            received: m.receivedFrames - receivedBefore,
          });
          if (failed) {
            m.pending = 0;
            m.last = -1;
            if (!location.search.includes("candidate")) {
              socket.send(JSON.stringify({ type: "resetCapture" }));
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 1000));
        m.endedMs = performance.now();
        m.measuring = false;
        m.rtcAfter = await rtc();
        const c = document.querySelector("canvas")!;
        return { ...m, decodedSize: [c.width, c.height] };
      },
      { count: Number(process.env.BENCH_CLICKS || 100), pageKind },
    )
    .catch(async (e: any) => {
      console.log(
        "failureMetrics",
        JSON.stringify(await page.evaluate(() => (window as any).metrics)),
      );
      console.log(
        "targetMarker",
        await session.page.evaluate(() => ({
          background: document.getElementById("marker")?.style.background,
          scrollY,
        })),
      );
      await page.screenshot({
        path: evidence + process.env.BENCH_RUN + "-failed-viewer.png",
      });
      await session.page.screenshot({
        path: evidence + process.env.BENCH_RUN + "-failed-target.png",
      });
      throw e;
    });
  const elapsed = (m.endedMs - m.startedMs) / 1000;
  const serverElapsed = (performance.now() - start) / 1000;
  const resourceAfter = scopeStats();
  console.log("measurementEnd", JSON.stringify(resourceAfter));
  const samples = m.latencies.map((latency: number, index: number) => ({
    index,
    clickMs: m.clicks[index],
    latency,
    frameIndex: m.markerFrames[index],
  }));
  await Bun.write(
    "./prototypes/browser-panel-measure/evidence/" +
      (process.env.BENCH_RUN || String(process.pid)) +
      ".csv",
    "index,clickMs,latencyMs,frameIndex\n" +
      samples
        .map((s: any) =>
          [s.index, s.clickMs, s.latency, s.frameIndex].join(","),
        )
        .join("\n"),
  );
  await Bun.write(
    "./prototypes/browser-panel-measure/evidence/" +
      (process.env.BENCH_RUN || String(process.pid)) +
      "-buffers.csv",
    "frame,serverMs,bufferedBytes,captureEpochSeconds,receiveEpochMs,receiveToSendMs\n" +
      bufferSamples
        .map((s) =>
          [
            s.frame,
            s.serverMs,
            s.bufferedBytes,
            s.captureEpoch,
            s.receiveEpoch,
            s.receiveToSendMs,
          ].join(","),
        )
        .join("\n"),
  );
  console.log("captureSources", JSON.stringify(captureSources));
  console.log("samples", JSON.stringify(samples));
  const lat = m.latencies.sort((a: number, b: number) => a - b);
  const { rtcBefore, rtcAfter } = m;
  const rtcSeconds = rtcAfter
    ? (rtcAfter.timestamp - rtcBefore.timestamp) / 1000
    : 0;

  console.log(
    "surfaceProof",
    JSON.stringify(
      await page.evaluate(() => ({
        viewport: [innerWidth, innerHeight],
        canvases: [...document.querySelectorAll("canvas")].map((c) => ({
          decoded: [c.width, c.height],
          css: [
            c.getBoundingClientRect().width,
            c.getBoundingClientRect().height,
          ],
        })),
      })),
    ),
  );
  console.log(
    JSON.stringify(
      {
        trials: m.trials,
        decodeLoads: m.decodeLoads,
        decodeErrors: m.decodeErrors,
        decodeReplaced: m.decodeReplaced,
        transportSamples: m.transport,
        renderSamples: m.render,
        inputSamples,
        eventLoopMs: {
          median: loopLags.sort((a, b) => a - b)[
            Math.floor(loopLags.length / 2)
          ],
          p95: loopLags[Math.floor(loopLags.length * 0.95)],
          max: Math.max(...loopLags),
        },
        decodedSize: m.decodedSize,
        processIds: {
          bun: process.pid,
          viewer: viewerProcess.pid,
          controller: bridge.pid,
        },
        rtcFps: rtcAfter
          ? (rtcAfter.framesDecoded - rtcBefore.framesDecoded) / rtcSeconds
          : undefined,
        rtpMbps: rtcAfter
          ? ((rtcAfter.bytesReceived - rtcBefore.bytesReceived) * 8) /
            rtcSeconds /
            1e6
          : undefined,
        rtcBefore,
        rtcAfter,
        date: new Date().toISOString(),
        hash: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        mode,
        pageKind,
        width,
        seconds: elapsed,
        frames,
        fps: m.receivedFrames / elapsed,
        paintFps: m.draws / elapsed,
        meanJpegBytes: jpegBytes / frames,
        meanWireBytes: m.messageBytes / m.receivedFrames,
        wsMbps: (m.messageBytes * 8) / elapsed / 1e6,
        clicks: lat.length,
        medianMs: lat[Math.floor(lat.length / 2)],
        p95Ms: lat[Math.floor(lat.length * 0.95)],
        resourceBefore,
        resourceAfter,
        serverElapsed,
        transportMedian: m.transport.sort((a: number, b: number) => a - b)[
          Math.floor(m.transport.length / 2)
        ],
        renderMedian: m.render.sort((a: number, b: number) => a - b)[
          Math.floor(m.render.length / 2)
        ],
        medianIntervalFps:
          1000 /
          m.intervals.sort((a: number, b: number) => a - b)[
            Math.floor(m.intervals.length / 2)
          ],
        scope:
          "Cgroup CPU/current/peak; subtract controller CPU ticks from target scope; separate viewer scope; viewer-local counting window; loopback",
      },
      null,
      2,
    ),
  );
  if (process.env.BENCH_SCREENSHOT) {
    await page.screenshot({ path: process.env.BENCH_SCREENSHOT });
    await session.page.screenshot({
      path: process.env.BENCH_SCREENSHOT + "-target.png",
    });
  }
} finally {
  clearInterval(loopTimer);
  console.log("scopeEnd", JSON.stringify(scopeStats()));
  encoder?.kill();
  rtpSocket?.close();
  await pool.shutdown();
  xvfb?.kill();
  await viewer.close();
  await viewerProcess.exited;
  server.stop(true);
}
