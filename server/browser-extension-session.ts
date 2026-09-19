import { BrowserUploadError, readBrowserUpload, type UploadedFile } from "./browser-upload";
import { chromium, type Browser, type Page } from "playwright-core";
import { browserExtensionTransport } from "./browser-extension-transport";
import type { BrowserExtensionService } from "./browser-extension-service";
import {
  BROWSER_ACTION_DEADLINE_MS,
  browserPool,
  parseBrowserParams,
  describeShot,
  MAX_TEXT_CHARS,
  MAX_SNAPSHOT_CHARS,
  type BrowserResult,
} from "./browser-session";

type Session = {
  member: string;
  signal: AbortSignal;
  browser: Browser;
  page: Page;
  pages: Page[];
  parents: Map<Page, Page>;
  opened: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const failure = (
  code:
    | "browser_selection_required"
    | "browser_not_paired"
    | "browser_offline"
    | "browser_control_ended"
    | "action_failed",
  error: string,
): BrowserResult => ({ ok: false, status: 500, code, error });
const ended = () =>
  failure(
    "browser_control_ended",
    "Browser control ended; pending outcomes may be unknown",
  );
const cap = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}\n[truncated at ${n} characters]` : s;

export class ExtensionBrowserSessions {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  constructor(
    private service: BrowserExtensionService,
    private owner: (agent: string) => string | undefined,
    private mayUse: (member: string, agent: string) => boolean,
    private actionDeadline: () => number = () => BROWSER_ACTION_DEADLINE_MS,
  ) {}
  private end(agent: string): void {
    const session = this.sessions.get(agent);
    if (!session) return;
    this.sessions.delete(agent);
    clearTimeout(session.timer);
    void session.browser.close().catch(() => {});
  }
  async endMember(member: string, agents: string[]): Promise<void> {
    this.epochs.set(member, (this.epochs.get(member) ?? 0) + 1);
    for (const [agent, session] of this.sessions)
      if (session.member === member) this.end(agent);
    await Promise.all(agents.map((agent) => browserPool.interrupt(agent)));
  }
  stop(): void {
    for (const agent of this.sessions.keys()) this.end(agent);
  }
  run(agent: string, body: unknown): Promise<BrowserResult> {
    const member = this.owner(agent);
    const epoch = member ? (this.epochs.get(member) ?? 0) : 0;
    const extensionSelected = !!member && this.service.store.record(member).backend === "extension";
    const queuedConnection = extensionSelected ? this.service.bridge.forMember(member) : undefined;
    const queuedGrant = queuedConnection?.offered(agent);
    const previous = this.queues.get(agent) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        if (
          this.owner(agent) !== member ||
          (member && (this.epochs.get(member) ?? 0) !== epoch)
        )
          return ended();
        if (member && this.service.store.record(member).backend === null)
          return failure(
            "browser_selection_required",
            "Browser selection is unavailable; select a browser backend again",
          );
        if (
          !member ||
          this.service.store.record(member).backend === "headless"
        ) {
          const result = await browserPool.run(agent, body, member ?? null);
          if (
            this.owner(agent) !== member ||
            (member && (this.epochs.get(member) ?? 0) !== epoch)
          ) {
            await browserPool.interrupt(agent);
            return ended();
          }
          return result;
        }
        if (!this.mayUse(member, agent)) return ended();
        if (extensionSelected && (this.service.bridge.forMember(member) !== queuedConnection ||
            queuedConnection?.offered(agent) !== queuedGrant)) return ended();
        return this.extensionAction(member, agent, body, epoch);
      });
    this.queues.set(agent, work);
    void work
      .finally(() => {
        if (this.queues.get(agent) === work) this.queues.delete(agent);
      })
      .catch(() => {});
    return work;
  }
  private async extensionAction(
    member: string,
    agent: string,
    body: unknown,
    epoch: number,
  ): Promise<BrowserResult> {
    const actionMs = this.actionDeadline();
    const params = parseBrowserParams(body);
    if (!params.ok) return params;
    if (params.action === "close") {
      this.end(agent);
      this.service.bridge.forMember(member)?.revoke(agent);
      return { ok: true, url: "", title: "", closed: true };
    }
    if (!this.service.store.record(member).hash)
      return failure("browser_not_paired", "No Chrome browser is paired");
    const connection = this.service.bridge.forMember(member);
    if (!connection)
      return failure("browser_offline", "The Chrome browser is offline");
    let session = this.sessions.get(agent);
    if (
      session &&
      (!session.browser.isConnected() || session.member !== member)
    ) {
      this.end(agent);
      session = undefined;
    }
    const grant = connection.offered(agent);
    if (!grant) return failure("browser_control_ended", "Open the Chrome extension popup on an HTTP(S) tab, choose this agent, and turn on Allow agent control");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transport: ReturnType<typeof browserExtensionTransport> | undefined;
    let timedOut = false;
    let interrupt!: (result: BrowserResult) => void;
    const interrupted = new Promise<BrowserResult>(resolve => { interrupt = resolve; });
    let watched: AbortSignal | undefined;
    const onEnd = () => {
      timedOut = true;
      this.end(agent);
      interrupt(ended());
    };
    const watchEnd = (signal: AbortSignal) => {
      watched = signal;
      signal.addEventListener("abort", onEnd, { once: true });
      if (signal.aborted) onEnd();
    };
    if (session) watchEnd(session.signal);
    const valid = () =>
      this.owner(agent) === member &&
      this.mayUse(member, agent) &&
      this.service.store.record(member).backend === "extension" &&
      (this.epochs.get(member) ?? 0) === epoch &&
      this.service.bridge.forMember(member) === connection &&
      connection.offered(agent) === grant;
    const task = async (): Promise<BrowserResult> => {
      if (!session) {
        transport = browserExtensionTransport(connection, agent);
        watchEnd(transport.signal);
        const browser = await chromium.connectOverCDP(transport, {
          noDefaults: true,
          timeout: actionMs,
        });
        if (!valid() || timedOut) {
          await browser.close();
          return ended();
        }
        const context = browser.contexts()[0];
        const page = context.pages()[0];
        if (!page) { await browser.close(); return ended(); }
        session = {
          member,
          signal: transport.signal,
          browser,
          page,
          pages: [page],
          parents: new Map(),
          opened: false,
        };
        const owned = session;
        this.sessions.set(agent, session);
        const adoptPopup = (popup: Page) => {
          // The bridge has already bound the popup to this assignment.
          owned.pages.push(popup);
          owned.page = popup;
          void popup.opener().then((opener) => {
            if (opener && owned.pages.includes(opener))
              owned.parents.set(popup, opener);
          });
          popup.on("close", () => {
            owned.pages = owned.pages.filter(
              (p) => p !== popup && !p.isClosed(),
            );
            if (owned.page !== popup && !owned.page.isClosed()) return;
            let parent = owned.parents.get(popup);
            while (parent?.isClosed()) parent = owned.parents.get(parent);
            owned.page = parent ?? page;
          });
        };
        for (const popup of context.pages().slice(1)) adoptPopup(popup);
        context.on("page", adoptPopup);
        browser.on("disconnected", () => {
          if (this.sessions.get(agent) === owned) {
            clearTimeout(owned.timer);
            this.sessions.delete(agent);
          }
        });
      }
      if (!valid() || timedOut) {
        this.end(agent);
        return ended();
      }
      clearTimeout(session.timer);
      const timeout = actionMs;
      const page = session.page;
      let uploaded: UploadedFile | undefined;
      switch (params.action) {
        case "goto":
          await page.goto(params.url!.toString(), {
            waitUntil: "load",
            timeout,
          });
          session.opened = true;
          break;
        case "click":
          await page.click(params.selector!, { timeout });
          break;
        case "fill":
          await page.fill(params.selector!, params.text!, { timeout });
          break;
        case "upload": {
          const file = await readBrowserUpload(params.path!);
          if (!valid() || timedOut) return ended();
          await page.locator(params.selector!).setInputFiles(file, { timeout });
          uploaded = { name: file.name, mimeType: file.mimeType, size: file.buffer.length };
          break;
        }
        case "press":
          if (params.selector)
            await page.press(params.selector, params.key!, { timeout });
          else await page.keyboard.press(params.key!);
          break;
      }
      const current = session.page;
      const result: BrowserResult = {
        ok: true,
        url: current.url(),
        title: await current.title(),
        ...(uploaded ? { uploaded } : {}),
      };
      if (params.action === "text")
        result.text = cap(
          await current.innerText("body", { timeout }),
          MAX_TEXT_CHARS,
        );
      if (params.action === "snapshot")
        result.snapshot = cap(
          await current.locator("body").ariaSnapshot({ timeout }),
          MAX_SNAPSHOT_CHARS,
        );
      if (params.action === "screenshot") {
        result.png = await current.screenshot({
          fullPage: params.fullPage === true,
          timeout,
        });
        Object.assign(result, describeShot(current.url()));
      }
      if (!valid() || timedOut) {
        this.end(agent);
        return ended();
      }
      session.timer = setTimeout(() => this.end(agent), 15 * 60_000);
      session.timer.unref?.();
      return result;
    };
    try {
      return await Promise.race([
        task(),
        interrupted,
        new Promise<BrowserResult>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            transport?.close();
            this.end(agent);
            resolve(ended());
          }, actionMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        transport?.close();
        this.end(agent);
        return ended();
      }
      if (!session) transport?.close();
      if (!valid() || (session && !session.browser.isConnected()))
        return ended();
      if (error instanceof BrowserUploadError)
        return { ok: false, status: 400, code: "invalid_request", error: error.message };
      return failure("action_failed", "The Chrome browser action failed");
    } finally {
      watched?.removeEventListener("abort", onEnd);
      clearTimeout(timer);
    }
  }
}
