import { MAX_BROWSER_UPLOAD_BYTES } from "./browser-upload";
import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { BROWSER_ACTION_DEADLINE_MS } from "./browser-actions";
import { test, expect, spyOn } from "bun:test";
import { ExtensionConnection } from "./browser-extension-bridge";
import { fields } from "../shared/browser-extension-protocol";
import { type BrowserContext } from "playwright-core";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTestServer, type TestServer } from "./test-support/harness";
import {
  memberRequest,
  ownedAgent,
} from "./test-support/browser-extension-route-fixture";
import { buildPublicOrigin } from "./auth";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { translatorFor } from "../shared/i18n/translate";
import { getAgentTokenRaw } from "./identity/tokens";

const wait = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await Bun.sleep(50);
  }
  throw new Error("Extension did not connect");
};
async function runOfficeScenario(framesOnly: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-extension-office-"));
  let setup: BrowserContext | undefined;
  let raw: Awaited<ReturnType<typeof launchRawExtensionChrome>> | undefined;
  let office: TestServer | undefined;
  let site: ReturnType<typeof Bun.serve> | undefined;
  let popup: Awaited<ReturnType<typeof openExtensionActionPopup>> | undefined;
  const frameEvents = { attached: 0, navigated: 0 };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the exact connection as this.
  const originalReceive = ExtensionConnection.prototype.receive;
  const traceFrames = spyOn(
    ExtensionConnection.prototype,
    "receive",
  ).mockImplementation(function (this: ExtensionConnection, message) {
    const m = fields(message);
    if (
      m.kind === "event" &&
      m.method === "Target.attachedToTarget" &&
      fields(fields(m.params).targetInfo).type === "iframe"
    )
      frameEvents.attached++;
    if (m.kind === "event" && m.method === "Page.frameNavigated")
      frameEvents.navigated++;
    return originalReceive.call(this, message);
  });
  try {
    expect(BROWSER_ACTION_DEADLINE_MS).toBe(30_000);
    let actionDeadline = BROWSER_ACTION_DEADLINE_MS;
    office = await startTestServer({
      startServer: { browserExtensionActionDeadline: () => actionDeadline },
    });
    const owner = await office.seedOwner();
    const first = await ownedAgent(office, owner, "first");
    const second = await ownedAgent(office, owner, "second");
    const action = async (id: string, body: unknown, tokenId = id) => {
      const started = performance.now();
      const response = await office!.http(`/api/agents/${id}/browser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getAgentTokenRaw(tokenId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      console.log(
        "Fixture action:",
        JSON.stringify({
          action: fields(body).action,
          status: response.status,
          code: result.error?.code,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      return { status: response.status, body: result };
    };
    raw = await launchRawExtensionChrome(dir);
    setup = raw.browser.contexts()[0];
    const { t } = translatorFor("en");
    const officeOrigin = buildPublicOrigin().origin;
    await setup.addCookies([
      {
        name: "isomux_session",
        value: owner.rawSessionId,
        url: officeOrigin,
      },
    ]);
    const settings = await setup.newPage();
    await settings.goto(officeOrigin + "/settings");
    await settings.bringToFront();
    await settings
      .getByRole("button", { name: t("browser.title"), exact: true })
      .click();
    expect(await settings.getByTestId("browser-backend").count()).toBe(0);
    expect(
      (await action(first.id, { action: "goto", url: "http://localhost/" }))
        .body.error.code,
    ).toBe("browser_not_paired");
    const downloadPath = await settings
      .locator('a[download="isomux-browser.zip"]')
      .getAttribute("href");
    const download = await memberRequest(office, owner, "GET", downloadPath!);
    expect(download.status).toBe(200);
    writeFileSync(
      join(dir, "isomux-browser.zip"),
      Buffer.from(await download.arrayBuffer()),
    );
    expect(
      Bun.spawnSync([
        "unzip",
        "-q",
        join(dir, "isomux-browser.zip"),
        "-d",
        join(dir, "extension"),
      ]).exitCode,
    ).toBe(0);
    await settings.getByTestId("browser-pair").click();
    const code = await settings.getByTestId("browser-code").inputValue();
    const setupCDP = await setup.browser()!.newBrowserCDPSession();
    const { id } = await setupCDP.send("Extensions.loadUnpacked", {
      path: join(dir, "extension"),
    });
    const openPopup = async (targetId?: string) => {
      if (!targetId) {
        const session = await setup!.newCDPSession(settings);
        targetId = (await session.send("Target.getTargetInfo")).targetInfo
          .targetId;
        await session.detach();
      }
      popup = await openExtensionActionPopup(setupCDP, id, targetId);
      return popup;
    };
    popup = await openPopup();
    await popup.fill("#office", officeOrigin);
    await popup.fill("#code", code);
    expect(
      await popup.read<number>('document.querySelector("#code").value.length'),
    ).toBe(43);
    expect(
      await popup.read<string>('document.querySelector("#office").value'),
    ).toBe(officeOrigin);
    await popup.click("#pair");
    try {
      await popup.waitFor(
        'document.querySelector("#status").dataset.state === "connected"',
      );
    } catch (error) {
      await popup.read('document.querySelector("#code").type = "password"');
      await popup.screenshot(join(dir, "pairing-failed.png"));
      console.log(
        "Pairing state:",
        await popup.read(
          '({state:document.querySelector("#status").dataset.state,error:document.querySelector("#error").textContent})',
        ),
      );
      console.log("Extension evidence:", dir);
      throw error;
    }
    expect(
      await popup.read<string>('document.querySelector("#member").textContent'),
    ).toContain(owner.username);
    await popup.screenshot(join(dir, "extension-connected.png"));
    await popup.close();
    await settings.bringToFront();
    await settings
      .locator('[data-testid="browser-state"][data-online="true"]')
      .waitFor();
    // Do not preserve a pairing code in evidence, even after redemption.
    await settings.getByTestId("browser-code").evaluate((element) => {
      (element as HTMLInputElement).value = "[redeemed]";
    });
    await settings.screenshot({ path: join(dir, "settings-connected.png") });
    let releaseNavigation!: () => void;
    let navigationReached!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      navigationReached = resolve;
    });
    const navigationHeld = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    site = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/held-navigation") {
          navigationReached();
          await navigationHeld;
          return new Response(
            "<title>Late document</title><p id=late>Late navigation</p>",
            { headers: { "Content-Type": "text/html" } },
          );
        }
        const html =
          url.pathname === "/nested"
            ? '<p>Nested frame content</p><button id="nested" onclick="this.textContent=\'Nested clicked\'">Nested action</button>'
            : url.pathname === "/popup"
              ? '<title>Popup</title><button onclick="window.close()">Return</button>'
              : url.pathname === "/frame"
                ? framesOnly
                  ? `<h2>Frame contents</h2><label>Frame field<input></label><button id="frame-apply" onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply frame</button><button id="other-frame-action">Other action</button><output>Frame ready</output>${url.hostname === "localhost" ? '<iframe src="/nested"></iframe>' : ""}`
                  : "<label>Frame field<input></label>"
                : `<title>Main</title><input type="file" id="attachment" oninput="this.dataset.input=String(Number(this.dataset.input||0)+1)" onchange="this.dataset.change=String(Number(this.dataset.change||0)+1)"><input type="file" id="other-attachment"><input id="hidden-timeout" hidden><input id="readonly-timeout" readonly><label>Message<input id="message"></label><button id="open" onclick="window.open('/popup')">Open</button><output id="out"></output><button id="apply" onclick="document.querySelector('#out').textContent=document.querySelector('#message').value; document.querySelector('#out').dataset.trusted=String(event.isTrusted)">Apply</button><iframe src="/frame"></iframe><iframe src="http://127.0.0.1:${url.port}/frame"></iframe>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    const url = `http://localhost:${site.port}/main`;
    expect(
      (await action(first.id, { action: "snapshot" })).body.error.code,
    ).toBe("browser_control_ended");
    const firstPage = await setup.newPage();
    await firstPage.goto(url);
    const secondPage = await setup.newPage();
    await secondPage.goto(url + "?second");
    const targetOf = async (page: import("playwright-core").Page) => {
      const session = await setup!.newCDPSession(page);
      const target = (await session.send("Target.getTargetInfo")).targetInfo
        .targetId;
      await session.detach();
      return target;
    };
    const firstTarget = await targetOf(firstPage);
    const secondTarget = await targetOf(secondPage);
    const offeredTabIds = new Map<string, number>();
    const offer = async (
      page: import("playwright-core").Page,
      agentId: string,
      durationMinutes = 0,
    ) => {
      await page.bringToFront();
      popup = await openPopup(await targetOf(page));
      await popup.waitFor(
        `!!document.querySelector('#agent option[value="${agentId}"]')`,
      );
      await popup.read(
        `(() => { const picker = document.querySelector('#agent'); picker.value = ${JSON.stringify(agentId)}; picker.dispatchEvent(new Event('change')); })()`,
      );
      try {
        await popup.waitFor('!document.querySelector("#allow").disabled');
      } catch (error) {
        console.log(
          "Offer state:",
          await popup.read(
            `chrome.runtime.sendMessage({action:'state'}).then(s => ({state:s.state,currentTab:s.currentTab,agents:s.agents.length,assignments:s.assignments.length,picker:document.querySelector('#agent').value,help:document.querySelector('#tab-state').textContent}))`,
          ),
        );
        await popup.screenshot(join(dir, "offer-failed.png"));
        console.log("Extension evidence:", dir);
        throw error;
      }
      expect(
        await popup.read<string>('document.querySelector("#expiry").value'),
      ).toBe("0");
      await popup.read(
        `document.querySelector("#expiry").value = ${JSON.stringify(String(durationMinutes))}`,
      );
      await popup.click("#allow");
      await popup.waitFor(
        'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled',
      );
      expect(
        await popup.read<boolean>('document.querySelector("#expiry").disabled'),
      ).toBe(true);
      const expiresAt = await popup.read<number | null>(
        `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => (a.scope.kind === "all" ? "all" : a.scope.agentId) === ${JSON.stringify(agentId)}).expiresAt)`,
      );
      offeredTabIds.set(
        agentId,
        await popup.read<number>(
          `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => (a.scope.kind === "all" ? "all" : a.scope.agentId) === ${JSON.stringify(agentId)}).tabId)`,
        ),
      );
      if (expiresAt !== null)
        expect(
          await popup.read<string>(
            'document.querySelector("#expiry-state").textContent',
          ),
        ).toContain(
          await popup.read<string>(`new Date(${expiresAt}).toLocaleString()`),
        );
      await popup.close();
      return expiresAt;
    };
    const firstExpiresAt = await offer(firstPage, first.id, 15);
    expect(firstExpiresAt).toBeNumber();
    if (firstExpiresAt === null) throw new Error("Timed offer has no deadline");
    expect(
      (await action(first.id, { action: "snapshot" })).body.snapshot,
    ).toContain("textbox");
    await secondPage.bringToFront();
    popup = await openPopup(secondTarget);
    await popup.waitFor(
      `!!document.querySelector('#agent option[value="${first.id}"]')`,
    );
    await popup.read(
      `(() => { const p = document.querySelector('#agent'); p.value = ${JSON.stringify(first.id)}; p.dispatchEvent(new Event('change')); })()`,
    );
    expect(
      await popup.read<boolean>('document.querySelector("#allow").disabled'),
    ).toBe(true);
    await popup.screenshot(join(dir, "extension-conflict.png"));
    await popup.close();
    await offer(secondPage, second.id);
    await settings.bringToFront();
    expect(
      (await action(first.id, { action: "goto", url: url + "?navigated" }))
        .status,
    ).toBe(200);
    expect(await targetOf(firstPage)).toBe(firstTarget);
    expect(firstPage.url()).toBe(url + "?navigated");
    const activeState = async () =>
      setup!
        .serviceWorkers()
        .find((w) => w.url() === `chrome-extension://${id}/background.js`)!
        .evaluate(async () => {
          const c = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(q: object): Promise<{ id: number; windowId: number }[]>;
                };
                windows: { getLastFocused(): Promise<{ id: number }> };
              };
            }
          ).chrome;
          return {
            tabs: (await c.tabs.query({ active: true })).map((t) => ({
              id: t.id,
              windowId: t.windowId,
            })),
            window: (await c.windows.getLastFocused()).id,
          };
        });
    const activeBefore = await activeState();
    if (framesOnly) {
      expect(
        (
          await action(first.id, {
            action: "fill",
            framePath: [0],
            selector: "input",
            text: "same",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await action(first.id, {
            action: "fill",
            framePath: [1],
            selector: "input",
            text: "cross",
          })
        ).status,
      ).toBe(200);
      for (const [index, value] of [
        [0, "same"],
        [1, "cross"],
      ] as const) {
        expect(
          (
            await action(first.id, {
              action: "click",
              framePath: [index],
              selector: "#frame-apply",
            })
          ).status,
        ).toBe(200);
        const frame = firstPage.mainFrame().childFrames()[index];
        expect(await frame.locator("output").innerText()).toBe(value);
      }
      expect(
        (
          await action(first.id, {
            action: "click",
            framePath: [0, 0],
            selector: "#nested",
          })
        ).status,
      ).toBe(200);
      expect(
        await firstPage
          .mainFrame()
          .childFrames()[0]
          .childFrames()[0]
          .locator("button")
          .innerText(),
      ).toBe("Nested clicked");
      expect(
        (
          await action(first.id, {
            action: "click",
            framePath: [99],
            selector: "button",
          })
        ).body.error.code,
      ).toBe("action_failed");
      expect(
        (
          await action(first.id, {
            action: "click",
            framePath: [0],
            selector: "button",
          })
        ).body.error.code,
      ).toBe("action_failed");
      expect(await activeState()).toEqual(activeBefore);
      const snapshot = await action(first.id, { action: "snapshot" });
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.snapshot).toContain("textbox");
      expect(snapshot.body.snapshot).toContain("framePath=[0]");
      expect(snapshot.body.snapshot).toContain("framePath=[1]");
      expect(snapshot.body.snapshot).toContain("Nested clicked");
      const frameText = await action(first.id, { action: "text" });
      expect(frameText.body.text).toContain("Frame contents");
      expect(frameText.body.text).toContain("framePath=[0,0]");
      expect(frameText.body.text).toContain("cross");
      expect(await firstPage.locator("body").innerText()).not.toContain(
        "Frame contents",
      );
      expect(firstPage.mainFrame().childFrames()).toHaveLength(2);
      expect(firstPage.mainFrame().childFrames()[0].childFrames()).toHaveLength(
        1,
      );
      expect(frameEvents.attached).toBeGreaterThan(0);
      expect(frameEvents.navigated).toBeGreaterThan(0);
      const ownCDP = await setup.newCDPSession(firstPage);
      const otherCDP = await setup.newCDPSession(secondPage);
      const ownTree = await ownCDP.send("Page.getFrameTree");
      const otherTree = await otherCDP.send("Page.getFrameTree");
      expect(
        await ownCDP
          .send("DOM.getFrameOwner", {
            frameId: otherTree.frameTree.childFrames![0].frame.id,
          })
          .then(
            () => false,
            () => true,
          ),
      ).toBe(true);
      expect(
        await ownCDP
          .send("DOM.getFrameOwner", { frameId: ownTree.frameTree.frame.id })
          .then(
            () => false,
            () => true,
          ),
      ).toBe(true);
      await ownCDP.detach();
      await otherCDP.detach();
      writeFileSync(
        join(dir, "frame-evidence.json"),
        JSON.stringify({
          frameEvents,
          paths: [[0], [0, 0], [1]],
          sameAndCrossClicks: true,
          foreignFrameRefused: true,
          activeUnchanged: true,
        }),
      );
      await firstPage.screenshot({ path: join(dir, "frame-controls.png") });
      console.log("Frame extension evidence:", dir);
      return;
    }
    const uploadPath = join(dir, "fixture-upload.png");
    const uploadBytes = Buffer.alloc(MAX_BROWSER_UPLOAD_BYTES);
    for (let i = 0; i < uploadBytes.length; i++) uploadBytes[i] = i % 256;
    const uploadRealPath = join(dir, "server-payload.bin");
    writeFileSync(uploadRealPath, uploadBytes);
    symlinkSync(uploadRealPath, uploadPath);
    const worker = setup
      .serviceWorkers()
      .find((w) => w.url() === `chrome-extension://${id}/background.js`)!;
    const badgeAfterNavigation = await worker.evaluate(
      async (tabIds) => {
        const c = (
          globalThis as unknown as {
            chrome: {
              action: {
                getBadgeText(details: { tabId: number }): Promise<string>;
              };
            };
          }
        ).chrome;
        return Promise.all(
          tabIds.map(async (tabId) => ({
            tabId,
            badge: await c.action.getBadgeText({ tabId }),
          })),
        );
      },
      [...offeredTabIds.values()],
    );
    console.log(
      "Owned badges after navigation:",
      JSON.stringify(badgeAfterNavigation),
    );
    expect(badgeAfterNavigation).toHaveLength(2);
    expect(badgeAfterNavigation.every((b) => b.badge === "ON")).toBe(true);
    await worker.evaluate(
      ({ paths, name }) => {
        const scope = globalThis as unknown as {
          chrome: {
            debugger: { sendCommand(...args: unknown[]): Promise<unknown> };
          };
          uploadProbe: {
            pathSeen: boolean;
            pathCommand: boolean;
            calls: number;
            maxBytes: number;
            hold: boolean;
            blocked: boolean;
            release?: () => void;
          };
        };
        const original = scope.chrome.debugger.sendCommand.bind(
          scope.chrome.debugger,
        );
        const probe: typeof scope.uploadProbe = (scope.uploadProbe = {
          pathSeen: false,
          pathCommand: false,
          calls: 0,
          maxBytes: 0,
          hold: false,
          blocked: false,
        });
        scope.chrome.debugger.sendCommand = async (...args) => {
          const encoded = JSON.stringify(args);
          probe.pathSeen ||= paths.some((path) => encoded.includes(path));
          probe.pathCommand ||= args[1] === "DOM.setFileInputFiles";
          probe.maxBytes = Math.max(
            probe.maxBytes,
            new TextEncoder().encode(encoded).length,
          );
          const payload = encoded.includes(name);
          if (payload) probe.calls++;
          const result = await original(...args);
          if (payload && probe.hold) {
            probe.blocked = true;
            await new Promise<void>((resolve) => {
              probe.release = resolve;
            });
          }
          return result;
        };
      },
      { paths: [uploadPath, uploadRealPath], name: "fixture-upload.png" },
    );
    const uploaded = await action(first.id, {
      action: "upload",
      selector: "#attachment",
      path: uploadPath,
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.uploaded).toEqual({
      name: "fixture-upload.png",
      mimeType: "image/png",
      size: uploadBytes.length,
    });
    expect(JSON.stringify(uploaded.body)).not.toContain(uploadPath);
    const fileState = await firstPage
      .locator("#attachment")
      .evaluate(async (element) => {
        const input = element as HTMLInputElement,
          file = input.files![0];
        const hash = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        return {
          name: file.name,
          type: file.type,
          size: file.size,
          hash: Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
          input: input.dataset.input,
          change: input.dataset.change,
        };
      });
    expect(fileState).toEqual({
      name: "fixture-upload.png",
      type: "image/png",
      size: uploadBytes.length,
      hash: new Bun.CryptoHasher("sha256").update(uploadBytes).digest("hex"),
      input: "1",
      change: "1",
    });
    const probe = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            uploadProbe: {
              pathSeen: boolean;
              pathCommand: boolean;
              maxBytes: number;
              calls: number;
            };
          }
        ).uploadProbe,
    );
    expect(probe.pathSeen).toBe(false);
    expect(probe.pathCommand).toBe(false);
    expect(probe.maxBytes).toBeLessThan(8 * 1024 * 1024);
    expect(probe.maxBytes).toBeGreaterThan(MAX_BROWSER_UPLOAD_BYTES);
    expect(probe.calls).toBe(1);
    expect(await activeState()).toEqual(activeBefore);
    expect(
      (
        await action(
          first.id,
          { action: "upload", selector: "#attachment", path: uploadPath },
          second.id,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await action(first.id, {
          action: "upload",
          selector: "input[type=file]",
          path: uploadPath,
        })
      ).body.error.code,
    ).toBe("action_failed");
    expect(
      await secondPage
        .locator("#attachment")
        .evaluate((element) => (element as HTMLInputElement).files!.length),
    ).toBe(0);
    writeFileSync(
      join(dir, "upload-evidence.json"),
      JSON.stringify({ fileState, probe }, null, 2),
    );
    expect((await action(first.id, { action: "text" }, second.id)).status).toBe(
      403,
    );
    expect(
      (
        await action(first.id, {
          action: "fill",
          selector: "#message",
          text: "first tab",
        })
      ).status,
    ).toBe(200);
    expect(
      (await action(first.id, { action: "click", selector: "#apply" })).status,
    ).toBe(200);
    expect(await activeState()).toEqual(activeBefore);
    expect(await firstPage.locator("#out").getAttribute("data-trusted")).toBe(
      "true",
    );
    await firstPage.screenshot({ path: join(dir, "inactive-click.png") });
    expect((await action(first.id, { action: "text" })).body.text).toContain(
      "first tab",
    );
    expect(
      (await action(second.id, { action: "text" })).body.text,
    ).not.toContain("first tab");
    expect(
      (
        await action(first.id, {
          action: "fill",
          selector: "iframe >> nth=0 >> internal:control=enter-frame >> input",
          text: "same",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await action(first.id, {
          action: "fill",
          selector: "iframe >> nth=1 >> internal:control=enter-frame >> input",
          text: "cross",
        })
      ).status,
    ).toBe(200);
    const snapshot = await action(first.id, { action: "snapshot" });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.snapshot).toContain("textbox");
    expect((await action(first.id, { action: "screenshot" })).status).toBe(200);
    expect(
      (await action(first.id, { action: "click", selector: "#open" })).status,
    ).toBe(200);
    await wait(
      async () =>
        (await action(first.id, { action: "text" })).body.title === "Popup",
    );
    const popupClose = await action(first.id, {
      action: "click",
      selector: "button",
    });
    if (popupClose.status !== 200)
      console.log("Fixture popup close error:", popupClose.body.error);
    expect(popupClose.status).toBe(200);
    expect((await action(first.id, { action: "text" })).body.title).toBe(
      "Main",
    );
    await worker.evaluate(() => {
      (
        globalThis as unknown as { uploadProbe: { hold: boolean } }
      ).uploadProbe.hold = true;
    });
    const pendingUpload = action(first.id, {
      action: "upload",
      selector: "#attachment",
      path: uploadPath,
    });
    await wait(() =>
      worker.evaluate(
        () =>
          (globalThis as unknown as { uploadProbe: { blocked: boolean } })
            .uploadProbe.blocked,
      ),
    );
    await firstPage.bringToFront();
    popup = await openPopup(firstTarget);
    await popup.waitFor('document.querySelector("#allow").checked');
    expect(
      await popup.read<boolean>('document.querySelector("#agent").disabled'),
    ).toBe(true);
    expect(
      await popup.read<string>(
        'document.querySelector("#agent").selectedOptions[0].textContent',
      ),
    ).toBe("first");
    const firstAssignment = await popup.read<{ id: string; tabId: number }>(
      `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => a.agent.id === ${JSON.stringify(first.id)}))`,
    );
    const badge = await popup.read<string>(
      `chrome.action.getBadgeText({ tabId: ${firstAssignment.tabId} })`,
    );
    expect(badge).toBe("ON");
    expect(
      await popup.read<number>(
        `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => a.agent.id === ${JSON.stringify(first.id)}).expiresAt)`,
      ),
    ).toBe(firstExpiresAt);
    await popup.screenshot(join(dir, "extension-control.png"));
    await popup.click("#allow");
    await popup.waitFor(
      '!document.querySelector("#allow").checked && !document.querySelector("#agent").disabled',
    );
    await popup.screenshot(join(dir, "extension-stopped.png"));
    expect(
      await popup.read<string>(
        `chrome.action.getBadgeText({ tabId: ${firstAssignment.tabId} })`,
      ),
    ).toBe("");
    expect(
      (await action(first.id, { action: "goto", url })).body.error.code,
    ).toBe("browser_control_ended");
    const interruptedUpload = await pendingUpload;
    expect(interruptedUpload.body.error.code).toBe("browser_control_ended");
    expect(interruptedUpload.body.error.message).toMatch(/unknown/i);
    await worker.evaluate(() => {
      (
        globalThis as unknown as { uploadProbe: { release?: () => void } }
      ).uploadProbe.release?.();
    });
    expect(
      (
        await action(first.id, {
          action: "upload",
          selector: "#attachment",
          path: uploadPath,
        })
      ).body.error.code,
    ).toBe("browser_control_ended");
    expect(
      await worker.evaluate(
        () =>
          (globalThis as unknown as { uploadProbe: { calls: number } })
            .uploadProbe.calls,
      ),
    ).toBe(2);
    expect(firstPage.isClosed()).toBe(false);
    expect(await targetOf(firstPage)).toBe(firstTarget);
    await firstPage.screenshot({ path: join(dir, "retained-page.png") });
    await popup.close();
    await worker.evaluate(() => {
      (
        globalThis as unknown as { uploadProbe: { hold: boolean } }
      ).uploadProbe.hold = false;
    });
    await offer(firstPage, first.id);
    expect((await action(first.id, { action: "snapshot" })).status).toBe(200);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as unknown as { uploadProbe: { calls: number } })
            .uploadProbe.calls,
      ),
    ).toBe(2);
    expect(
      await firstPage.locator("#attachment").getAttribute("data-change"),
    ).toBe("2");
    popup = await openPopup(firstTarget);
    await popup.click("#disconnect");
    await popup.waitFor(
      'document.querySelector("#status").dataset.state === "disabled"',
    );
    expect((await action(second.id, { action: "text" })).body.error.code).toBe(
      "browser_offline",
    );
    await popup.click("#reconnect");
    await popup.waitFor(
      'document.querySelector("#status").dataset.state === "connected"',
    );
    expect(
      (await action(second.id, { action: "goto", url })).body.error.code,
    ).toBe("browser_control_ended");
    await popup.close();
    await offer(secondPage, "all");
    const listed = (await action(first.id, { action: "tabs" })).body.tabs;
    expect(listed).toHaveLength(1);
    expect(listed[0].scope).toEqual({ kind: "all" });
    expect(
      (await action(first.id, { action: "snapshot", target: listed[0].target }))
        .status,
    ).toBe(200);
    expect((await action(second.id, { action: "snapshot" })).status).toBe(200);
    expect((await action(second.id, { action: "text" })).status).toBe(200);
    popup = await openPopup(secondTarget);
    const timeoutGrant = await popup.read<{
      id: string;
      expiresAt: number | null;
    }>(
      `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => a.scope.kind === "all"))`,
    );
    await popup.close();
    for (const selector of [
      "#missing-timeout-fixture",
      "#hidden-timeout",
      "#readonly-timeout",
    ]) {
      actionDeadline = 150;
      expect(
        (await action(second.id, { action: "fill", selector, text: "unused" }))
          .body.error.code,
      ).toBe("action_timeout");
      actionDeadline = 3000;
      expect((await action(second.id, { action: "snapshot" })).status).toBe(
        200,
      );
      expect(
        (
          await action(second.id, {
            action: "fill",
            selector: "#message",
            text: "after timeout",
          })
        ).status,
      ).toBe(200);
      expect(
        (await action(second.id, { action: "click", selector: "#apply" }))
          .status,
      ).toBe(200);
      expect(await secondPage.locator("#out").innerText()).toBe(
        "after timeout",
      );
    }
    const beforeNavigationURL = secondPage.url();
    actionDeadline = 150;
    const navigation = action(second.id, {
      action: "goto",
      url: `http://localhost:${site.port}/held-navigation`,
    });
    await navigationStarted;
    expect((await navigation).body.error.code).toBe("action_timeout");
    actionDeadline = 3000;
    expect(
      (
        await action(second.id, {
          action: "fill",
          selector: "#message",
          text: "after stopped navigation",
        })
      ).status,
    ).toBe(200);
    releaseNavigation();
    await Bun.sleep(250);
    expect(secondPage.url()).toBe(beforeNavigationURL);
    expect(await secondPage.locator("#message").inputValue()).toBe(
      "after stopped navigation",
    );
    expect((await action(second.id, { action: "snapshot" })).status).toBe(200);
    popup = await openPopup(secondTarget);
    expect(
      await popup.read(
        `chrome.runtime.sendMessage({ action: 'state' }).then(s => s.assignments.find(a => a.scope.kind === "all"))`,
      ),
    ).toMatchObject({
      id: timeoutGrant.id,
      expiresAt: timeoutGrant.expiresAt,
      phase: "on",
    });
    expect(
      await popup.read<boolean>('document.querySelector("#allow").checked'),
    ).toBe(true);
    await popup.screenshot(join(dir, "extension-timeout-retained.png"));
    await popup.close();
    await offer(firstPage, "all");
    const choices = (await action(first.id, { action: "tabs" })).body.tabs;
    expect(choices).toHaveLength(2);
    expect(
      (await action(first.id, { action: "snapshot" })).body.error.code,
    ).toBe("browser_target_required");
    const extra = choices.find(
      (t: { target: string }) => t.target !== listed[0].target,
    );
    expect(extra).toBeDefined();
    expect(
      (
        await action(second.id, {
          action: "fill",
          selector: "#message",
          text: "explicit first tab",
          target: extra.target,
        })
      ).status,
    ).toBe(200);
    expect(await firstPage.locator("#message").inputValue()).toBe(
      "explicit first tab",
    );
    expect(await secondPage.locator("#message").inputValue()).toBe(
      "after stopped navigation",
    );
    expect(
      (await action(first.id, { action: "snapshot", target: listed[0].target }))
        .status,
    ).toBe(200);
    await secondPage.bringToFront();
    popup = await openPopup(secondTarget);
    await popup.waitFor(
      'document.querySelector("#status").dataset.state === "connected"',
    );
    await popup.screenshot(join(dir, "extension-all-control.png"));
    await popup.click("#unpair");
    await popup.waitFor(
      'document.querySelector("#status").dataset.state === "unpaired"',
    );
    expect(
      (
        await (
          await memberRequest(office, owner, "GET", "/api/me/browser")
        ).json()
      ).paired,
    ).toBe(false);
    await popup.screenshot(join(dir, "extension-unpaired.png"));
    writeFileSync(
      join(dir, "evidence.json"),
      JSON.stringify({
        date: "2026-09-19",
        packaged: true,
        member: owner.username,
        agents: ["first", "second"],
        actionPopup: true,
        badge,
        retainedTabs: 2,
        disconnectReconnect: true,
        unpaired: true,
      }),
    );
    console.log("Extension evidence:", dir);
    expect((await action(second.id, { action: "text" })).body.error.code).toBe(
      "browser_not_paired",
    );
  } finally {
    traceFrames.mockRestore();
    await popup?.close();
    await raw?.close();
    await office?.stop();
    await site?.stop(true);
    rmSync(join(dir, "profile"), { recursive: true, force: true });
  }
}

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "real office routes use paired Chrome, separate agents, frames and retained popup opener",
  () => runOfficeScenario(false),
  130_000,
);
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "packaged Chrome reads and controls owned same-origin, cross-origin and nested frames",
  () => runOfficeScenario(true),
  90_000,
);
