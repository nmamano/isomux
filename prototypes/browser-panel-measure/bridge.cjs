const { chromium } = require("playwright-core");
const readline = require("node:readline");
let browser, page;
const revive = (v) => (v && v.__function ? eval("(" + v.__function + ")") : v);
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, args = [] } = JSON.parse(line);
  try {
    let result;
    const a = args.map(revive);
    if (method === "connect") {
      browser = await chromium.connectOverCDP(a[0]);
    } else if (method === "gpuInfo") {
      const cdp = await browser.newBrowserCDPSession();
      const info = await cdp.send("SystemInfo.getInfo");
      result = { gpu: info.gpu, version: await cdp.send("Browser.getVersion") };
      await cdp.detach();
    } else if (method === "newPage") {
      page = await browser.newPage(a[0]);
      page.on("pageerror", (e) => console.error(e));
    } else if (method === "dispatch") {
      await page.locator(a[0]).dispatchEvent(a[1], a[2]);
    } else if (method === "close") {
      await (await browser.newBrowserCDPSession())
        .send("Browser.close")
        .catch(() => {});
      await browser.close();
    } else result = await page[method](...a);
    process.stdout.write(
      JSON.stringify({
        id,
        result:
          method === "waitForSelector" ||
          method === "waitForFunction" ||
          method === "goto"
            ? null
            : result,
      }) + "\n",
    );
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, error: String(e) }) + "\n");
  }
});
