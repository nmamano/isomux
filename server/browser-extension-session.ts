import { chromium, type Browser, type Page } from "playwright-core";
import { browserExtensionTransport } from "./browser-extension-transport";
import type { BrowserExtensionService } from "./browser-extension-service";
import { BROWSER_ACTION_DEADLINE_MS, browserPool, parseBrowserParams, describeShot, MAX_TEXT_CHARS, MAX_SNAPSHOT_CHARS, type BrowserResult } from "./browser-session";

type Session = { member: string; browser: Browser; page: Page; pages: Page[]; parents: Map<Page, Page>; opened: boolean; timer?: ReturnType<typeof setTimeout> };
const failure = (code: "browser_selection_required" | "browser_not_paired" | "browser_offline" | "browser_control_ended" | "action_failed", error: string): BrowserResult => ({ ok: false, status: 500, code, error });
const ended = () => failure("browser_control_ended", "Browser control ended; pending outcomes may be unknown");
const cap = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}\n[truncated at ${n} characters]` : s;

export class ExtensionBrowserSessions {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  constructor(private service: BrowserExtensionService, private owner: (agent: string) => string | undefined, private mayUse: (member: string, agent: string) => boolean, private actionDeadline: () => number = () => BROWSER_ACTION_DEADLINE_MS) {}
  private end(agent: string): void {
    const session = this.sessions.get(agent);
    if (!session) return;
    this.sessions.delete(agent);
    clearTimeout(session.timer);
    void session.browser.close().catch(() => {});
  }
  async endMember(member: string, agents: string[]): Promise<void> {
    this.epochs.set(member, (this.epochs.get(member) ?? 0) + 1);
    for (const [agent, session] of this.sessions) if (session.member === member) this.end(agent);
    await Promise.all(agents.map((agent) => browserPool.interrupt(agent)));
  }
  stop(): void { for (const agent of this.sessions.keys()) this.end(agent); }
  run(agent: string, body: unknown): Promise<BrowserResult> {
    const member = this.owner(agent);
    const epoch = member ? this.epochs.get(member) ?? 0 : 0;
    const previous = this.queues.get(agent) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      if (this.owner(agent) !== member || (member && (this.epochs.get(member) ?? 0) !== epoch)) return ended();
      if (member && this.service.store.record(member).backend === null) return failure("browser_selection_required", "Browser selection is unavailable; select a browser backend again");
      if (!member || this.service.store.record(member).backend === "headless") {
        const result = await browserPool.run(agent, body, member ?? null);
        if (this.owner(agent) !== member || (member && (this.epochs.get(member) ?? 0) !== epoch)) { await browserPool.interrupt(agent); return ended(); }
        return result;
      }
      if (!this.mayUse(member, agent)) return ended();
      return this.extensionAction(member, agent, body, epoch);
    });
    this.queues.set(agent, work);
    void work.finally(() => { if (this.queues.get(agent) === work) this.queues.delete(agent); }).catch(() => {});
    return work;
  }
  private async extensionAction(member: string, agent: string, body: unknown, epoch: number): Promise<BrowserResult> {
    const actionMs = this.actionDeadline();
    const params = parseBrowserParams(body);
    if (!params.ok) return params;
    if (params.action === "close") { this.end(agent); return { ok: true, url: "", title: "", closed: true }; }
    if (!this.service.store.record(member).hash) return failure("browser_not_paired", "No Chrome browser is paired");
    const connection = this.service.bridge.forMember(member);
    if (!connection) return failure("browser_offline", "The Chrome browser is offline");
    let session = this.sessions.get(agent);
    if (session && (!session.browser.isConnected() || session.member !== member)) { this.end(agent); session = undefined; }
    if (!session && params.action !== "goto") return { ok: false, status: 400, code: "no_page", error: "no page is open; call the goto action first" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transport: ReturnType<typeof browserExtensionTransport> | undefined;
    let timedOut = false;
    const valid = () => this.owner(agent) === member && this.mayUse(member, agent) && this.service.store.record(member).backend === "extension" && (this.epochs.get(member) ?? 0) === epoch && this.service.bridge.forMember(member) === connection;
    const task = async (): Promise<BrowserResult> => {
      const createdPage = !session;
      if (!session) {
        transport = browserExtensionTransport(connection, agent);
        const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: actionMs });
        if (!valid() || timedOut) { await browser.close(); return ended(); }
        const context = browser.contexts()[0];
        const page = await context.newPage();
        session = { member, browser, page, pages: [page], parents: new Map(), opened: false };
        const owned = session;
        this.sessions.set(agent, session);
        context.on("page", (popup) => {
          // The bridge has already bound the popup to this assignment.
          owned.pages.push(popup);
          owned.page = popup;
          void popup.opener().then((opener) => { if (opener && owned.pages.includes(opener)) owned.parents.set(popup, opener); });
          popup.on("close", () => {
            owned.pages = owned.pages.filter((p) => p !== popup && !p.isClosed());
            if (owned.page !== popup && !owned.page.isClosed()) return;
            let parent = owned.parents.get(popup);
            while (parent?.isClosed()) parent = owned.parents.get(parent);
            owned.page = parent ?? page;
          });
        });
        browser.on("disconnected", () => { if (this.sessions.get(agent) === owned) { clearTimeout(owned.timer); this.sessions.delete(agent); } });
      }
      if (!valid() || timedOut) { this.end(agent); return ended(); }
      clearTimeout(session.timer);
      const timeout = actionMs;
      const page = session.page;
      switch (params.action) {
        case "goto": await page.goto(params.url!.toString(), { waitUntil: "load", timeout }); session.opened = true; break;
        case "click": await page.click(params.selector!, { timeout }); break;
        case "fill": await page.fill(params.selector!, params.text!, { timeout }); break;
        case "press": if (params.selector) await page.press(params.selector, params.key!, { timeout }); else await page.keyboard.press(params.key!); break;
      }
      const current = session.page;
      const result: BrowserResult = { ok: true, url: current.url(), title: await current.title(), ...(createdPage ? { createdPage: true } : {}) };
      if (params.action === "text") result.text = cap(await current.innerText("body", { timeout }), MAX_TEXT_CHARS);
      if (params.action === "snapshot") result.snapshot = cap(await current.locator("body").ariaSnapshot({ timeout }), MAX_SNAPSHOT_CHARS);
      if (params.action === "screenshot") { result.png = await current.screenshot({ fullPage: params.fullPage === true, timeout }); Object.assign(result, describeShot(current.url())); }
      if (!valid() || timedOut) { this.end(agent); return ended(); }
      session.timer = setTimeout(() => this.end(agent), 15 * 60_000);
      session.timer.unref?.();
      return result;
    };
    try {
      return await Promise.race([task(), new Promise<BrowserResult>((resolve) => { timer = setTimeout(() => { timedOut = true; transport?.close(); this.end(agent); resolve(ended()); }, actionMs); })]);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") { transport?.close(); this.end(agent); return ended(); }
      if (!session) transport?.close();
      if (!valid() || (session && !session.browser.isConnected())) return ended();
      return failure("action_failed", "The Chrome browser action failed");
    } finally { clearTimeout(timer); }
  }
}
