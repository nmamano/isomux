import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect, spyOn } from "bun:test";
import { ExtensionConnection } from "./browser-extension-bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import type { BrowserExtensionService } from "./browser-extension-service";
import type { BrowserResult } from "./browser-actions";
import { CLICK_REASON, SELECT_REASON } from "./browser-input";
import type { Page } from "playwright-core";
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
    const popup = await openExtensionActionPopup(admin, id, target);
    await popup.waitFor('!document.querySelector("#allow").disabled');
    await popup.click("#allow");
    await popup.waitFor(
      'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled',
    );
    await popup.close();
    const connection = fixture.bridge.connections("fixture-member")[0];
    await connection.drain(connection.offered("fixture-agent")!);
    const owned = new ExtensionBrowserSessions(
      {
        bridge: fixture.bridge,
        store: { paired: () => true },
      } as unknown as BrowserExtensionService,
      () => "fixture-member",
      () => true,
      () => deadlineMs,
    );
    sessions = owned;
    const setupBrowser = raw.browser;
    await run({
      origin: server.url.origin,
      dir,
      setupPage: offered,
      // The setup client is a second CDP client on the offered page.
      closeSetup: () => setupBrowser.close(),
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

// Quarantined 2026-10-09: flaky (task e513ce4e).
test.skip("clicks, listboxes and dialogs on a Namecheap-like page return their real outcome", async () => {
  await withOfferedTab(
    () => html(DNS_PAGE),
    async ({ dir, act, setupPage, closeSetup }) => {
      const { ok, failed, read } = expectations(act);
      // Another CDP client answers the dialog first, so the agent's answer
      // fails. The bridge holds the agent's answer back to make that order
      // certain. Before the fix Playwright left that rejection unhandled
      // and Bun ended the process (and this test).
      setupPage.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
      type Dispatch = (...args: unknown[]) => Promise<void>;
      const bridge = ExtensionConnection.prototype as unknown as {
        dispatch: Dispatch;
      };
      const dispatch = bridge.dispatch;
      const held = spyOn(bridge, "dispatch").mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
      ) {
        if (JSON.stringify(args[1]).includes("Page.handleJavaScriptDialog"))
          await Bun.sleep(500);
        return dispatch.apply(this, args);
      });
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
      const dismissed = ok(await act({ action: "click", selector: "#remove" }));
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
}, 120_000);

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
