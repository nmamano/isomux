import { BrowserUploadError, readBrowserUpload, type UploadedFile } from "./browser-upload";
import { chromium, type Browser, type Page } from "playwright-core";
import { browserExtensionTransport } from "./browser-extension-transport";
import type { ExtensionConnection } from "./browser-extension-bridge";
import type { BrowserExtensionService } from "./browser-extension-service";
import {
  BROWSER_ACTION_DEADLINE_MS,
  parseBrowserParams,
  describeShot,
  MAX_TEXT_CHARS,
  MAX_SNAPSHOT_CHARS,
  type BrowserResult,
} from "./browser-actions";

type Session = {
  member: string;
  signal: AbortSignal;
  browser: Browser;
  page: Page;
  pages: Page[];
  parents: Map<Page, Page>;
  opened: boolean;
};
const failure = (
  code:
    | "browser_not_paired"
    | "browser_offline"
    | "browser_control_ended"
    | "action_failed"
    | "action_timeout",
  error: string,
): BrowserResult => ({ ok: false, status: 500, code, error });
const ended = () =>
  failure(
    "browser_control_ended",
    "Browser control ended; pending outcomes may be unknown",
  );
const timeoutResult = (recovering = false) => failure("action_timeout", recovering
  ? "The previous browser action is still settling; its outcome may be unknown. Control remains on. Inspect the page after it settles before retrying."
  : "The browser action timed out; its outcome may be unknown. Control remains on. Inspect the page before retrying.");
const SETTLEMENT_GRACE_MS = 1000;
const cap = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}\n[truncated at ${n} characters]` : s;

export class ExtensionBrowserSessions {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private recovering = new Map<string, { connection: ExtensionConnection; grant: string; done: Promise<void> }>();
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
    void session.browser.close().catch(() => {});
  }
  stop(): void {
    for (const agent of this.sessions.keys()) this.end(agent);
  }
  run(agent: string, body: unknown): Promise<BrowserResult> {
    const params = parseBrowserParams(body);
    if (!params.ok) return Promise.resolve(params);
    const member = this.owner(agent);
    const queuedConnection = member ? this.service.bridge.forMember(member) : undefined;
    const queuedGrant = queuedConnection?.offered(agent);
    const previous = this.queues.get(agent) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async (): Promise<BrowserResult> => {
        if (
          this.owner(agent) !== member
        )
          return ended();
        if (!member) return params.action === "close"
          ? { ok: true, url: "", title: "", closed: true }
          : failure("browser_not_paired", "No Chrome browser is paired");
        if (!this.mayUse(member, agent)) return ended();
        if ((this.service.bridge.forMember(member) !== queuedConnection ||
            queuedConnection?.offered(agent) !== queuedGrant)) return ended();
        return this.extensionAction(member, agent, body);
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
    const prior = this.recovering.get(agent);
    if (prior?.connection === connection && prior.grant === grant) return timeoutResult(true);
    const started = performance.now();
    let operationSettled = false;
    const diagnostic = (reason: string) => console.info("[browser-extension] " + JSON.stringify({
      reason, action: params.action, elapsedMs: Math.round(performance.now() - started),
      generation: connection.generation, assignment: grant,
      pending: connection.pendingCount(grant), operationSettled,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transport: ReturnType<typeof browserExtensionTransport> | undefined;
    let timedOut = false;
    let timeoutWinner = "client_closed";
    let interrupt!: (result: BrowserResult) => void;
    const interrupted = new Promise<BrowserResult>(resolve => { interrupt = resolve; });
    let watched: AbortSignal | undefined;
    const onEnd = () => {
      timedOut = true;
      if (valid()) interrupt(timeoutResult(true));
      else { this.end(agent); interrupt(ended()); }
    };
    const watchEnd = (signal: AbortSignal) => {
      watched = signal;
      signal.addEventListener("abort", onEnd, { once: true });
      if (signal.aborted) onEnd();
    };
    const valid = () =>
      this.owner(agent) === member &&
      this.mayUse(member, agent) &&
      this.service.bridge.forMember(member) === connection &&
      connection.offered(agent) === grant;
    if (session) watchEnd(session.signal);
    const task = async (): Promise<BrowserResult> => {
      if (!session) {
        transport = browserExtensionTransport(connection, agent, true);
        watchEnd(transport.signal);
        const browser = await chromium.connectOverCDP(transport, {
          noDefaults: true,
          timeout: actionMs,
        });
        if (!valid()) {
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
            this.sessions.delete(agent);
          }
        });
      }
      if (!valid()) { this.end(agent); return ended(); }
      if (timedOut) return timeoutResult(true);
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
          if (!valid()) return ended();
          if (timedOut) return timeoutResult(true);
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
      if (timedOut) return timeoutResult(true);
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
      if (!valid()) { this.end(agent); return ended(); }
      if (timedOut) return timeoutResult(true);
      return result;
    };
    // The action promise can reject before Chrome finishes the underlying CDP
    // command. Keep that work fenced independently of the caller's response.
    const operation = task().finally(() => { operationSettled = true; });
    const settleTimeout = async (winner: string): Promise<BrowserResult> => {
      if (!valid()) return ended();
      timedOut = true;
      diagnostic(winner);
      const stop = params.action === "goto" ? connection.stopLoading(grant).catch(() => {}) : Promise.resolve();
      const recovery = { connection, grant, done: Promise.resolve() };
      this.recovering.set(agent, recovery);
      recovery.done = Promise.all([operation.catch(() => {}), stop]).then(() => connection.drain(grant)).then(() => {
        diagnostic("drain_completed");
        if (this.recovering.get(agent) === recovery) this.recovering.delete(agent);
      });
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([recovery.done, new Promise<void>(resolve => { grace = setTimeout(resolve, SETTLEMENT_GRACE_MS); })]);
      clearTimeout(grace);
      if (!valid()) return ended();
      const busy = this.recovering.get(agent) === recovery;
      if (busy) diagnostic("drain_exceeded");
      return timeoutResult(busy);
    };
    try {
      const result = await Promise.race([
        operation,
        interrupted,
        new Promise<BrowserResult>((resolve) => {
          timer = setTimeout(() => {
            timeoutWinner = "watchdog_timeout";
            timedOut = true;
            resolve(timeoutResult(true));
          }, actionMs + SETTLEMENT_GRACE_MS);
        }),
      ]);
      if (!result.ok && result.code === "action_timeout") return await settleTimeout(timeoutWinner);
      return result;
    } catch (error) {
      if (!valid()) return ended();
      if ((error instanceof Error && error.name === "TimeoutError") || connection.pendingTimedOut(grant))
        return await settleTimeout("operation_timeout");
      if (!session) transport?.close();
      if (session && !session.browser.isConnected()) return ended();
      if (error instanceof BrowserUploadError)
        return { ok: false, status: 400, code: "invalid_request", error: error.message };
      return failure("action_failed", "The Chrome browser action failed");
    } finally {
      watched?.removeEventListener("abort", onEnd);
      clearTimeout(timer);
    }
  }
}
