// Isolated test Chrome with no Playwright launch defaults or profile overrides.
import {
  chromium,
  type ConnectOverCDPTransport,
  type Page,
} from "playwright-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
export async function launchRawExtensionChrome(dir: string) {
  let chrome: ReturnType<typeof Bun.spawn> | undefined;
  // Kept so a launch failure can say why Chrome did not start.
  const stderrPath = join(dir, "chrome-stderr.log");
  try {
    chrome = Bun.spawn(
      [
        "/usr/bin/google-chrome",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        // Suppress the "can't update Chrome" bubble that takes window focus.
        // Keep disabled features in this one switch; Chrome uses only the last.
        "--disable-features=OutdatedBuildDetector",
        "--enable-unsafe-extension-debugging",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=" + join(dir, "profile"),
      ],
      { stdout: "ignore", stderr: Bun.file(stderrPath) },
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
      if (Date.now() >= launchDeadline || chrome.exitCode !== null) {
        const stderr = existsSync(stderrPath)
          ? readFileSync(stderrPath, "utf8").slice(-2000)
          : "";
        throw new Error(
          `Isolated Chrome did not start (exit ${chrome.exitCode ?? "none"}): ${stderr}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.log("Isolated Chrome fixture", {
      profile: join(dir, "profile"),
      cdpPort: Number(new URL(endpoint).port),
    });
    let browser = await connectRaw(endpoint);
    return {
      get browser() {
        return browser;
      },
      // The browser endpoint, for a client that attaches to no page.
      endpoint,
      // A new setup client, after the last one closed. Chrome keeps running.
      async reconnect() {
        browser = await connectRaw(endpoint);
        return browser;
      },
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

// Pairs the extension with an office by writing its connection record from
// an extension page. The key is the format background.ts reads since 0.10.0:
// CONNECTION_PREFIX plus the office origin from officeOf (pinned against the
// real worker by CONNECTION in browser-extension/background.test.ts). The
// worker moves the pre-0.10.0 "connection" key only at its start, so a write
// under that key after the start never connects.
export async function storeExtensionPairing(
  page: Page,
  pairing: { url: string; credential: string; nonce?: string },
): Promise<void> {
  const url = new URL(pairing.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const key = "connection:" + url.origin;
  await page.evaluate(
    async ({ key, pairing }) => {
      const extensionChrome = (
        globalThis as unknown as {
          chrome: {
            storage: { local: { set(value: unknown): Promise<void> } };
          };
        }
      ).chrome;
      await extensionChrome.storage.local.set({ [key]: pairing });
    },
    { key, pairing },
  );
}

async function connectRaw(endpoint: string) {
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
  return chromium.connectOverCDP(adminTransport, {
    noDefaults: true,
    timeout: 5000,
  });
}
