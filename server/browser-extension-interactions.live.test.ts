import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect, spyOn } from "bun:test";
import { ExtensionConnection } from "./browser-extension-bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import type { ExtensionBrowserSessions } from "./browser-extension-session";
import type { BrowserResult } from "./browser-actions";
import { CHECK_REASON, CLICK_REASON, SELECT_REASON } from "./browser-input";
import type { Dialog, Page } from "playwright-core";
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
    const setup = raw.browser.contexts()[0];
    const admin = await raw.browser.newBrowserCDPSession();
    const { id } = await admin.send("Extensions.loadUnpacked", {
      path: join(dir, "extension"),
    });
    const extensionPage = await setup.newPage();
    await extensionPage.goto("chrome-extension://" + id + "/connection.html");
    await extensionPage.evaluate(
      async (config) => {
        const extensionChrome = (
          globalThis as unknown as {
            chrome: {
              storage: { local: { set(value: unknown): Promise<void> } };
            };
          }
        ).chrome;
        await extensionChrome.storage.local.set({ connection: config });
      },
      {
        url: fixture.extensionURL,
        credential: fixture.credential,
        nonce: crypto.randomUUID(),
      },
    );
    const deadline = Date.now() + 5000;
    while (!fixture.bridge.connections("fixture-member")[0]) {
      if (Date.now() >= deadline)
        throw new Error("Fixture connection did not settle");
      await Bun.sleep(20);
    }
    const offered = await setup.newPage();
    await offered.goto(server.url.href);
    await offered.bringToFront();
    const offeredCDP = await setup.newCDPSession(offered);
    const target = (await offeredCDP.send("Target.getTargetInfo")).targetInfo
      .targetId;
    await offeredCDP.detach();
    const popup = await openExtensionActionPopup(admin, id, target, setup);
    await popup.waitFor('!document.querySelector("#allow").disabled');
    await popup.click("#allow");
    await popup.waitFor(
      // The switch is checked during offering, before the office accepts it.
      'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled && !!document.querySelector("#expiry-state").textContent',
    );
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

const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

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
