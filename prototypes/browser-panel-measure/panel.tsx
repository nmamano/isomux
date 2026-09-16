// Local measurement harness. It mounts the production panel and uses a real WS.
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../ui/log-view/BrowserPanel.tsx";
import { connect } from "../../ui/ws.ts";
const metrics = {
  decodeLoads: 0,
  decodeErrors: 0,
  decodeReplaced: 0,
  readbackDurations: [] as number[],
  drawDurations: [] as number[],
  drawClickDurations: [] as number[],
  renderAfter: [] as number[],
  latenciesAfter: [] as number[],
  draws: 0,
  measuring: false,
  messageBytes: 0,
  receivedFrames: 0,
  markerFrames: [] as (number | null)[],
  clicks: [] as number[],
  latencies: [] as number[],
  transport: [] as number[],
  render: [] as number[],
  pending: 0,
  last: -1,
  intervals: [] as number[],
  lastDraw: 0,
};
Object.assign(window, { metrics });
const received = new Map<string, number>();
const indices = new Map<string, number>();
const binaryArrivals = new WeakMap<
  ArrayBuffer,
  { now: number; index: number }
>();
const blobs = new WeakMap<Blob, { now: number; index: number }>();
const NativeBlob = Blob;
window.Blob = class extends NativeBlob {
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    const first = parts[0];
    if (ArrayBuffer.isView(first)) {
      const meta = binaryArrivals.get(first.buffer as ArrayBuffer);
      if (meta) blobs.set(this, meta);
    }
  }
};
const createUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob: Blob) => {
  const url = createUrl(blob);
  const meta = blobs.get(blob);
  if (meta) {
    received.set(url, meta.now);
    indices.set(url, meta.index);
  }
  return url;
};
const revokeUrl = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url: string) => {
  received.delete(url);
  indices.delete(url);
  revokeUrl(url);
};
const bitmapInfo = new WeakMap<object, { now: number; index: number }>();
const nativeBitmap = window.createImageBitmap.bind(window);
window.createImageBitmap = (async (blob: Blob) => {
  const result = await nativeBitmap(blob);
  const meta = blobs.get(blob);
  if (meta) bitmapInfo.set(result, meta);
  return result;
}) as typeof createImageBitmap;
const NativeSocket = WebSocket;
window.WebSocket = class extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    (window as any).benchSocket = this;
    this.addEventListener("message", (e) => {
      const now = performance.now();
      if (e.data instanceof ArrayBuffer) {
        if (metrics.measuring) {
          metrics.messageBytes += e.data.byteLength;
          metrics.receivedFrames++;
        }
        binaryArrivals.set(e.data, { now, index: metrics.receivedFrames });
        if (location.search.includes("data-url")) {
          const v = new DataView(e.data);
          const jpeg = new Uint8Array(e.data, 28 + v.getUint16(6));
          let raw = "";
          for (let i = 0; i < jpeg.length; i += 32768)
            raw += String.fromCharCode(...jpeg.subarray(i, i + 32768));
          const src = "data:image/jpeg;base64," + btoa(raw);
          received.set(src, now);
          indices.set(src, metrics.receivedFrames);
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === "browser_frame") {
        if (metrics.measuring) {
          metrics.messageBytes += e.data.length;
          metrics.receivedFrames++;
        }
        received.set("data:image/jpeg;base64," + m.data, now);
        indices.set("data:image/jpeg;base64," + m.data, m.frameIndex);
        if (indices.size > 100) indices.delete(indices.keys().next().value!);
        if (received.size > 100) received.delete(received.keys().next().value!);
      }
    });
  }
  send(data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string" && data.includes('"mousePressed"')) {
      metrics.pending = performance.now();
      metrics.clicks.push(metrics.pending);
    }
    super.send(data);
  }
};
const draw = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (
  ...args: Parameters<typeof draw>
) {
  const beforeDraw = performance.now();
  draw.apply(this, args);
  const afterDraw = performance.now();
  if (this.canvas.getAttribute("role") !== "application") return;
  metrics.draws++;
  if (metrics.measuring) metrics.drawDurations.push(afterDraw - beforeDraw);
  if (metrics.lastDraw) metrics.intervals.push(beforeDraw - metrics.lastDraw);
  metrics.lastDraw = beforeDraw;
  if (!metrics.pending && metrics.last !== -1) return;
  const readbackStart = performance.now();
  const pixels = this.getImageData(
    Math.round((this.canvas.width * 30) / 1280),
    Math.round((this.canvas.height * 30) / 800),
    Math.max(1, Math.round((this.canvas.width * 100) / 1280)),
    Math.max(1, Math.round((this.canvas.height * 100) / 800)),
  ).data;
  const readbackEnd = performance.now();
  if (metrics.measuring)
    metrics.readbackDurations.push(readbackEnd - readbackStart);
  let luma = 0;
  for (let i = 0; i < pixels.length; i += 4)
    luma +=
      pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
  const white = luma / (pixels.length / 4) > 127 ? 1 : 0;
  if (metrics.pending && white !== metrics.last) {
    metrics.latenciesAfter.push(afterDraw - metrics.pending);
    metrics.drawClickDurations.push(afterDraw - beforeDraw);
    metrics.latencies.push(beforeDraw - metrics.pending);
    metrics.markerFrames.push(
      bitmapInfo.get(args[0])?.index ??
        indices.get((args[0] as HTMLImageElement).src) ??
        null,
    );
    const arrival =
      bitmapInfo.get(args[0])?.now ??
      received.get((args[0] as HTMLImageElement).src);
    if (arrival) {
      metrics.transport.push(arrival - metrics.pending);
      metrics.render.push(beforeDraw - arrival);
      metrics.renderAfter.push(afterDraw - arrival);
    }
    metrics.pending = 0;
  }
  metrics.last = white;
};
if (location.search.includes("candidate")) {
  const canvas = document.createElement("canvas");
  canvas.width = Number(new URLSearchParams(location.search).get("width"));
  canvas.height = (canvas.width * 800) / 1280;
  canvas.setAttribute("role", "application");
  canvas.style.width = "640px";
  canvas.style.height = "400px";
  document.getElementById("root")!.append(canvas);
  const ctx = canvas.getContext("2d")!;
  const ws = new WebSocket("ws://" + location.host + "/ws");
  ws.binaryType = "arraybuffer";
  let stamp = 0;
  const arrivals = new Map<number, number>();
  const decoder = new VideoDecoder({
    output(frame) {
      bitmapInfo.set(frame, {
        now: arrivals.get(frame.timestamp)!,
        index: stamp,
      });
      arrivals.delete(frame.timestamp);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error(e) {
      metrics.decodeErrors++;
      console.error(e);
    },
  });
  decoder.configure({ codec: "avc1.42E01F", optimizeForLatency: true });
  ws.onopen = () => ws.send(JSON.stringify({ type: "candidate_ready" }));
  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const data = new Uint8Array(e.data);
    const key = data[0] === 1;
    const timestamp = ++stamp;
    arrivals.set(timestamp, performance.now());
    decoder.decode(
      new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp,
        data: data.subarray(1),
      }),
    );
  };
  canvas.addEventListener("mousedown", () =>
    ws.send(
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
    ),
  );
  canvas.addEventListener("mouseup", () =>
    ws.send(
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
    ),
  );
} else {
  connect(() => {});
  setTimeout(
    () =>
      createRoot(document.getElementById("root")!).render(
        <BrowserPanel agentId="bench" canDrive onClose={() => {}} />,
      ),
    200,
  );
}
