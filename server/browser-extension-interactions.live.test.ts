import {
  launchRawExtensionChrome,
  storeExtensionPairing,
} from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect, spyOn } from "bun:test";
import { ExtensionConnection } from "./browser-extension-bridge";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import {
  ANSWER_TOO_LARGE_ERROR,
  type ExtensionBrowserSessions,
} from "./browser-extension-session";
import {
  BROWSER_ACTION_DEADLINE_MS,
  type BrowserResult,
} from "./browser-actions";
import { SCOPED_READ_ATTACH_MS } from "./browser-frames";
import { CHECK_REASON, CLICK_REASON, SELECT_REASON } from "./browser-input";
import type { Dialog, Page } from "playwright-core";
import {
  ATTACH_ANSWER_MS,
  EXTENSION_MAX_BYTES,
  type Fields,
} from "../shared/browser-extension-protocol";
import { translatorFor } from "../shared/i18n/translate";
import { writeFileSync } from "node:fs";

type Site = (url: URL) => Response | Promise<Response>;
// Offers one tab of a raw extension Chrome to fixture-agent and drives it
// through the office action contract only.
async function withOfferedTab(
  site: Site,
  run: (h: {
    origin: string;
    dir: string;
    act: (body: Record<string, unknown>) => Promise<Timed>;
    setupPage: Page;
    closeSetup: () => Promise<void>;
    stopClient: () => void;
  }) => Promise<void>,
  deadlineMs = 5000,
  // Runs on the open popup before the member turns on control.
  beforeOffer?: (h: {
    page: Page;
    popup: Awaited<ReturnType<typeof openExtensionActionPopup>>;
  }) => Promise<void>,
  // The site path of a page that Chrome prerenders and then activates in
  // the offered tab, as the omnibox or a speculation rule does. No CDP
  // client is attached to the tab until after the activation: an attached
  // one turns prerendering off.
  prerendered?: { start: string; activated: string },
) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-interactions-"));
  const fixture = browserExtensionFixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => site(new URL(req.url)),
  });
  console.log("Isolated interaction fixture", {
    profile: join(dir, "profile"),
    site: server.url.origin,
    extension: fixture.origin,
  });
  let raw: Awaited<ReturnType<typeof launchRawExtensionChrome>> | undefined;
  let sessions: ExtensionBrowserSessions | undefined;
  try {
    await buildBrowserExtension(join(dir, "extension"));
    raw = await launchRawExtensionChrome(dir);
    let setup = raw.browser.contexts()[0];
    let admin = await raw.browser.newBrowserCDPSession();
    const { id } = await admin.send("Extensions.loadUnpacked", {
      path: join(dir, "extension"),
    });
    const extensionPage = await setup.newPage();
    await extensionPage.goto("chrome-extension://" + id + "/connection.html");
    await storeExtensionPairing(extensionPage, {
      url: fixture.extensionURL,
      credential: fixture.credential,
      nonce: crypto.randomUUID(),
    });
    const deadline = Date.now() + 5000;
    while (!fixture.bridge.connections("fixture-member")[0]) {
      if (Date.now() >= deadline)
        throw new Error("Fixture connection did not settle");
      await Bun.sleep(20);
    }
    let offered: Page;
    let target: string;
    if (prerendered) {
      await raw.browser.close();
      target = await prerenderedTab(
        raw.endpoint,
        server.url.origin + prerendered.start,
        server.url.origin + prerendered.activated,
      );
      const browser = await raw.reconnect();
      setup = browser.contexts()[0];
      admin = await browser.newBrowserCDPSession();
      await admin.send("Target.activateTarget", { targetId: target });
      // Playwright's own client cannot read this page either (#41397).
      offered = setup.pages().find((p) => !p.url().startsWith("chrome"))!;
    } else {
      offered = await setup.newPage();
      await offered.goto(server.url.href);
      await offered.bringToFront();
      const offeredCDP = await setup.newCDPSession(offered);
      target = (await offeredCDP.send("Target.getTargetInfo")).targetInfo
        .targetId;
      await offeredCDP.detach();
    }
    const popup = await openExtensionActionPopup(admin, id, target, setup);
    await popup.waitFor('!document.querySelector("#allow").disabled');
    await beforeOffer?.({ page: offered, popup });
    await popup.offer(join(dir, "offer-failed.png"));
    await popup.close();
    const connection = fixture.bridge.connections("fixture-member")[0];
    await connection.drain(connection.offered("fixture-agent")!);
    const owned = fixture.sessions(deadlineMs);
    sessions = owned;
    const setupBrowser = raw.browser;
    await run({
      origin: server.url.origin,
      dir,
      setupPage: offered,
      // The setup client is a second CDP client on the offered page.
      closeSetup: () => setupBrowser.close(),
      // Ends the agent's CDP client; the grant stays, as at a session end.
      stopClient: () => owned.stop(),
      act: async (body) => {
        const started = performance.now();
        const result = await owned.run("fixture-agent", body);
        const elapsed = Math.round(performance.now() - started);
        console.log(
          "Action:",
          JSON.stringify({
            action: body.action,
            ok: result.ok,
            code: result.ok ? undefined : result.code,
            elapsed,
          }),
        );
        return { result, elapsed };
      },
    });
  } finally {
    sessions?.stop();
    await raw?.close();
    fixture.stop();
    void server.stop(true);
    rmSync(join(dir, "profile"), { recursive: true, force: true });
    rmSync(join(dir, "extension"), { recursive: true, force: true });
  }
}

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a tab that shows a dialog before the offer fails fast with the reason, and is offered once the dialog closes",
  async () => {
    await withOfferedTab(
      () => html(`<!doctype html><title>Dialog</title><p id="text">ready</p>`),
      async ({ act }) => {
        const { read } = expectations(act);
        expect(await read("#text")).toBe("ready");
      },
      5000,
      async ({ page, popup }) => {
        // A listener keeps Playwright from dismissing the dialog itself.
        let opened!: (dialog: Dialog) => void;
        const shown = new Promise<Dialog>((resolve) => (opened = resolve));
        page.on("dialog", (dialog) => opened(dialog));
        await page.evaluate(() => {
          setTimeout(() => alert("open before the offer"), 0);
        });
        const dialog = await shown;
        const started = performance.now();
        await popup.click("#allow");
        const state = () =>
          popup.read<{ error: string; checked: boolean; status: string }>(
            '({error: document.querySelector("#error").textContent, checked: document.querySelector("#allow").checked, status: document.querySelector("#status").dataset.state})',
          );
        let seen = await state();
        while (!seen.error && performance.now() - started < 20_000) {
          await Bun.sleep(50);
          seen = await state();
        }
        const elapsed = performance.now() - started;
        console.log("Dialog offer:", JSON.stringify({ ...seen, elapsed }));
        // The reason names the dialog: the copy of the catalog key.
        expect(seen.error).toBe(translatorFor("en").t("browser.tabUnanswered"));
        expect(elapsed).toBeLessThan(ATTACH_ANSWER_MS + 3000);
        // The extension's connection stays (it used to drop at 30 s).
        expect(seen.status).toBe("connected");
        await popup.waitFor('!document.querySelector("#allow").checked');
        await dialog.dismiss();
      },
    );
  },
  60_000,
);

const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

// Task 69602671: every read on a LinkedIn tab failed with page_unanswered.
// Chrome had activated a prerendered page in the tab before the offer, so the
// tab's main frame id was not its target id, and Playwright never saw the
// main frame commit (microsoft/playwright#41397).
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a tab Chrome activated from a prerender before the offer answers every read",
  async () => {
    await withOfferedTab(
      (url) =>
        url.pathname === "/activated"
          ? html(
              `<!doctype html><title>Activated</title><p id="text">from the prerender</p>`,
            )
          : html(
              `<!doctype html><title>Start</title><script type="speculationrules">{"prerender":[{"source":"list","urls":["/activated"],"eagerness":"immediate"}]}</script><script>setTimeout(() => { location.href = "/activated"; }, 2000)</script>`,
            ),
      async ({ act }) => {
        const { ok, read } = expectations(act);
        expect(await read("#text")).toBe("from the prerender");
        expect(ok(await act({ action: "snapshot" })).snapshot).toContain(
          "from the prerender",
        );
        const shot = ok(await act({ action: "screenshot" }));
        // The PNG signature.
        expect(shot.png!.subarray(1, 4).toString()).toBe("PNG");
      },
      DEADLINE_MS,
      undefined,
      { start: "/start", activated: "/activated" },
    );
  },
  60_000,
);

// Opens start in a new tab through a browser CDP client that attaches to no
// page, waits until Chrome has activated the prerendered page at activated in
// it, and returns the tab's target id. Throws unless the tab's main frame id
// differs from its target id, the condition of task 69602671.
async function prerenderedTab(
  endpoint: string,
  start: string,
  activated: string,
): Promise<string> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Prerender CDP socket failed"));
  });
  let next = 0;
  const waiting = new Map<number, (message: Fields) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Fields;
    if (typeof message.id === "number") waiting.get(message.id)?.(message);
  };
  const send = (method: string, params: Fields = {}, sessionId?: string) =>
    new Promise<Fields>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) =>
        message.error
          ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
          : resolve(message.result as Fields),
      );
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  try {
    const { targetId } = (await send("Target.createTarget", {
      url: start,
    })) as { targetId: string };
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { targetInfos } = (await send("Target.getTargets")) as {
        targetInfos: { targetId: string; url: string }[];
      };
      if (targetInfos.find((t) => t.targetId === targetId)?.url === activated)
        break;
      if (Date.now() >= deadline)
        throw new Error("The tab did not reach the activated page");
      await Bun.sleep(100);
    }
    const { sessionId } = (await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const { frameTree } = (await send("Page.getFrameTree", {}, sessionId)) as {
      frameTree: { frame: { id: string } };
    };
    await send("Target.detachFromTarget", { sessionId });
    if (frameTree.frame.id === targetId)
      throw new Error("Chrome did not activate a prerendered page in the tab");
    return targetId;
  } finally {
    socket.close();
  }
}

type Timed = { result: BrowserResult; elapsed: number };
const DEADLINE_MS = 5000;

// A fake DNS editor with the patterns of the Namecheap Advanced DNS page:
// javascript:void(0) links, a hidden native select under a styled trigger, a
// listbox appended to the body that picks in a window pointerdown listener,
// and native confirm dialogs. All content is fake.
const DNS_PAGE = `<!doctype html><title>Advanced DNS</title>
<style>.list{position:absolute;background:#fff;border:1px solid #888;margin:0;padding:0;list-style:none}.list li{padding:2px 8px;cursor:pointer}.wrap{position:relative;display:inline-block}</style>
<table><tr id="row"><td>www</td>
<td><select id="ttl" style="display:none">
<option value="60">1 min</option><option value="300">5 min</option>
<option value="1800">30 min</option><option value="3600" selected>Automatic</option>
</select><a href="javascript:void(0);" id="ttl-trigger">Automatic</a></td>
<td><a href="javascript:void(0);" id="cancel">Cancel</a>
<a href="javascript:void(0);" id="remove">Remove</a></td></tr></table>
<p><button id="double">Remove twice</button>
<span class="wrap"><button id="covered">Covered</button><span style="position:absolute;inset:0"></span></span>
<span class="wrap"><button id="hover-target">Hover target</button><button id="hover-cover" hidden style="position:absolute;inset:0">Cover</button></span>
<button id="busy">Busy</button>
<a href="/next" id="next">Next</a> <a href="/heavy" id="heavy">Heavy</a> <a href="/first" id="chain">Chain</a></p>
<p><select id="locked" disabled><option value="a">A</option><option value="b">B</option></select>
<fieldset disabled><select id="fenced"><option value="a">A</option><option value="b">B</option></select></fieldset>
<select id="empty"><option value="x" selected>X</option><option value="">None</option><option value="z" disabled>Z</option></select>
<select id="options"><option value="x" selected>X</option><option value="a" label="  A  B  ">Visible</option><option value="dup" disabled>Dup off</option><option value="dup">Dup on</option><option>  Te&nbsp; xt  </option><option value="e" label="">Empty label</option></select>
<select id="scripted"><option value="x" selected>X</option></select></p>
<output id="status">editing</output> <output id="ttl-change"></output> <output id="clicks"></output>
<script>
const $ = (id) => document.getElementById(id);
const select = $("ttl");
const log = (text) => ($("clicks").textContent += text + ";");
select.addEventListener("change", () => {
  $("ttl-trigger").textContent = select.selectedOptions[0].textContent;
  $("ttl-change").textContent += "change:" + select.value + ";";
});
$("cancel").addEventListener("click", (event) => {
  $("status").textContent = "cancelled trusted=" + event.isTrusted;
});
$("remove").addEventListener("click", () => {
  if (confirm("Remove this record?")) {
    $("row").remove();
    $("status").textContent = "removed";
  }
});
$("double").addEventListener("click", () => {
  const first = confirm("First?");
  const second = confirm("Second?");
  $("status").textContent = "first=" + first + " second=" + second;
});
$("covered").addEventListener("click", () => log("covered"));
$("hover-target").addEventListener("mouseover", () => ($("hover-cover").hidden = false));
$("hover-target").addEventListener("click", () => log("target"));
$("hover-cover").addEventListener("click", () => log("cover"));
$("busy").addEventListener("click", () => {
  if (!confirm("Proceed?")) return;
  const until = Date.now() + 7000;
  while (Date.now() < until);
  log("busy");
});
$("ttl-trigger").addEventListener("click", () => {
  if (document.querySelector(".list")) return;
  const list = document.createElement("ul");
  list.className = "list";
  list.setAttribute("role", "listbox");
  for (const option of select.options) {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    list.append(item);
  }
  const box = $("ttl-trigger").getBoundingClientRect();
  list.style.left = box.left + "px";
  list.style.top = box.bottom + "px";
  document.body.append(list);
});
// Picks before any later listener sees the pointer, then closes the list.
addEventListener("pointerdown", (event) => {
  const item = event.target.closest && event.target.closest(".list [role=option]");
  if (!item) return;
  select.value = item.dataset.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  item.parentElement.remove();
}, true);
</script>`;

function expectations(act: (body: Record<string, unknown>) => Promise<Timed>) {
  const ok = (timed: Timed) => {
    expect(timed.result).toMatchObject({ ok: true });
    return timed.result as Extract<BrowserResult, { ok: true }>;
  };
  const failed = (timed: Timed) => {
    expect(timed.result).toMatchObject({ ok: false });
    return timed.result as Extract<BrowserResult, { ok: false }>;
  };
  const read = async (selector: string) =>
    ok(await act({ action: "text", selector })).text;
  return { ok, failed, read };
}

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "clicks, listboxes and dialogs on a Namecheap-like page return their real outcome",
  async () => {
    await withOfferedTab(
      () => html(DNS_PAGE),
      async ({ dir, act, setupPage, closeSetup }) => {
        const { ok, failed, read } = expectations(act);
        // Another CDP client answers the dialog first, so the agent's answer
        // fails. The bridge holds the agent's answer back to make that order
        // certain. Before the fix Playwright left that rejection unhandled
        // and Bun ended the process (and this test).
        setupPage.on(
          "dialog",
          (dialog) => void dialog.dismiss().catch(() => {}),
        );
        type Dispatch = (...args: unknown[]) => Promise<void>;
        const bridge = ExtensionConnection.prototype as unknown as {
          dispatch: Dispatch;
        };
        const dispatch = bridge.dispatch;
        const held = spyOn(bridge, "dispatch").mockImplementation(
          async function (this: unknown, ...args: unknown[]) {
            if (JSON.stringify(args[1]).includes("Page.handleJavaScriptDialog"))
              await Bun.sleep(500);
            return dispatch.apply(this, args);
          },
        );
        let raced: Extract<BrowserResult, { ok: true }>;
        try {
          raced = ok(
            await act({
              action: "click",
              selector: "#remove",
              dialog: "accept",
            }),
          );
        } finally {
          held.mockRestore();
        }
        expect(raced.dialogs).toEqual([
          { type: "confirm", message: "Remove this record?", accepted: false },
        ]);
        expect(await read("#status")).toBe("editing");
        await closeSetup();

        // A javascript:void(0) link settles at once, and the next action runs.
        const cancel = await act({ action: "click", selector: "#cancel" });
        expect(ok(cancel).loading).toBeUndefined();
        expect(cancel.elapsed).toBeLessThan(DEADLINE_MS / 2);
        expect(await read("#status")).toBe("cancelled trusted=true");

        // The open custom listbox is in the snapshot, and a click on an
        // option that picks on pointerdown returns ok (it used to time out).
        ok(await act({ action: "click", selector: "#ttl-trigger" }));
        const open = ok(await act({ action: "snapshot" })).snapshot!;
        expect(open).toContain("- listbox:");
        for (const name of ["1 min", "5 min", "30 min", "Automatic"])
          expect(open).toContain(`- option "${name}"`);
        const option = await act({
          action: "click",
          selector: 'role=listbox >> role=option[name="5 min"]',
        });
        ok(option);
        expect(option.elapsed).toBeLessThan(DEADLINE_MS / 2);
        // One change event: the pick ran once and was not retried.
        expect(await read("#ttl-change")).toBe("change:300;");
        const picked = ok(await act({ action: "screenshot" }));
        writeFileSync(join(dir, "option-picked.png"), picked.png!);
        expect(ok(await act({ action: "snapshot" })).snapshot).not.toContain(
          "listbox",
        );

        // Dialogs: dismissed by default, and an accept covers the first only.
        const dismissed = ok(
          await act({ action: "click", selector: "#remove" }),
        );
        expect(dismissed.dialogs).toEqual([
          { type: "confirm", message: "Remove this record?", accepted: false },
        ]);
        expect(await read("#status")).toBe("cancelled trusted=true");
        const accepted = ok(
          await act({ action: "click", selector: "#double", dialog: "accept" }),
        );
        expect(accepted.dialogs).toEqual([
          { type: "confirm", message: "First?", accepted: true },
          { type: "confirm", message: "Second?", accepted: false },
        ]);
        expect(await read("#status")).toBe("first=true second=false");

        // A covered element: actionability never passes, no input is sent, and
        // the next action runs at once.
        const covered = failed(
          await act({ action: "click", selector: "#covered" }),
        );
        expect(covered.code).toBe("action_failed");
        expect(covered.error).toContain(CLICK_REASON.covered);
        const next = await act({ action: "snapshot" });
        ok(next);
        expect(next.elapsed).toBeLessThan(DEADLINE_MS / 2);
        expect(await read("#clicks")).toBe("");
        const absent = failed(
          await act({ action: "click", selector: "#absent" }),
        );
        expect(absent.code).toBe("action_failed");
        expect(absent.error).toContain(CLICK_REASON.missing);

        // The target changes between the check and the dispatch: hover shows
        // a cover over it. The result is ok because the click was dispatched
        // at the target's position after it passed actionability. Playwright
        // saw the cover take the pointer and blocked the click, so neither
        // element received it.
        ok(await act({ action: "click", selector: "#hover-target" }));
        expect(await read("#clicks")).toBe("");
        expect(ok(await act({ action: "snapshot" })).snapshot).toContain(
          'button "Cover"',
        );
        const gap = ok(await act({ action: "screenshot" }));
        writeFileSync(join(dir, "hover-cover.png"), gap.png!);

        console.log("Interaction evidence: " + dir);
      },
      DEADLINE_MS,
    );
  },
  120_000,
);

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "selects and navigations on a Namecheap-like page return their real outcome",
  async () => {
    let releaseImage!: () => void;
    const imageHeld = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    let releaseSlow!: () => void;
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowStarted = false;
    await withOfferedTab(
      async (url) => {
        if (url.pathname === "/next")
          return html("<title>Next</title><p>Next page</p>");
        if (url.pathname === "/heavy")
          return html('<title>Heavy</title><img src="/held.png">');
        // The image keeps load past the settle's first quiet window.
        if (url.pathname === "/first")
          return html(
            '<title>First</title><img src="/late.png"><script>onload = () => (location.href = "/slow")</script>',
          );
        if (url.pathname === "/late.png") {
          await Bun.sleep(800);
          return new Response(null, { status: 404 });
        }
        if (url.pathname === "/slow") {
          slowStarted = true;
          await slowHeld;
          return html("<title>Slow</title>");
        }
        if (url.pathname === "/held.png") {
          await imageHeld;
          return new Response(null, { status: 404 });
        }
        return html(DNS_PAGE);
      },
      async ({ origin, dir, act, setupPage, closeSetup }) => {
        const { ok, failed, read } = expectations(act);
        // Direct Playwright on the same select, for parity with the office
        // action below (it waits on a disabled first match or a label that
        // Chrome reports as empty).
        const nbsp = "Te\u00a0 xt";
        // Options whose text has a script and a style descendant. Chrome's
        // option.text leaves out the script text and keeps the style text.
        await setupPage.locator("#scripted").evaluate((select) => {
          const add = (...parts: (string | [string, string])[]) => {
            const option = document.createElement("option");
            for (const part of parts)
              if (typeof part === "string")
                option.append(document.createTextNode(part));
              else {
                const child = document.createElement(part[0]);
                if (child instanceof HTMLScriptElement)
                  child.type = "application/json";
                child.textContent = part[1];
                option.append(child);
              }
            select.append(option);
          };
          add("A", ["script", "ignored"], "B");
          add("C", ["style", "s"], "D");
        });
        const direct = async (option: { value: string } | { label: string }) =>
          setupPage
            .selectOption("#options", option, { timeout: 1500 })
            .catch(() => "timeout");
        expect(await direct({ label: "  A  B  " })).toEqual(["a"]);
        expect(await direct({ label: "A B" })).toEqual(["a"]);
        expect(await direct({ label: nbsp })).toEqual([nbsp]);
        expect(await direct({ value: nbsp })).toEqual([nbsp]);
        const scripted = async (
          option: { value: string } | { label: string },
        ) => setupPage.selectOption("#scripted", option, { timeout: 1500 });
        expect(await scripted({ label: "AB" })).toEqual(["AB"]);
        expect(await scripted({ value: "AB" })).toEqual(["AB"]);
        expect(await scripted({ label: "CsD" })).toEqual(["CsD"]);
        await setupPage.selectOption("#scripted", "x");
        expect(await direct({ value: "dup" })).toBe("timeout");
        expect(await direct({ label: "Empty label" })).toBe("timeout");
        await setupPage.selectOption("#options", "x");

        await closeSetup();

        // The hidden native select, by value and by label.
        const byValue = ok(
          await act({ action: "select", selector: "#ttl", value: "1800" }),
        );
        expect(byValue.selected).toEqual(["1800"]);
        expect(await read("#ttl-change")).toBe("change:1800;");
        expect(await read("#ttl-trigger")).toBe("30 min");
        const byLabel = ok(
          await act({ action: "select", selector: "#ttl", label: "1 min" }),
        );
        expect(byLabel.selected).toEqual(["60"]);
        expect(await read("#ttl-trigger")).toBe("1 min");
        expect(
          ok(await act({ action: "select", selector: "#empty", value: "" }))
            .selected,
        ).toEqual([""]);
        // Known no-ops change nothing and leave no settling fence.
        const notSelected = [
          [{ selector: "#ttl", label: "2 min" }, SELECT_REASON.noOption],
          [{ selector: "#empty", value: "z" }, SELECT_REASON.optionDisabled],
          [
            { selector: "#options", value: "dup" },
            SELECT_REASON.optionDisabled,
          ],
          [
            { selector: "#options", label: "Empty label" },
            SELECT_REASON.noOption,
          ],
          [{ selector: "#locked", value: "b" }, SELECT_REASON.disabled],
          [{ selector: "#fenced", value: "b" }, SELECT_REASON.disabled],
          [{ selector: "#absent", value: "b" }, SELECT_REASON.missing],
        ] as const;
        const chosen = async (selector: string) =>
          ok(await act({ action: "snapshot", selector })).snapshot!.match(
            /option "([^"]*)"[^\n]* \[selected\]/,
          )?.[1];
        const options = async (option: Record<string, string>) =>
          act({ action: "select", selector: "#options", ...option });
        expect(ok(await options({ label: "  A  B  " })).selected).toEqual([
          "a",
        ]);
        expect(ok(await options({ label: "A B" })).selected).toEqual(["a"]);
        expect(ok(await options({ label: nbsp })).selected).toEqual([nbsp]);
        expect(ok(await options({ value: nbsp })).selected).toEqual([nbsp]);
        const scriptedSelect = async (option: Record<string, string>) =>
          act({ action: "select", selector: "#scripted", ...option });
        expect(ok(await scriptedSelect({ label: "AB" })).selected).toEqual([
          "AB",
        ]);
        expect(ok(await scriptedSelect({ value: "AB" })).selected).toEqual([
          "AB",
        ]);
        expect(ok(await scriptedSelect({ label: "CsD" })).selected).toEqual([
          "CsD",
        ]);
        const scriptedBefore = await chosen("#scripted");
        ok(await options({ value: "x" }));
        // An option with a script descendant makes the read-only check
        // inconclusive, so selectOption decides: with no match it waits to
        // the deadline and the outcome stays unknown, with the usual fence.
        const unread = failed(await scriptedSelect({ value: "nomatch" }));
        expect(unread.code).toBe("action_timeout");
        for (let i = 0; i < 20; i++) {
          if ((await act({ action: "text", selector: "#status" })).result.ok)
            break;
          await Bun.sleep(250);
        }
        for (const [body, reason] of notSelected) {
          const refused = failed(await act({ action: "select", ...body }));
          expect(refused.code).toBe("action_failed");
          expect(refused.error).toContain(reason);
        }
        expect(await read("#ttl-trigger")).toBe("1 min");
        expect(await chosen("#locked")).toBe("A");
        expect(await chosen("#fenced")).toBe("A");
        expect(await chosen("#empty")).toBe("None");
        expect(await chosen("#options")).toBe("X");
        expect(await chosen("#scripted")).toBe(scriptedBefore);

        // A real navigation: the result names the page it landed on.
        const landed = ok(await act({ action: "click", selector: "#next" }));
        expect(landed.url).toBe(origin + "/next");
        expect(landed.title).toBe("Next");
        expect(landed.loading).toBeUndefined();
        // A navigation that does not finish loading by the deadline.
        ok(await act({ action: "goto", url: origin + "/" }));
        const heavy = ok(await act({ action: "click", selector: "#heavy" }));
        expect(heavy.loading).toBe(true);
        expect(heavy.url).toBe(origin + "/heavy");
        releaseImage();
        // The page that a click opens navigates again from its load handler:
        // the second navigation is still pending at the deadline.
        ok(await act({ action: "goto", url: origin + "/" }));
        const chain = ok(await act({ action: "click", selector: "#chain" }));
        expect(slowStarted).toBe(true);
        expect(chain.loading).toBe(true);

        // Input that does not complete by the deadline keeps an unknown
        // outcome, and the next action is fenced and dispatches nothing.
        // This goto also replaces the pending navigation before its release.
        ok(await act({ action: "goto", url: origin + "/" }));
        releaseSlow();
        const busy = failed(
          await act({ action: "click", selector: "#busy", dialog: "accept" }),
        );
        expect(busy.code).toBe("action_timeout");
        // The failure keeps the dialog that its action accepted.
        expect(busy.dialogs).toEqual([
          { type: "confirm", message: "Proceed?", accepted: true },
        ]);
        const fenced = await act({ action: "click", selector: "#cancel" });
        expect(failed(fenced).code).toBe("action_timeout");
        expect(fenced.elapsed).toBeLessThan(1500);
        let recovered: Timed | undefined;
        for (let i = 0; i < 20; i++) {
          recovered = await act({ action: "text", selector: "#clicks" });
          if (recovered.result.ok) break;
          await Bun.sleep(500);
        }
        expect(ok(recovered!).text).toBe("busy;");
        expect(await read("#status")).toBe("editing");

        const shot = ok(await act({ action: "screenshot" }));
        writeFileSync(join(dir, "final.png"), shot.png!);
        console.log("Interaction evidence: " + dir);
      },
      DEADLINE_MS,
    );
  },
  120_000,
);

const SLOW_SWITCH_MS = 700;

// Settings switches with the pattern of the Discord developer portal: a native
// input[role=switch] under a styled cover inside its label, so that a human
// click on the cover toggles it. The other controls cover the failure paths.
const SWITCH_PAGE = `<!doctype html><title>Bot</title>
<style>.sw{position:relative;display:inline-block;width:40px;height:24px;margin:4px}
.sw input{position:absolute;inset:0;margin:0}
.sw .cover{position:absolute;inset:0;background:#5865f2;border-radius:12px}</style>
<p><label class="sw"><input type="checkbox" role="switch" id="intent" aria-label="Message Content Intent"><span class="cover" id="intent-cover"></span></label>
<label class="sw"><input type="checkbox" role="switch" id="on" aria-label="Presence Intent" checked><span class="cover"></span></label>
<label class="sw"><input type="checkbox" role="switch" id="locked" aria-label="Locked" disabled><span class="cover"></span></label>
<span role="switch" id="aria-locked" aria-label="Aria locked" aria-checked="false" aria-disabled="true" tabindex="0">Aria locked</span>
<span role="switch" id="aria" aria-label="Aria switch" aria-checked="false" tabindex="0">Aria switch</span>
<span role="switch" id="slow" aria-label="Slow switch" aria-checked="false" tabindex="0">Slow switch</span>
<span class="sw"><input type="checkbox" role="switch" id="dead" aria-label="Dead cover"><span class="cover" id="dead-cover"></span></span>
<span style="position:relative;display:inline-block"><span class="sw"><input type="checkbox" role="switch" id="bannered" aria-label="Under banner"></span><span id="banner" style="position:absolute;inset:0;background:#000"></span></span>
<span style="position:fixed;left:-200px;top:10px;width:40px;height:24px"><input type="checkbox" role="switch" id="offscreen" aria-label="Offscreen" style="position:absolute;inset:0;margin:0"></span>
<input type="radio" name="plan" id="plan-a" aria-label="Plan A" checked><input type="radio" name="plan" id="plan-b" aria-label="Plan B">
<input type="checkbox" id="hidden" style="display:none"><button id="plain">Plain</button></p>
<p><span id="pair" style="position:relative;display:inline-block;width:120px;height:24px"><span role="switch" id="lone" aria-label="Lone switch" aria-checked="false" tabindex="0" style="position:absolute;left:0;top:0;width:40px;height:24px">Lone</span><label class="sw" style="position:absolute;left:0;top:0;margin:0"><input type="checkbox" role="switch" id="neighbour" aria-label="Neighbour"><span class="cover" id="neighbour-cover"></span></label></span></p>
<div style="position:relative;height:60px"><div id="under" style="position:absolute;left:0;top:0;width:300px;height:60px"></div><iframe id="framed" src="/frame" style="position:absolute;left:300px;top:0;width:300px;height:60px;border:0"></iframe></div>
<output id="events"></output>
<script>
const $ = (id) => document.getElementById(id);
const log = (text) => ($("events").textContent += text + ";");
for (const input of document.querySelectorAll("input"))
  input.addEventListener("change", () => log("change:" + input.id + "=" + input.checked));
$("intent-cover").addEventListener("click", () => log("cover:intent"));
$("dead-cover").addEventListener("click", () => log("cover:dead"));
$("banner").addEventListener("click", () => log("banner"));
$("under").addEventListener("click", () => log("under"));
$("lone").addEventListener("click", () => log("click:lone"));
for (const id of ["aria", "aria-locked"])
  $(id).addEventListener("click", () => {
    log("click:" + id);
    if ($(id).getAttribute("aria-disabled") === "true") return;
    $(id).setAttribute("aria-checked", String($(id).getAttribute("aria-checked") !== "true"));
  });
// Sets its state only when its own request returns, like a Cloudflare switch.
$("slow").addEventListener("click", () => {
  log("click:slow");
  setTimeout(() => {
    log("flip:slow");
    $("slow").setAttribute("aria-checked", String($("slow").getAttribute("aria-checked") !== "true"));
  }, ${SLOW_SWITCH_MS});
});
addEventListener("pointerdown", () => log("pointerdown"), true);
</script>`;

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "check sets a covered styled switch that a click cannot reach",
  async () => {
    await withOfferedTab(
      (url) =>
        html(
          url.pathname === "/frame"
            ? // Fixed outside the frame's viewport, but inside the page's.
              '<input type="checkbox" role="switch" id="framed-switch" aria-label="Framed" style="position:fixed;left:-60px;top:10px;width:40px;height:20px;margin:0">'
            : SWITCH_PAGE,
        ),
      async ({ dir, act, setupPage }) => {
        const { ok, failed, read } = expectations(act);
        // Input commands that the office hands to the bridge.
        type Dispatch = (...args: unknown[]) => Promise<void>;
        const bridge = ExtensionConnection.prototype as unknown as {
          dispatch: Dispatch;
        };
        const dispatch = spyOn(bridge, "dispatch");
        const inputs = () =>
          dispatch.mock.calls.filter((args) =>
            JSON.stringify(args[1]).includes('"Input.'),
          ).length;
        const switches = async () =>
          ok(await act({ action: "snapshot" })).snapshot!;
        try {
          // The precondition: the cover is on top at the input's centre, and
          // the click fails as covered with no input.
          expect(
            await setupPage.evaluate(() => {
              const input = document.getElementById("intent")!;
              const box = input.getBoundingClientRect();
              return document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              )!.id;
            }),
          ).toBe("intent-cover");
          const before = inputs();
          const covered = failed(
            await act({ action: "click", selector: "#intent" }),
          );
          expect(covered.code).toBe("action_failed");
          expect(covered.error).toContain(CLICK_REASON.covered);
          expect(inputs()).toBe(before);
          expect(await switches()).not.toMatch(
            /switch "Message Content Intent" \[checked\]/,
          );

          // check turns it on at once: the forced click hits the cover, and
          // the label passes it to the input.
          const on = await act({ action: "check", selector: "#intent" });
          expect(ok(on).checked).toBe(true);
          expect(on.elapsed).toBeLessThan(DEADLINE_MS / 2);
          expect(inputs()).toBeGreaterThan(before);
          expect(await read("#events")).toBe(
            "pointerdown;cover:intent;change:intent=true;",
          );
          expect(await switches()).toMatch(
            /switch "Message Content Intent" \[checked\]/,
          );

          // Already in the wanted state: no input, the state is unchanged.
          for (const [selector, checked] of [
            ["#intent", true],
            ["#on", true],
            ["#plan-a", true],
          ] as const) {
            const quiet = inputs();
            expect(
              ok(await act({ action: "check", selector, checked })).checked,
            ).toBe(checked);
            expect(inputs()).toBe(quiet);
          }
          expect(await read("#events")).toBe(
            "pointerdown;cover:intent;change:intent=true;",
          );

          // Off again, and a switch with only ARIA state.
          expect(
            ok(
              await act({
                action: "check",
                selector: "#intent",
                checked: false,
              }),
            ).checked,
          ).toBe(false);
          expect(
            ok(
              await act({
                action: "check",
                selector: 'role=switch[name="Aria switch"]',
              }),
            ).checked,
          ).toBe(true);
          const events = await read("#events");
          expect(events).toContain("change:intent=false;");
          expect(events).toContain("click:aria;");

          // Refusals before any input: disabled (native and ARIA), hidden,
          // missing, not checkable, and an uncheck of a radio button.
          for (const [body, reason] of [
            [{ selector: "#locked" }, CHECK_REASON.disabled],
            [{ selector: "#aria-locked" }, CHECK_REASON.disabled],
            [{ selector: "#hidden" }, CHECK_REASON.hidden],
            [{ selector: "#absent" }, CHECK_REASON.missing],
            [{ selector: "#plain" }, CHECK_REASON.notCheckable],
            [{ selector: "#plan-a", checked: false }, CHECK_REASON.radio],
          ] as const) {
            const quiet = inputs();
            const refused = failed(await act({ action: "check", ...body }));
            expect(refused.code).toBe("action_failed");
            expect(refused.error).toContain(reason);
            expect(inputs()).toBe(quiet);
          }
          expect(await read("#events")).toBe(events);
          const snapshot = await switches();
          expect(snapshot).toMatch(/switch "Locked" \[disabled\]/);
          expect(snapshot).not.toMatch(/switch "Locked" \[checked\]/);
          expect(snapshot).not.toMatch(/switch "Aria locked" \[checked\]/);

          // A cover that does not belong to the control, and a centre with
          // no element: refused before any input.
          for (const [selector, hit, reason] of [
            ["#bannered", "banner", CHECK_REASON.covered],
            ["#offscreen", null, CHECK_REASON.outside],
          ] as const) {
            expect(
              await setupPage.locator(selector).evaluate((input) => {
                const box = input.getBoundingClientRect();
                return (
                  document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                  )?.id ?? null
                );
              }),
            ).toBe(hit);
            const quiet = inputs();
            const refused = failed(await act({ action: "check", selector }));
            expect(refused.code).toBe("action_failed");
            expect(refused.error).toContain(reason);
            expect(inputs()).toBe(quiet);
          }
          expect(await read("#events")).toBe(events);

          // A parent that also holds another control is not the control's
          // own wrapper: the other control's cover is refused.
          expect(
            await setupPage.locator("#lone").evaluate((lone) => {
              const box = lone.getBoundingClientRect();
              return document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              )!.id;
            }),
          ).toBe("neighbour-cover");
          const quietPair = inputs();
          const shared = failed(
            await act({ action: "check", selector: "#lone" }),
          );
          expect(shared.code).toBe("action_failed");
          expect(shared.error).toContain(CHECK_REASON.covered);
          expect(inputs()).toBe(quietPair);
          expect(await read("#events")).toBe(events);

          // No element at the centre inside the frame, where the forced click
          // would land on the page element under it.
          const frame = setupPage
            .frames()
            .find((child) => child.url().endsWith("/frame"))!;
          expect(
            await frame.locator("#framed-switch").evaluate((input) => {
              const box = input.getBoundingClientRect();
              return document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
            }),
          ).toBeNull();
          expect(
            await setupPage.evaluate(() => {
              const box = document
                .getElementById("framed")!
                .getBoundingClientRect();
              return document.elementFromPoint(box.left - 40, box.top + 20)!.id;
            }),
          ).toBe("under");
          const quietFrame = inputs();
          const framed = failed(
            await act({
              action: "check",
              framePath: [0],
              selector: "#framed-switch",
            }),
          );
          expect(framed.code).toBe("action_failed");
          expect(framed.error).toContain(CHECK_REASON.outside);
          expect(inputs()).toBe(quietFrame);
          expect(await read("#events")).toBe(events);

          // A cover in the control's parent takes the click but does not
          // pass it on: the state does not change, and the result says so.
          const unchanged = failed(
            await act({ action: "check", selector: "#dead" }),
          );
          expect(unchanged.code).toBe("action_failed");
          expect(unchanged.error).toContain(CHECK_REASON.unchanged);
          expect(await read("#events")).toBe(
            events + "pointerdown;cover:dead;",
          );
          const after = await switches();
          for (const name of [
            "Dead cover",
            "Under banner",
            "Offscreen",
            "Lone switch",
            "Neighbour",
            "Framed",
          ])
            expect(after).not.toContain(`switch "${name}" [checked]`);

          // The next action runs at once: no fence from an earlier check.
          const next = await act({ action: "check", selector: "#intent" });
          expect(ok(next).checked).toBe(true);
          expect(next.elapsed).toBeLessThan(DEADLINE_MS / 2);

          // A switch that sets its state after its own request returns: check
          // waits for the wanted state, in both directions, and clicks once.
          for (const wanted of [true, false]) {
            const seen = await read("#events");
            const slow = await act({
              action: "check",
              selector: "#slow",
              checked: wanted,
            });
            expect(ok(slow).checked).toBe(wanted);
            expect(slow.elapsed).toBeGreaterThanOrEqual(SLOW_SWITCH_MS);
            expect(await read("#events")).toBe(
              seen + "pointerdown;click:slow;flip:slow;",
            );
            expect(
              /switch "Slow switch" \[checked\]/.test(await switches()),
            ).toBe(wanted);
          }
        } finally {
          dispatch.mockRestore();
        }
        const shot = ok(await act({ action: "screenshot" }));
        writeFileSync(join(dir, "switches.png"), shot.png!);
        console.log("Interaction evidence: " + dir);
      },
      DEADLINE_MS,
    );
  },
  120_000,
);

const FRAME_TEXT = "Cross-site frame content";

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a cross-site frame stays readable and rendered across agent client sessions",
  async () => {
    await withOfferedTab(
      (url) => {
        const frame = `http://localhost:${url.port}/frame`;
        return html(
          url.pathname === "/frame"
            ? `<p>${FRAME_TEXT}</p>`
            : url.pathname === "/present"
              ? `<main>Shell</main><iframe src="${frame}"></iframe>`
              : url.pathname === "/later"
                ? `<main>Shell</main><script>setTimeout(() => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(frame)}; document.querySelector("main").append(f); }, 1500)</script>`
                : "<title>Start</title>",
        );
      },
      async ({ origin, act, setupPage, stopClient }) => {
        const { ok } = expectations(act);
        // Counts closes of the agent's bridge clients.
        let closes = 0;
        const prototype = ExtensionConnection.prototype as unknown as {
          assign: (...args: unknown[]) => { close(): void };
        };
        const original = prototype.assign;
        const assign = spyOn(prototype, "assign").mockImplementation(function (
          this: unknown,
          ...args: unknown[]
        ) {
          const client = original.apply(this, args);
          return {
            ...client,
            close() {
              closes++;
              client.close();
            },
          };
        });
        const waitFor = async (
          check: () => boolean | Promise<boolean>,
          what: string,
        ) => {
          const deadline = Date.now() + 8000;
          while (!(await check())) {
            if (Date.now() >= deadline) throw new Error(`Timed out: ${what}`);
            await Bun.sleep(100);
          }
        };
        const endClient = async () => {
          const before = closes;
          stopClient();
          await waitFor(() => closes > before, "agent client closed");
        };
        try {
          // A frame that attached under an earlier client.
          ok(await act({ action: "goto", url: `${origin}/present` }));
          await waitFor(
            async () =>
              ok(await act({ action: "text" })).text!.includes(FRAME_TEXT),
            "first client reads the frame",
          );
          await endClient();
          const again = ok(await act({ action: "text" })).text!;
          expect(again).toContain("framePath=[0]");
          expect(again).toContain(FRAME_TEXT);
          expect(
            ok(await act({ action: "text", framePath: [0] })).text,
          ).toContain(FRAME_TEXT);

          // A frame that starts while no agent client is connected.
          ok(await act({ action: "goto", url: `${origin}/later` }));
          await endClient();
          expect(setupPage.frames()).toHaveLength(1);
          await waitFor(
            () => setupPage.frames().length === 2,
            "frame inserted",
          );
          // The member's page renders it: nobody left it waiting.
          await waitFor(
            async () =>
              (
                await setupPage
                  .frames()[1]
                  .locator("body")
                  .innerText({ timeout: 500 })
                  .catch(() => "")
              ).includes(FRAME_TEXT),
            "frame renders for the member",
          );
          expect(ok(await act({ action: "text" })).text).toContain(FRAME_TEXT);
        } finally {
          assign.mockRestore();
        }
      },
    );
  },
  60_000,
);

// Task 6950c897: a dialog that opened while no agent client was connected
// blocked every command of the next client until the fence ceiling. Task
// 2088b38d: the office leaves such a dialog open for the member, with or
// without an agent client attached, and each action fails at once and lists
// it until the member answers it.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "an alert that opens while no action runs stays open for the member, and actions fail at once until they answer it",
  async () => {
    await withOfferedTab(
      () =>
        html(
          `<!doctype html><title>Later</title><button id="later">later</button><script>document.getElementById("later").onclick = () => setTimeout(() => alert("late alert"), 1000)</script>`,
        ),
      async ({ act, setupPage, stopClient }) => {
        const { ok, failed } = expectations(act);
        // The setup client stands in for the member: it holds each dialog
        // and answers only when told to. Its answer fails if the dialog is
        // no longer open.
        const held: Dialog[] = [];
        setupPage.on("dialog", (dialog) => void held.push(dialog));
        const events: string[] = [];
        const prototype = ExtensionConnection.prototype as unknown as {
          receive: (message: unknown) => void;
        };
        const original = prototype.receive;
        const receive = spyOn(prototype, "receive").mockImplementation(
          function (this: unknown, message: unknown) {
            const method = (message as { method?: unknown }).method;
            if (
              method === "Page.javascriptDialogOpening" ||
              method === "Page.javascriptDialogClosed"
            )
              events.push(method);
            return original.call(this, message);
          },
        );
        const until = async (done: () => boolean, what: string) => {
          const deadline = Date.now() + 5000;
          while (!done() && Date.now() < deadline) await Bun.sleep(50);
          expect({ what, done: done() }).toEqual({ what, done: true });
        };
        try {
          for (const [round, attached] of [true, false].entries()) {
            ok(await act({ action: "click", selector: "#later" }));
            if (!attached) stopClient();
            await until(() => held.length === round + 1, "alert opened");
            // Time for an answer the office should not send.
            await Bun.sleep(300);
            const blocked = await act({ action: "text" });
            expect({ attached, code: failed(blocked).code }).toEqual({
              attached,
              code: "action_failed",
            });
            expect(failed(blocked).dialogs).toEqual([
              { type: "alert", message: "late alert", accepted: false },
            ]);
            expect(blocked.elapsed).toBeLessThan(DEADLINE_MS / 5);
            // Still open: the member's answer succeeds.
            await held[round].dismiss();
            await until(
              () =>
                events.filter((e) => e === "Page.javascriptDialogClosed")
                  .length ===
                round + 1,
              "alert closed",
            );
            const after = ok(await act({ action: "text" }));
            expect(after.title).toBe("Later");
            expect(after.dialogs).toBeUndefined();
          }
        } finally {
          receive.mockRestore();
        }
      },
    );
  },
  60_000,
);

// Task 6950c897: facebook.com has a head title and SVG titles.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a selector that matches several elements fails with the count",
  async () => {
    await withOfferedTab(
      () =>
        html(
          `<!doctype html><title>Head</title><svg><title>One</title></svg><svg><title>Two</title></svg>`,
        ),
      async ({ act }) => {
        const { failed } = expectations(act);
        const result = failed(await act({ action: "text", selector: "title" }));
        expect(result.code).toBe("invalid_request");
        expect(result.error).toContain("3");
        expect(result.error).not.toContain("Head");
      },
    );
  },
  60_000,
);

// Task f63edd81: a scoped read whose selector matched nothing waited out the
// whole action deadline. The production deadline makes that wait visible.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a scoped read whose selector matches nothing fails fast, and one that matches soon still answers",
  async () => {
    await withOfferedTab(
      () =>
        html(
          `<!doctype html><title>Scoped</title><main id="main"><p>here</p></main><button id="arm">arm</button><script>document.getElementById("arm").onclick = () => setTimeout(() => { const p = document.createElement("p"); p.id = "late"; p.textContent = "late text"; document.body.append(p); }, 1000)</script>`,
        ),
      async ({ act }) => {
        const { ok, failed, read } = expectations(act);
        for (const action of ["snapshot", "text"]) {
          const missing = await act({
            action,
            selector: ".scaffold-layout__main >> nth=0",
          });
          const result = failed(missing);
          expect({ action, code: result.code }).toEqual({
            action,
            code: "action_failed",
          });
          expect(result.error).toContain(CLICK_REASON.missing);
          expect(missing.elapsed).toBeLessThan(SCOPED_READ_ATTACH_MS + 2000);
        }
        // Control stays on: the next reads on the tab answer.
        expect(await read("#main")).toBe("here");
        expect(ok(await act({ action: "snapshot" })).snapshot).toContain(
          "here",
        );
        // An element that appears 1 s after the call is waited for.
        ok(await act({ action: "click", selector: "#arm" }));
        const late = await act({ action: "text", selector: "#late" });
        expect(ok(late).text).toBe("late text");
        expect(late.elapsed).toBeLessThan(SCOPED_READ_ATTACH_MS + 2000);
      },
      BROWSER_ACTION_DEADLINE_MS,
    );
  },
  120_000,
);

// Task f63edd81: an extension message over the office's size cap refused the
// whole browser, which then stayed off until the member paired again. The
// service routes such a message to receiveOversized (its unit tests prove
// that); here a lower threshold stands in for the cap, so that a real read
// on a real tab crosses it.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a read whose answer is too large fails that read only, and control stays on",
  async () => {
    const threshold = 200_000;
    let armed = false;
    let oversized = 0;
    const connections = new Set<unknown>();
    const routed = new WeakSet<object>();
    const prototype = ExtensionConnection.prototype as unknown as {
      receive: (message: unknown) => void;
      receiveOversized: (message: unknown, bytes: number) => void;
    };
    const original = prototype.receive;
    const receive = spyOn(prototype, "receive").mockImplementation(function (
      this: typeof prototype,
      message: unknown,
    ) {
      connections.add(this);
      const bytes = Buffer.byteLength(JSON.stringify(message));
      // receiveOversized hands a trimmed event back to receive, which must
      // not route it there again (task a42c729b).
      if (armed && bytes > threshold && !routed.has(message as object)) {
        routed.add(message as object);
        oversized++;
        return this.receiveOversized(message, bytes);
      }
      return original.call(this, message);
    });
    try {
      await withOfferedTab(
        () =>
          html(
            `<!doctype html><title>Large</title><p id="small">small</p><pre id="big">${"large text ".repeat(40_000)}</pre>`,
          ),
        async ({ act }) => {
          const { failed, read } = expectations(act);
          armed = true;
          const large = await act({ action: "text" });
          const result = failed(large);
          // The condition: the answer did cross the threshold.
          expect(oversized).toBeGreaterThan(0);
          expect(result.code).toBe("action_failed");
          expect(result.error).toBe(ANSWER_TOO_LARGE_ERROR);
          // At once: a retry gets the same answer, so none is made.
          expect(large.elapsed).toBeLessThan(DEADLINE_MS / 2);
          // The same tab answers the next read, on the same connection.
          expect(await read("#small")).toBe("small");
          expect(connections.size).toBe(1);
        },
      );
    } finally {
      receive.mockRestore();
    }
  },
  60_000,
);

// Task 694e958e: the office's socket ends the whole connection, and so every
// offered tab, for a frame over its payload limit, before the bridge sees it.
// The fixture's limit is EXTENSION_MAX_BYTES, under Bun's default in the
// office: a real read whose answer crosses it must fail alone.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a read whose answer is over the socket's payload limit fails that read only, and the connection stays",
  async () => {
    const closes = spyOn(ExtensionConnection.prototype, "close");
    try {
      await withOfferedTab(
        () =>
          html(
            `<!doctype html><title>Over the limit</title><p id="small">small</p><pre id="big">${"x".repeat(EXTENSION_MAX_BYTES + 1024 * 1024)}</pre>`,
          ),
        async ({ act }) => {
          const { failed, read } = expectations(act);
          // The enabling condition: the tab answers on this connection.
          expect(await read("#small")).toBe("small");
          const large = await act({ action: "text" });
          const result = failed(large);
          expect(result.code).toBe("action_failed");
          expect(result.error).toBe(ANSWER_TOO_LARGE_ERROR);
          expect(closes).toHaveBeenCalledTimes(0);
          // The same tab answers the next read, on the same connection.
          expect(await read("#small")).toBe("small");
          expect(closes).toHaveBeenCalledTimes(0);
        },
      );
    } finally {
      closes.mockRestore();
    }
  },
  60_000,
);

// Task f6dc01e6: a tab an agent drove painted black in the member's Chrome.
// Two captures of one tab in flight leave Chrome's capture emulation on, so
// the window shows a frozen or empty view; the bridge freed a stuck capture
// with a second one. The check reads the window's pixels on the X display,
// not a CDP capture: a capture sets its own emulation and looks right.
const ROWS = 40;
const ROW_PX = 600;
const rowColor = (i: number) => [
  (i * 53 + 17) % 256,
  (i * 97 + 71) % 256,
  (i * 29 + 133) % 256,
];
const packed = ([r, g, b]: number[]) => (r << 16) | (g << 8) | b;

// The count of each colour in an X screenshot of the whole display.
function displayColours(file: string): Map<number, number> {
  const shot = Bun.spawnSync(["scrot", "-o", file]);
  if (shot.exitCode !== 0) throw new Error(`scrot failed: ${shot.stderr}`);
  const ppm = readFileSync(file);
  // P6, then width, height and maxval; a # starts a comment line.
  const fieldsFound: number[] = [];
  let at = 2;
  while (fieldsFound.length < 3) {
    while (/\s/.test(String.fromCharCode(ppm[at]))) at++;
    if (ppm[at] === 0x23) {
      while (ppm[at] !== 0x0a) at++;
      continue;
    }
    const start = at;
    while (!/\s/.test(String.fromCharCode(ppm[at]))) at++;
    fieldsFound.push(Number(ppm.subarray(start, at).toString()));
  }
  at++;
  const counts = new Map<number, number>();
  for (let p = at; p + 2 < ppm.length; p += 3) {
    const colour = (ppm[p] << 16) | (ppm[p + 1] << 8) | ppm[p + 2];
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }
  return counts;
}

// Whether the member's window paints the tab's current scroll position: the
// rows in view fill most of the viewport, and no row out of view shows.
async function windowPaints(page: Page, file: string) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await Bun.sleep(500);
  const view = await page.evaluate(() => ({
    y: scrollY,
    height: innerHeight,
    width: document.documentElement.clientWidth,
  }));
  const counts = displayColours(file);
  let painted = 0;
  const stale: number[] = [];
  for (let i = 0; i < ROWS; i++) {
    const seen = counts.get(packed(rowColor(i))) ?? 0;
    const inView =
      i * ROW_PX < view.y + view.height && (i + 1) * ROW_PX > view.y;
    if (inView) painted += seen;
    else if (seen) stale.push(i);
  }
  return {
    filled: painted >= 0.8 * view.width * view.height,
    stale,
  };
}

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "an agent's screenshots free a stuck capture with no second capture, and the member's window keeps painting the tab",
  async () => {
    const colours = new Set(
      Array.from({ length: ROWS }, (_, i) => packed(rowColor(i))),
    );
    // Each row colour is its own, so a count names one row.
    expect(colours.size).toBe(ROWS);
    await withOfferedTab(
      (url) =>
        url.pathname === "/idle"
          ? html(`<!doctype html><title>Idle</title><p>idle</p>`)
          : html(
              `<!doctype html><title>Rows</title><body style="margin:0">${Array.from(
                { length: ROWS },
                (_, i) =>
                  `<div style="height:${ROW_PX}px;background:rgb(${rowColor(i).join(",")})"></div>`,
              ).join("")}</body>`,
            ),
      async ({ act, dir, origin, setupPage }) => {
        const { ok } = expectations(act);
        const context = setupPage.context();
        const worker = context
          .serviceWorkers()
          .find((w) => w.url().endsWith("/background.js"))!;
        expect(worker).toBeDefined();
        // Records what reaches Chrome: the screencast commands, and the most
        // captures of one tab in flight at once.
        await worker.evaluate(() => {
          type Target = { tabId: number; sessionId?: string };
          const g = globalThis as unknown as {
            chrome: {
              debugger: {
                sendCommand(
                  target: Target,
                  method: string,
                  params?: unknown,
                ): Promise<unknown>;
              };
            };
            captureLog: {
              inFlight: Record<string, number>;
              most: number;
              captures: number;
              starts: number;
              stops: number;
            };
          };
          const log = {
            inFlight: {} as Record<string, number>,
            most: 0,
            captures: 0,
            starts: 0,
            stops: 0,
          };
          g.captureLog = log;
          const send = g.chrome.debugger.sendCommand.bind(g.chrome.debugger);
          g.chrome.debugger.sendCommand = async (target, method, params) => {
            if (method === "Page.startScreencast") log.starts++;
            if (method === "Page.stopScreencast") log.stops++;
            if (method !== "Page.captureScreenshot")
              return send(target, method, params);
            const key = `${target.tabId}/${target.sessionId ?? ""}`;
            log.captures++;
            log.inFlight[key] = (log.inFlight[key] ?? 0) + 1;
            log.most = Math.max(log.most, log.inFlight[key]);
            try {
              return await send(target, method, params);
            } finally {
              log.inFlight[key]--;
            }
          };
        });
        const readLog = async () => {
          // A kick's stop goes out after the answer.
          await Bun.sleep(300);
          return worker.evaluate(() => {
            const g = globalThis as unknown as {
              captureLog: {
                inFlight: Record<string, number>;
                most: number;
                captures: number;
                starts: number;
                stops: number;
              };
            };
            const log = { ...g.captureLog };
            Object.assign(g.captureLog, {
              most: 0,
              captures: 0,
              starts: 0,
              stops: 0,
            });
            return {
              most: log.most,
              captures: log.captures,
              starts: log.starts,
              stops: log.stops,
            };
          });
        };
        const height = (png: Buffer) => png.readUInt32BE(20);

        // The instrument: the window paints the tab before any capture.
        await setupPage.evaluate(() => scrollTo(0, 2600));
        const before = await windowPaints(
          setupPage,
          join(dir, "window-before.ppm"),
        );

        // The agent's tab in the background, behind an idle tab that draws
        // nothing: Chrome leaves its captures unanswered.
        await setupPage.evaluate(() => scrollTo(0, 400));
        // In the agent tab's own window: Chrome on Linux keeps painting a tab
        // that is in front of another window.
        await worker.evaluate(async (site) => {
          const tabs = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(q: object): Promise<{ windowId: number }[]>;
                  create(p: object): Promise<unknown>;
                };
              };
            }
          ).chrome.tabs;
          const [agentTab] = await tabs.query({ url: site + "/" });
          await tabs.create({
            windowId: agentTab.windowId,
            url: site + "/idle",
            active: true,
          });
        }, origin);
        // The extension's focus emulation keeps the page's visibilityState
        // visible, so the tab's own state is the check.
        expect(
          await worker.evaluate(async (site) => {
            const tabs = (
              globalThis as unknown as {
                chrome: {
                  tabs: { query(q: object): Promise<{ active: boolean }[]> };
                };
              }
            ).chrome.tabs;
            return (await tabs.query({ url: site + "/" })).map((t) => t.active);
          }, origin),
        ).toEqual([false]);
        await Bun.sleep(500);
        const viewport = ok(await act({ action: "screenshot" }));
        const full = ok(await act({ action: "screenshot", fullPage: true }));
        const hidden = await readLog();
        await setupPage.bringToFront();
        await setupPage.evaluate(() => scrollTo(0, 1600));
        const afterHidden = await windowPaints(
          setupPage,
          join(dir, "window-after-hidden.ppm"),
        );

        // The tab in front: a long full-page capture outlasts the kick delay.
        await setupPage.evaluate(() => scrollTo(0, 400));
        const visibleFull = ok(
          await act({ action: "screenshot", fullPage: true }),
        );
        const visible = await readLog();
        await setupPage.evaluate(() => scrollTo(0, 5000));
        const afterVisible = await windowPaints(
          setupPage,
          join(dir, "window-after-visible.ppm"),
        );
        console.log(
          "Capture kicks:",
          JSON.stringify({
            before,
            hidden,
            afterHidden,
            visible,
            afterVisible,
          }),
        );

        expect(before).toEqual({ filled: true, stale: [] });
        expect(height(viewport.png!)).toBeLessThan(ROW_PX * 3);
        expect(height(full.png!)).toBe(ROWS * ROW_PX);
        expect(height(visibleFull.png!)).toBe(ROWS * ROW_PX);
        expect({
          // The enabling conditions: each capture needed a kick.
          hiddenKicked: hidden.starts > 0 || hidden.captures > 2,
          visibleKicked: visible.starts > 0 || visible.captures > 1,
          // Every kick ends.
          hiddenStops: hidden.stops,
          visibleStops: visible.stops,
          hiddenMost: hidden.most,
          visibleMost: visible.most,
          afterHidden,
          afterVisible,
        }).toEqual({
          hiddenKicked: true,
          visibleKicked: true,
          hiddenStops: hidden.starts,
          visibleStops: visible.starts,
          hiddenMost: 1,
          visibleMost: 1,
          afterHidden: { filled: true, stale: [] },
          afterVisible: { filled: true, stale: [] },
        });
      },
      15_000,
    );
  },
  90_000,
);

// The pixels of a Chrome screenshot: 8-bit RGB or RGBA, not interlaced.
function decodePng(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = { 2: 3, 6: 4 }[png[25]];
  if (png[24] !== 8 || png[28] !== 0 || !channels)
    throw new Error("Unexpected PNG format");
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x >= channels ? out[at - channels] : 0;
      const b = y > 0 ? out[at - stride] : 0;
      const c = x >= channels && y > 0 ? out[at - stride - channels] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error("Unexpected PNG filter");
      out[at] = v & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x: number, y: number) => {
      const at = (y * width + x) * channels;
      return [out[at], out[at + 1], out[at + 2]];
    },
  };
}

// Task 03cc142c: Playwright sends the clip in CSS px and Chrome reads it in
// DIPs, so in a tab with page zoom (Cmd +) a screenshot showed only the
// top-left part of the view.
const BANDS = 30;
const BAND_PX = 100;
const bandColor = (i: number) => [
  (i * 83 + 20) % 256,
  (i * 47 + 90) % 256,
  (i * 151 + 40) % 256,
];
const MARK = [255, 0, 255];

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "an agent's screenshots of a zoomed, scrolled tab show the whole view and the whole page",
  async () => {
    const colours = new Set(
      [...Array.from({ length: BANDS }, (_, i) => bandColor(i)), MARK].map(
        packed,
      ),
    );
    expect(colours.size).toBe(BANDS + 1);
    await withOfferedTab(
      () =>
        html(
          `<!doctype html><title>Zoom</title><style>html{scrollbar-width:none}body{margin:0}</style><body>${Array.from(
            { length: BANDS },
            (_, i) =>
              `<div style="height:${BAND_PX}px;background:rgb(${bandColor(i).join(",")})"></div>`,
          ).join(
            "",
          )}<div style="position:fixed;right:0;bottom:0;width:40px;height:40px;background:rgb(${MARK.join(",")})"></div></body>`,
        ),
      async ({ act, origin, setupPage }) => {
        const { ok } = expectations(act);
        const worker = setupPage
          .context()
          .serviceWorkers()
          .find((w) => w.url().endsWith("/background.js"))!;
        expect(worker).toBeDefined();
        const ratio = () => setupPage.evaluate(() => devicePixelRatio);
        const unzoomed = await ratio();
        // Chrome's page zoom, as the member's Cmd + sets it.
        await worker.evaluate(async (site) => {
          const tabs = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(q: object): Promise<{ id: number }[]>;
                  setZoom(tabId: number, factor: number): Promise<void>;
                };
              };
            }
          ).chrome.tabs;
          const [tab] = await tabs.query({ url: site + "/" });
          await tabs.setZoom(tab.id, 1.5);
        }, origin);
        const deadline = Date.now() + 5000;
        while ((await ratio()) === unzoomed && Date.now() < deadline)
          await Bun.sleep(50);
        await setupPage.evaluate(() => scrollTo(0, 1050));

        const shot = decodePng(ok(await act({ action: "screenshot" })).png!);
        // Read after the shot: Chrome lays out the debugger bar late, so a
        // read before it can see a taller view (task 138f617b).
        const view = await setupPage.evaluate(() => ({
          y: scrollY,
          width: innerWidth,
          height: innerHeight,
          ratio: devicePixelRatio,
        }));
        // The enabling conditions: the tab draws at 150% and is scrolled.
        expect(view.ratio).toBeCloseTo(unzoomed * 1.5, 5);
        expect(view.y).toBeCloseTo(1050, 0);
        const full = decodePng(
          ok(await act({ action: "screenshot", fullPage: true })).png!,
        );
        console.log(
          "Zoomed shots:",
          JSON.stringify({
            view,
            shot: [shot.width, shot.height],
            full: [full.width, full.height],
          }),
        );
        const near = (got: number, want: number) =>
          Math.abs(got - want) <= 1 ? want : got;
        const band = (cssY: number) => bandColor(Math.floor(cssY / BAND_PX));
        expect({
          // The view in device pixels.
          width: near(shot.width, view.width * view.ratio),
          height: near(shot.height, view.height * view.ratio),
          // Its top edge is the scrolled-to band; the corner mark is in.
          topLeft: shot.pixel(5, 5),
          bottomRight: shot.pixel(shot.width - 5, shot.height - 5),
        }).toEqual({
          width: view.width * view.ratio,
          height: view.height * view.ratio,
          topLeft: band(view.y + 5 / view.ratio),
          bottomRight: MARK,
        });
        expect({
          height: near(full.height, BANDS * BAND_PX * view.ratio),
          top: full.pixel(5, 5),
          bottom: full.pixel(5, full.height - 5),
        }).toEqual({
          height: BANDS * BAND_PX * view.ratio,
          top: bandColor(0),
          bottom: bandColor(BANDS - 1),
        });
      },
      DEADLINE_MS,
    );
  },
  60_000,
);
