// Isolated test Chrome with no Playwright launch defaults or profile overrides.
import { chromium, type ConnectOverCDPTransport } from "playwright-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
export async function launchRawExtensionChrome(dir: string) {
  let chrome: ReturnType<typeof Bun.spawn> | undefined;
  try {
    chrome = Bun.spawn(
      [
        "/usr/bin/google-chrome",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--enable-unsafe-extension-debugging",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=" + join(dir, "profile"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const portFile = join(dir, "profile", "DevToolsActivePort");
    const launchDeadline = Date.now() + 10_000;
    let endpoint = "";
    while (!endpoint) {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
        if (/^\d+$/.test(port ?? "") && path?.startsWith("/devtools/browser/"))
          endpoint = "ws://127.0.0.1:" + port + path;
      }
      if (endpoint) break;
      if (Date.now() >= launchDeadline)
        throw new Error("Isolated Chrome did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Isolated CDP socket did not open")),
        5000,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Isolated CDP socket failed"));
      };
    });
    const adminTransport: ConnectOverCDPTransport = {
      send: (message) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
    };
    socket.onmessage = (event) =>
      adminTransport.onmessage?.(JSON.parse(String(event.data)));
    socket.onclose = () => adminTransport.onclose?.();
    const browser = await chromium.connectOverCDP(adminTransport, {
      noDefaults: true,
      timeout: 5000,
    });
    return {
      browser,
      async close() {
        await browser.close();
        chrome?.kill();
        if (chrome) await chrome.exited;
      },
    };
  } catch (error) {
    chrome?.kill();
    if (chrome) await chrome.exited;
    throw error;
  }
}
