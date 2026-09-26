// Opens the office and an app named hello through the ingress, as the owner.
// Run with: run.sh client bun /verify/browser.mjs
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const ip = process.env.NODE_IP;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: [
    `--host-resolver-rules=MAP office.k8s.test ${ip}, MAP *.office.k8s.test ${ip}`,
    `--ignore-certificate-errors-spki-list=${process.env.SPKI}`,
    // The client container has no seccomp profile for the sandbox; this browser
    // is the test client, not the office.
    "--no-sandbox",
  ],
});
const context = await browser.newContext();
const cookies = readFileSync("/work/cookies.txt", "utf8")
  .split("\n")
  .filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_")))
  .map((l) => {
    const f = l.replace(/^#HttpOnly_/, "").split("\t");
    return { name: f[5], value: f[6], domain: f[0], path: f[2], secure: f[3] === "TRUE", httpOnly: l.startsWith("#HttpOnly_") };
  });
await context.addCookies(cookies);
const page = await context.newPage();
const office = await page.goto("https://office.k8s.test/");
console.log("office", office.status(), await page.title());
const app = await page.goto("https://hello.office.k8s.test/");
console.log("app", app.status(), page.url(), (await page.textContent("body")).trim());
const echo = await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://hello.office.k8s.test/");
      ws.onopen = () => ws.send("ping");
      ws.onmessage = (e) => resolve(e.data);
      ws.onerror = () => reject(new Error("websocket error"));
      setTimeout(() => reject(new Error("websocket timeout")), 10000);
    }),
);
console.log("websocket", echo);
await browser.close();
