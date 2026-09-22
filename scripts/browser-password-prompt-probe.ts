// Manual native-UI evidence, not a page-level assertion that a prompt closed.
// Run under a fresh Xvfb display. Uses a new profile and fake credentials only.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchRawExtensionChrome } from "../server/test-support/raw-extension-chrome";

const dir = mkdtempSync(join(tmpdir(), "isomux-password-prompt-"));
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const done = new URL(req.url).pathname === "/done";
    return new Response(done
      ? '<h1>Fake login complete</h1><button>Continue</button>'
      : '<form method="post" action="/done"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Fake login</button></form>',
      {headers:{"Content-Type":"text/html"}});
  },
});
const raw = await launchRawExtensionChrome(dir);
try {
  const page = await raw.browser.contexts()[0].newPage();
  page.setDefaultTimeout(5000);
  await page.goto(server.url.href);
  await page.bringToFront();
  await page.locator("[name=username]").fill("fixture-user");
  await page.locator("[name=password]").fill("Fake-Only-Password-123!");
  await page.locator("button").click();
  const capture = async (name: string) => {
    await Bun.sleep(1000);
    const shot = Bun.spawn(["ffmpeg","-y","-f","x11grab","-video_size","1280x900","-i",process.env.DISPLAY!,"-frames:v","1",join(dir,name+".png")], {stdout:"ignore",stderr:"ignore"});
    if(await shot.exited !== 0) throw Error("Native desktop capture failed");
  };
  await capture("submitted");
  await page.locator("button").click();
  await capture("page-click");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Page.handleJavaScriptDialog",{accept:false});
    console.log("JavaScript dialog handler returned success; inspect native evidence.");
  } catch (error) {
    console.log(String(error));
  }
  await capture("javascript-dialog-handler");
  // One contact sheet prevents a viewer's successive-image difference display
  // from hiding unchanged native UI. Keep all original desktop captures too.
  const stages = ["submitted","page-click","javascript-dialog-handler"];
  const sheet = Bun.spawn(["ffmpeg","-y",...stages.flatMap((name)=>["-i",join(dir,name+".png")]),"-filter_complex","hstack=inputs=3","-frames:v","1",join(dir,"stages.png")], {stdout:"ignore",stderr:"ignore"});
  if(await sheet.exited !== 0) throw Error("Native evidence contact sheet failed");
  console.log("Native stages.png order: submitted, page-click, javascript-dialog-handler");
  console.log("Inspect native desktop images in "+dir);
} finally {
  await raw.close();
  await server.stop(true);
}
