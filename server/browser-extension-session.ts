import { selectorSyntaxFailure } from "./browser-selector-errors";
import {
  BrowserUploadError,
  readBrowserUpload,
  type UploadedFile,
} from "./browser-upload";
import type { Browser, Dialog, Page } from "playwright-core";
import {
  readBrowserFrames,
  resolveBrowserFrame,
  StalledWaitError,
  withinDeadline,
} from "./browser-frames";
import {
  CHECK_REASON,
  SELECT_REASON,
  checkHitTarget,
  checkNotPerformedReason,
  clickNotPerformedReason,
  firstMatchingOption,
  watchNavigation,
} from "./browser-input";
import { browserExtensionTransport } from "./browser-extension-transport";
import {
  FENCE_CEILING_MS,
  type ExtensionConnection,
} from "./browser-extension-bridge";
import { officePageRefused } from "./browser-office-gate";
import type { BrowserExtensionService } from "./browser-extension-service";
import type { BrowserExtensionStore } from "./browser-extension-store";
import {
  BROWSER_ACTION_DEADLINE_MS,
  parseBrowserParams,
  describeShot,
  MAX_TEXT_CHARS,
  MAX_SNAPSHOT_CHARS,
  type BrowserDialog,
  type BrowserResult,
} from "./browser-actions";

// The dialog policy of the action that runs now. A dialog that opens while no
// action runs is dismissed and reported nowhere.
type ActionDialogs = {
  accept: boolean;
  acceptUsed: boolean;
  records: BrowserDialog[];
  answers: Promise<void>[];
};

type Session = {
  actor: string;
  member: string;
  signal: AbortSignal;
  browser: Browser;
  transport: ReturnType<typeof browserExtensionTransport>;
  page: Page;
  pages: Page[];
  parents: Map<Page, Page>;
  opened: boolean;
  dialogs?: ActionDialogs;
};
const failure = (
  code:
    | "browser_target_required"
    | "browser_not_paired"
    | "browser_offline"
    | "browser_control_ended"
    | "action_failed"
    | "action_timeout",
  error: string,
): BrowserResult => ({ ok: false, status: 500, code, error });
const OFFICE_REFUSED =
  'Browser control refuses an Isomux office page that your manager did not offer. Go to another page, or ask your manager to offer a tab that shows this page. If that tab already shows as offered, they must turn Agent control off and on again for it. The new offer has a new target: use action "tabs" to find it.';
// The page data of a refused office page never reaches the agent: no url,
// title, text, snapshot, screenshot or dialog.
const officeRefused = (): BrowserResult => ({
  ok: false,
  status: 403,
  code: "office_page_refused",
  error: OFFICE_REFUSED,
});
const ended = () =>
  failure(
    "browser_control_ended",
    "Browser control ended; pending outcomes may be unknown",
  );
// This action's own timeout. respond() sends every one through
// settleTimeout, which picks the copy after the drain grace.
export const TIMED_OUT_ERROR =
  "The browser action timed out; its outcome may be unknown. Control remains on. Inspect the page before retrying.";
const timedOutResult = () => failure("action_timeout", TIMED_OUT_ERROR);
// This action's own timeout, while its commands still run.
export const STILL_SETTLING_ERROR =
  "The browser action timed out and is still settling; its outcome may be unknown. Control remains on. Wait until it settles, and then inspect the page before retrying.";
const stillSettlingResult = () =>
  failure("action_timeout", STILL_SETTLING_ERROR);
// A fence before this action dispatched anything: only an earlier action's
// outcome is unknown.
export const NOT_SENT_ERROR =
  "This browser action was not sent: the previous action is still settling, and only its outcome is unknown. Control remains on. Inspect the page after it settles before retrying.";
const notSentResult = () => failure("action_timeout", NOT_SENT_ERROR);
// How long a read, or a goto that loaded, waits for the page's title with no
// command in flight. Then the page gave Playwright no script context, which
// a longer wait does not change (task 6950c897).
export const PAGE_ANSWER_MS = 5000;
const PAGE_UNANSWERED_ERROR = `The page did not answer within ${PAGE_ANSWER_MS / 1000} s. Control remains on. It may still be loading: try once more. If it fails again, use another tab.`;
class PageUnansweredError extends Error {}
// The first line of an error, sorted into a class for the log. The message
// itself can carry page data and never reaches a log.
const ERROR_CLASSES: [RegExp, string][] = [
  [/strict mode violation/, "strict"],
  [/\bnet::ERR_/, "net"],
  [/interrupted by another navigation/, "navigation_interrupted"],
  [/[Ff]rame (?:was|has been) detached/, "frame_detached"],
  [/has been closed|Target closed/, "closed"],
  [/Offer a tab with Allow agent control/, "not_assigned"],
  [/Protocol error/, "protocol"],
];
const errorClass = (error: unknown): string => {
  const first =
    error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
  return ERROR_CLASSES.find(([pattern]) => pattern.test(first))?.[1] ?? "other";
};
// An out-of-date extension may not offer its tabs again after a restart, so
// this replaces the promise that offers come back.
const outdatedNote = (names: string[]) =>
  `The extension in ${names.join(", ")} is out of date: ask your manager to update it in Integrations → Browser Use.`;
const offline = (outdated: string[]) =>
  failure(
    "browser_offline",
    "No paired Chrome browser is online. " +
      (outdated.length
        ? outdatedNote(outdated)
        : "If the office just restarted, try again in a minute: offers come back with the same targets."),
  );
// playwright-core takes most of a second to load, so the office loads it at
// the first browser session, not at boot.
let playwright: Promise<typeof import("playwright-core")> | undefined;
const loadPlaywright = () =>
  (playwright ??= import("playwright-core").catch((error: unknown) => {
    playwright = undefined;
    throw error;
  }));
const SETTLEMENT_GRACE_MS = 1000;
// Time an input's checks leave for the response, and the time a settle leaves
// for reading the title.
const INPUT_RESERVE_MS = 1500;
const TITLE_RESERVE_MS = 500;
const MAX_DIALOG_MESSAGE = 2000;
const PLAYWRIGHT_CLOSED_TARGET =
  "Target page, context or browser has been closed";
const notPerformed = (action: "click" | "select", reason: string) =>
  failure(
    "action_failed",
    action === "click"
      ? `The click was not performed: ${reason}.`
      : `The option was not selected: ${reason}.`,
  );
const notChecked = (wanted: boolean, reason: string) =>
  failure(
    "action_failed",
    `The control was not ${wanted ? "checked" : "unchecked"}: ${reason}.`,
  );
// Every dialog is answered at once. Without a page listener Playwright closes
// it itself without catching a failed answer, which ends the server process.
function answerDialog(owner: Session, dialog: Dialog): void {
  const action = owner.dialogs;
  const type = dialog.type();
  const accept =
    type === "beforeunload" || (!!action?.accept && !action.acceptUsed);
  if (action?.accept && type !== "beforeunload") action.acceptUsed = true;
  const record: BrowserDialog = {
    type,
    message: dialog.message().slice(0, MAX_DIALOG_MESSAGE),
    accepted: false,
  };
  const answered = (accept ? dialog.accept() : dialog.dismiss()).then(
    () => {
      record.accepted = accept;
    },
    () => {},
  );
  if (!action) return;
  action.records.push(record);
  action.answers.push(answered);
}
type Resolved = {
  connection: ExtensionConnection;
  grant: string;
  target: string;
  offerOrigin: string | undefined;
};
const same = (a: Resolved | undefined, b: Resolved | undefined): boolean =>
  a?.connection === b?.connection && a?.grant === b?.grant;

// The fence of a timed-out action, until its work settles or the ceiling.
type Recovery = {
  connection: ExtensionConnection;
  grant: string;
  done: Promise<void>;
  ceiling?: ReturnType<typeof setTimeout>;
};

// Only what the sessions read, so a test fake is typed without a cast.
export type ExtensionSessionService = Pick<
  BrowserExtensionService,
  "bridge" | "outdatedBrowsers"
> & { store: Pick<BrowserExtensionStore, "paired"> };

export class ExtensionBrowserSessions {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private recovering = new Map<string, Recovery>();
  constructor(
    private service: ExtensionSessionService,
    private owner: (agent: string) => string | undefined,
    private mayUse: (member: string, agent: string) => boolean,
    private actionDeadline: () => number = () => BROWSER_ACTION_DEADLINE_MS,
    private fenceCeiling: () => number = () => FENCE_CEILING_MS,
    private pageAnswer: () => number = () => PAGE_ANSWER_MS,
  ) {}
  private end(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    void session.browser.close().catch(() => {});
  }
  stop(): void {
    for (const recovery of this.recovering.values())
      clearTimeout(recovery.ceiling);
    for (const key of this.sessions.keys()) this.end(key);
  }
  // A client that is stuck goes, and the next action attaches a fresh one.
  // The bridge drops the client first: its close rejects every hung
  // Playwright call, while browser.close() can itself wait on Chrome.
  private retire(
    key: string,
    connection: ExtensionConnection,
    grant: string,
    cause: string,
  ): void {
    connection.retireClient(grant, cause);
    this.end(key);
  }
  run(agent: string, body: unknown): Promise<BrowserResult> {
    const params = parseBrowserParams(body);
    if (!params.ok) return Promise.resolve(params);
    const member = this.owner(agent);
    const bridge = this.service.bridge;
    if (params.action === "tabs") {
      if (!member || !this.service.store.paired(member))
        return Promise.resolve(
          failure("browser_not_paired", "No Chrome browser is paired"),
        );
      if (!this.mayUse(member, agent)) return Promise.resolve(ended());
      const outdated = this.service.outdatedBrowsers(member);
      if (!bridge.connections(member).length)
        return Promise.resolve(offline(outdated));
      return Promise.resolve({
        ok: true,
        url: "",
        title: "",
        tabs: bridge.targets(member, agent),
        ...(outdated.length ? { outdatedBrowsers: outdated } : {}),
      });
    }
    if (!params.target && member && bridge.ambiguous(member, agent))
      return Promise.resolve(
        failure(
          "browser_target_required",
          'Several tabs are offered. Use action "tabs", then pass the chosen target with the browser action.',
        ),
      );
    // The connection and grant are bound here. A queued action never moves to
    // another browser when an offer disappears or a new one takes precedence.
    const queued = member
      ? bridge.resolve(member, agent, params.target)
      : undefined;
    const key = queued
      ? `${queued.connection.generation}:${queued.grant}`
      : agent;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async (): Promise<BrowserResult> => {
        if (this.owner(agent) !== member) return ended();
        if (!member)
          return params.action === "close"
            ? { ok: true, url: "", title: "", closed: true }
            : failure("browser_not_paired", "No Chrome browser is paired");
        if (!this.mayUse(member, agent)) return ended();
        if (!same(bridge.resolve(member, agent, params.target), queued))
          return ended();
        return this.extensionAction(member, agent, body, key, queued);
      });
    this.queues.set(key, work);
    void work
      .finally(() => {
        if (this.queues.get(key) === work) this.queues.delete(key);
      })
      .catch(() => {});
    return work;
  }
  private async extensionAction(
    member: string,
    agent: string,
    body: unknown,
    key: string,
    bound: Resolved | undefined,
  ): Promise<BrowserResult> {
    const actionMs = this.actionDeadline();
    const actionStarted = performance.now();
    const params = parseBrowserParams(body);
    if (!params.ok) return params;
    if (!this.service.store.paired(member))
      return failure("browser_not_paired", "No Chrome browser is paired");
    const outdated = this.service.outdatedBrowsers(member);
    if (!this.service.bridge.connections(member).length)
      return offline(outdated);
    let session = this.sessions.get(key);
    if (
      session &&
      (session.signal.aborted ||
        !session.browser.isConnected() ||
        session.member !== member)
    ) {
      this.end(key);
      session = undefined;
    }
    if (!bound)
      return failure(
        "browser_control_ended",
        (params.target
          ? 'This target is no longer offered. Use action "tabs" to find the current targets; a tab offered again has a new target.'
          : "Open the Chrome extension popup on an HTTP(S) tab, choose All or this agent, and turn on Agent control.") +
          (outdated.length ? " " + outdatedNote(outdated) : ""),
      );
    const { connection, grant, target } = bound;
    // fence: the check that refused this action.
    const notSent = (fence: string) => {
      console.info(
        "[browser-extension] " +
          JSON.stringify({
            reason: "not_sent",
            action: params.action,
            generation: connection.generation,
            assignment: grant,
            fence,
            pending: connection.pendingCount(grant),
          }),
      );
      return notSentResult();
    };
    if (
      params.action === "goto" &&
      officePageRefused(
        params.url!.href,
        bound.offerOrigin,
        this.service.bridge.offices.all(),
      )
    )
      return officeRefused();
    if (params.action === "close") {
      this.end(key);
      connection.revoke(agent, target);
      return { ok: true, url: "", title: "", closed: true };
    }
    // Playwright would wait on the refused page until the action timeout.
    if (params.action !== "goto" && connection.officeGated(grant))
      return officeRefused();
    if (!(await connection.waitForRecovery(grant, actionMs))) {
      return connection.offered(agent, target) === grant
        ? notSent("recovery_wait")
        : ended();
    }
    if (session && (session.signal.aborted || !session.browser.isConnected())) {
      this.end(key);
      session = undefined;
    }
    const prior = this.recovering.get(key);
    if (prior?.connection === connection && prior.grant === grant)
      return notSent("settling");
    if (connection.pendingCount(grant)) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connection.drain(grant),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, SETTLEMENT_GRACE_MS);
        }),
      ]);
      clearTimeout(drainTimer);
      if (connection.pendingCount(grant)) return notSent("pending");
    }
    if (session && session.actor !== agent) {
      // One client at a time per grant. Its immutable actor retires with it;
      // delayed old-client commands cannot borrow the next caller's access.
      // A close that waits on Chrome must not hold the grant's queue: after
      // the grace the transport closes, which ends the client at once.
      this.sessions.delete(key);
      const old = session;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        old.browser.close().catch(() => {}),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, SETTLEMENT_GRACE_MS);
        }),
      ]);
      clearTimeout(closeTimer);
      old.transport.close();
      session = undefined;
      if (connection.pendingCount(grant)) return notSent("actor_change");
    }
    // A client cannot attach on a refused office page: the gate refuses its
    // first commands. A goto leaves the page through the bridge first, and a
    // client that sat on the page ends.
    const leaving = params.action === "goto" && connection.officeGated(grant);
    if (leaving && session) {
      this.end(key);
      session = undefined;
    }
    const started = performance.now();
    const deadline = actionStarted + actionMs;
    let operationSettled = false;
    let phase = "start";
    let inputsAtClick: number | undefined;
    const diagnostic = (reason: string) =>
      console.info(
        "[browser-extension] " +
          JSON.stringify({
            reason,
            action: params.action,
            elapsedMs: Math.round(performance.now() - started),
            generation: connection.generation,
            assignment: grant,
            pending: connection.pendingCount(grant),
            operationSettled,
            phase,
            dispatched:
              session && inputsAtClick !== undefined
                ? session.transport.inputs > inputsAtClick
                : undefined,
          }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let policy: { session: Session; dialogs: ActionDialogs } | undefined;
    let transport: ReturnType<typeof browserExtensionTransport> | undefined;
    let timedOut = false;
    let debuggerDetached = false;
    const detachedResult = () =>
      failure(
        "action_failed",
        "The Chrome debugger detached; the action outcome is unknown.",
      );
    let timeoutWinner = "client_closed";
    let interrupt!: (result: BrowserResult) => void;
    const interrupted = new Promise<BrowserResult>((resolve) => {
      interrupt = resolve;
    });
    let watched: AbortSignal | undefined;
    const onEnd = () => {
      timedOut = true;
      if (valid() && connection.isRecovering(grant)) {
        debuggerDetached = true;
        this.end(key);
        interrupt(detachedResult());
      } else if (valid()) interrupt(timedOutResult());
      else {
        this.end(key);
        interrupt(ended());
      }
    };
    const watchEnd = (signal: AbortSignal) => {
      watched = signal;
      signal.addEventListener("abort", onEnd, { once: true });
      if (signal.aborted) onEnd();
    };
    const valid = () =>
      this.owner(agent) === member &&
      this.mayUse(member, agent) &&
      same(this.service.bridge.resolve(member, agent, params.target), bound);
    if (session) watchEnd(session.signal);
    const task = async (): Promise<BrowserResult> => {
      if (leaving) {
        phase = "leave";
        await connection.leaveOffice(grant, params.url!.href, deadline);
      }
      if (!session) {
        // Load before the transport exists: it is assigned at once and must
        // not wait on the import before Playwright attaches its handlers.
        const { chromium } = await loadPlaywright();
        transport = browserExtensionTransport(connection, agent, true, target);
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
        if (!page) {
          await browser.close();
          return ended();
        }
        session = {
          actor: agent,
          member,
          signal: transport.signal,
          browser,
          transport,
          page,
          pages: [page],
          parents: new Map(),
          opened: false,
        };
        const owned = session;
        this.sessions.set(key, session);
        page.on("dialog", (dialog) => answerDialog(owned, dialog));
        const adoptPopup = (popup: Page) => {
          // The bridge has already bound the popup to this assignment.
          owned.pages.push(popup);
          popup.on("dialog", (dialog) => answerDialog(owned, dialog));
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
          if (this.sessions.get(key) === owned) {
            this.sessions.delete(key);
          }
        });
      }
      if (!valid()) {
        this.end(key);
        return ended();
      }
      if (timedOut) return timedOutResult();
      const dialogs: ActionDialogs = {
        accept: params.dialog === "accept",
        acceptUsed: false,
        records: [],
        answers: [],
      };
      session.dialogs = dialogs;
      policy = { session, dialogs };
      // Dialogs the office dismissed as this client connected.
      for (const dismissed of connection.takeDismissedDialogs(grant))
        dialogs.answers.push(
          dismissed.then((dialog) => {
            if (dialog)
              dialogs.records.push({
                type: dialog.type,
                message: dialog.message.slice(0, MAX_DIALOG_MESSAGE),
                accepted: false,
              });
          }),
        );
      const timeout = actionMs;
      const page = session.page;
      const closedTarget = (error: unknown) =>
        error instanceof Error &&
        error.message.includes(PLAYWRIGHT_CLOSED_TARGET);
      const waitForClose = (closedPage: Page) =>
        new Promise<boolean>((resolve) => {
          const onClose = () => {
            cleanup();
            resolve(true);
          };
          const timer = setTimeout(
            () => {
              cleanup();
              resolve(false);
            },
            Math.max(1, deadline - performance.now()),
          );
          const cleanup = () => {
            clearTimeout(timer);
            closedPage.off("close", onClose);
          };
          closedPage.on("close", onClose);
          if (closedPage.isClosed()) onClose();
        });
      let mouseReleasesAtClick: number | undefined;
      const frame =
        params.framePath &&
        params.action !== "snapshot" &&
        params.action !== "text"
          ? resolveBrowserFrame(page.mainFrame(), params.framePath)
          : undefined;
      const element = frame?.locator(params.selector!);
      let uploaded: UploadedFile | undefined;
      let selected: string[] | undefined;
      let checked: boolean | undefined;
      let loading = false;
      // The input outcome stays separate from the settle: a settle that runs
      // out sets loading, it never turns a dispatched input into a failure.
      const inputThenSettle = async (input: () => Promise<unknown>) => {
        const main = page.mainFrame();
        const watch = watchNavigation(
          page,
          frame && frame !== main ? [main, frame] : [main],
        );
        try {
          phase = "input";
          await input();
          phase = "settle";
          if (!timedOut)
            loading = !(await watch.settle(deadline - TITLE_RESERVE_MS));
        } finally {
          watch.dispose();
        }
      };
      const inputBudget = () => Math.max(1, deadline - performance.now());
      switch (params.action) {
        case "goto":
          // After a leave the page is already on its way to the URL.
          if (leaving) await page.waitForLoadState("load", { timeout });
          else
            await page.goto(params.url!.toString(), {
              waitUntil: "load",
              timeout,
            });
          session.opened = true;
          break;
        case "click": {
          const options = {
            noWaitAfter: true,
            timeout: Math.max(
              1,
              deadline - INPUT_RESERVE_MS - performance.now(),
            ),
          };
          const inputs = session.transport.inputs;
          inputsAtClick = inputs;
          mouseReleasesAtClick = session.transport.mouseReleases;
          try {
            // One Playwright click: actionability, then one dispatch. With
            // noWaitAfter Playwright neither retries after the dispatch nor
            // waits for a navigation. An ok result means that the click was
            // dispatched at the target's position after it passed
            // actionability, not that the page applied it.
            await inputThenSettle(() =>
              element
                ? element.click(options)
                : page.click(params.selector!, options),
            );
          } catch (error) {
            // A self-closing popup can close before Playwright resolves the
            // click. Recover only after mouse-up was handed to the bridge.
            if (
              closedTarget(error) &&
              session.transport.mouseReleases > mouseReleasesAtClick
            ) {
              if (!(await waitForClose(page))) throw error;
              if (!valid()) return ended();
              if (session.page === page || session.page.isClosed()) throw error;
              break;
            }
            // No Input command left the transport: nothing was dispatched.
            if (
              error instanceof Error &&
              error.name === "TimeoutError" &&
              session.transport.inputs === inputs
            ) {
              diagnostic("click_not_performed");
              return notPerformed(
                "click",
                clickNotPerformedReason(error.message),
              );
            }
            throw error;
          }
          break;
        }
        case "select": {
          const select = element ?? page.locator(params.selector!).first();
          phase = "check";
          let enabled: boolean;
          try {
            enabled = await select.isEnabled({
              timeout: Math.max(
                1,
                deadline - INPUT_RESERVE_MS - performance.now(),
              ),
            });
          } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError")
              return notPerformed("select", SELECT_REASON.missing);
            throw error;
          }
          if (!enabled) return notPerformed("select", SELECT_REASON.disabled);
          const checkBudget = () =>
            Math.max(1, deadline - INPUT_RESERVE_MS - performance.now());
          const option = await firstMatchingOption(
            select,
            params.value !== undefined
              ? { value: params.value }
              : { label: params.label! },
            checkBudget,
          );
          if (!option) return notPerformed("select", SELECT_REASON.noOption);
          // selectOption would wait on this option until the deadline. An
          // inconclusive check leaves the choice to selectOption, whose
          // timeout keeps the unknown outcome.
          if (
            option !== "inconclusive" &&
            !(await option.isEnabled({ timeout: checkBudget() }))
          )
            return notPerformed("select", SELECT_REASON.optionDisabled);
          if (timedOut) return timedOutResult();
          // Forced past the visibility check, so that a native select hidden
          // under a styled control works. The disabled check above is a
          // separate round trip.
          await inputThenSettle(async () => {
            selected = await select.selectOption(
              params.value !== undefined
                ? { value: params.value }
                : { label: params.label! },
              { force: true, timeout: inputBudget() },
            );
          });
          break;
        }
        case "check": {
          const control = element ?? page.locator(params.selector!).first();
          const wanted = params.checked!;
          const checkBudget = () =>
            Math.max(1, deadline - INPUT_RESERVE_MS - performance.now());
          phase = "check";
          let enabled: boolean;
          try {
            enabled = await control.isEnabled({ timeout: checkBudget() });
          } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError")
              return notChecked(wanted, CHECK_REASON.missing);
            throw error;
          }
          // force skips Playwright's own enabled check.
          if (!enabled) return notChecked(wanted, CHECK_REASON.disabled);
          // A control with no box cannot take a click. The bridge hides the
          // CDP error that tells Playwright so, and setChecked would retry
          // its scroll until the deadline.
          if (!(await control.boundingBox({ timeout: checkBudget() })))
            return notChecked(wanted, CHECK_REASON.hidden);
          try {
            // A control already in the wanted state gets no input and no
            // hit-target check.
            if (
              (await control.isChecked({ timeout: checkBudget() })) === wanted
            ) {
              checked = wanted;
              break;
            }
          } catch (error) {
            const reason =
              error instanceof Error && error.name !== "TimeoutError"
                ? checkNotPerformedReason(error.message)
                : undefined;
            if (!reason) throw error;
            return notChecked(wanted, reason);
          }
          // force skips Playwright's hit-target check, so the topmost element
          // at the control's centre gets the click. Only an element that
          // belongs to the control may get it.
          const hit = await control.evaluate(checkHitTarget, undefined, {
            timeout: checkBudget(),
          });
          if (hit !== "control") {
            diagnostic("check_not_performed");
            return notChecked(
              wanted,
              hit === "covered" ? CHECK_REASON.covered : CHECK_REASON.outside,
            );
          }
          if (timedOut) return timedOutResult();
          inputsAtClick = session.transport.inputs;
          try {
            // Forced past the visibility and hit-target checks, so that a
            // native input under its own styled cover works.
            await inputThenSettle(async () => {
              await control.setChecked(wanted, {
                force: true,
                timeout: inputBudget(),
              });
              checked = await control.isChecked({ timeout: inputBudget() });
            });
          } catch (error) {
            const reason =
              error instanceof Error && error.name !== "TimeoutError"
                ? checkNotPerformedReason(error.message)
                : undefined;
            if (!reason) throw error;
            diagnostic(
              reason === CHECK_REASON.unchanged
                ? "check_unchanged"
                : "check_not_performed",
            );
            return notChecked(wanted, reason);
          }
          break;
        }
        case "fill":
          if (element) await element.fill(params.text!, { timeout });
          else await page.fill(params.selector!, params.text!, { timeout });
          break;
        case "upload": {
          const file = await readBrowserUpload(params.path!);
          if (!valid()) return ended();
          if (timedOut) return timedOutResult();
          await (element ?? page.locator(params.selector!)).setInputFiles(
            file,
            { timeout },
          );
          uploaded = {
            name: file.name,
            mimeType: file.mimeType,
            size: file.buffer.length,
          };
          break;
        }
        case "press":
          if (element) await element.press(params.key!, { timeout });
          else if (params.selector)
            await page.press(params.selector, params.key!, { timeout });
          else await page.keyboard.press(params.key!);
          break;
      }
      if (timedOut) return timedOutResult();
      // A read, or a goto that loaded, waits at most pageAnswer for a title
      // with no command in flight. After an input the new document can still
      // be on its way, so the title read keeps the deadline.
      const answerBound =
        params.action === "text" ||
        params.action === "snapshot" ||
        params.action === "screenshot" ||
        params.action === "goto";
      const readTitle = async (page: Page) => {
        const read = page.title();
        if (answerBound) {
          const bound = Math.min(
            this.pageAnswer(),
            deadline - performance.now(),
          );
          try {
            return await withinDeadline(read, bound);
          } catch (error) {
            if (
              !(error instanceof StalledWaitError) ||
              performance.now() >= deadline
            )
              throw error;
            if (!connection.pendingCount(grant))
              throw new PageUnansweredError();
          }
        }
        return withinDeadline(read, deadline - performance.now());
      };
      let current: Page;
      let title: string;
      let metadataRetry = false;
      for (;;) {
        if (!valid()) return ended();
        if (metadataRetry && performance.now() >= deadline)
          throw new (await loadPlaywright()).errors.TimeoutError(
            "Browser metadata deadline reached",
          );
        current = session.page;
        if (current.isClosed()) throw new Error("Selected browser page closed");
        try {
          // title() has no timeout of its own.
          title = await readTitle(current);
        } catch (error) {
          if (
            !closedTarget(error) ||
            (params.action === "click" &&
              session.transport.mouseReleases <= mouseReleasesAtClick!)
          )
            throw error;
          if (!(await waitForClose(current))) throw error;
          if (!valid()) return ended();
          if (session.page === current) throw error;
          metadataRetry = true;
          continue;
        }
        // A close can also follow a successful title read. Select the live
        // parent before reading its URL or any text, snapshot or screenshot.
        if (current.isClosed()) {
          await waitForClose(current);
          if (!valid()) return ended();
          if (session.page === current)
            throw new Error("Selected browser page closed");
          metadataRetry = true;
          continue;
        }
        break;
      }
      const url = current.url();
      const result: BrowserResult = {
        ok: true,
        target,
        url,
        title,
        ...(uploaded ? { uploaded } : {}),
        ...(selected ? { selected } : {}),
        ...(checked !== undefined ? { checked } : {}),
        ...(loading ? { loading: true } : {}),
      };
      if (params.action === "text")
        result.text = await readBrowserFrames(
          current.mainFrame(),
          "text",
          MAX_TEXT_CHARS,
          timeout,
          params,
        );
      if (params.action === "snapshot")
        result.snapshot = await readBrowserFrames(
          current.mainFrame(),
          "snapshot",
          MAX_SNAPSHOT_CHARS,
          timeout,
          params,
        );
      if (params.action === "screenshot") {
        result.png = await current.screenshot({
          fullPage: params.fullPage === true,
          timeout,
        });
        Object.assign(result, describeShot(url));
      }
      if (dialogs.answers.length) {
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(dialogs.answers),
          new Promise<void>((resolve) => {
            wait = setTimeout(
              resolve,
              Math.max(0, deadline - performance.now()),
            );
          }),
        ]);
        clearTimeout(wait);
      }
      if (dialogs.records.length)
        result.dialogs = dialogs.records.map((record) => ({ ...record }));
      if (!valid()) {
        this.end(key);
        return ended();
      }
      if (timedOut) return timedOutResult();
      return result;
    };
    // The action promise can reject before Chrome finishes the underlying CDP
    // command. Keep that work fenced independently of the caller's response.
    // Read before task() starts: it runs to its first await at once, and a
    // command refused in that tick must count.
    const refusals = connection.officeRefusals(grant);
    // A gate that closes during the action ends it: Playwright would wait on
    // the refused page until the action timeout, with no command in flight.
    // Ending the client stops the action's retries from landing on the page
    // the agent goes to next; its transport closes at once, also while the
    // client still connects. Interrupt first: the abort runs onEnd.
    const stopGateWatch = connection.onGateClose(grant, () => {
      if (!connection.officeGated(grant)) return;
      interrupt(officeRefused());
      const live = this.sessions.get(key)?.transport ?? transport;
      this.end(key);
      live?.close();
    });
    const operation = task().finally(() => {
      operationSettled = true;
    });
    // retire: why the client is stuck (a wait outlived its own timeout or had
    // none), so that it goes once the timed-out work settles.
    const settleTimeout = async (
      winner: string,
      retire = winner === "watchdog_timeout" ? winner : undefined,
    ): Promise<BrowserResult> => {
      if (!valid()) return ended();
      timedOut = true;
      diagnostic(winner);
      const stop =
        params.action === "goto"
          ? connection.stopLoading(grant).catch(() => {})
          : Promise.resolve();
      const recovery: Recovery = { connection, grant, done: Promise.resolve() };
      this.recovering.set(key, recovery);
      recovery.done = Promise.all([operation.catch(() => {}), stop])
        .then(() => connection.drain(grant))
        .then(() => {
          diagnostic("drain_completed");
          if (this.recovering.get(key) !== recovery) return;
          clearTimeout(recovery.ceiling);
          if (retire) this.retire(key, connection, grant, retire);
          this.recovering.delete(key);
        });
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        recovery.done,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, SETTLEMENT_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
      if (!valid()) return ended();
      const busy = this.recovering.get(key) === recovery;
      if (busy) {
        diagnostic("drain_exceeded");
        // Work that never settles fences the grant only until the ceiling.
        recovery.ceiling = setTimeout(() => {
          if (this.recovering.get(key) !== recovery) return;
          diagnostic("fence_ceiling");
          this.recovering.delete(key);
          this.retire(key, connection, grant, "fence_ceiling");
        }, this.fenceCeiling());
      }
      return busy ? stillSettlingResult() : timedOutResult();
    };
    const respond = async (): Promise<BrowserResult> => {
      try {
        const result = await Promise.race([
          operation,
          interrupted,
          new Promise<BrowserResult>((resolve) => {
            timer = setTimeout(
              () => {
                timeoutWinner = "watchdog_timeout";
                timedOut = true;
                resolve(timedOutResult());
              },
              Math.max(0, deadline - performance.now()) + SETTLEMENT_GRACE_MS,
            );
          }),
        ]);
        if (debuggerDetached) return valid() ? detachedResult() : ended();
        if (!result.ok && result.code === "action_timeout")
          return await settleTimeout(timeoutWinner);
        return result;
      } catch (error) {
        if (!valid()) return ended();
        if (debuggerDetached) return detachedResult();
        // Nothing is in flight, so nothing needs a fence: the client goes
        // now and the next action gets a fresh one.
        if (error instanceof PageUnansweredError) {
          this.retire(key, connection, grant, "page_unanswered");
          return failure("action_failed", PAGE_UNANSWERED_ERROR);
        }
        if (error instanceof StalledWaitError)
          return await settleTimeout("operation_timeout", "stalled_wait");
        if (
          (error instanceof Error && error.name === "TimeoutError") ||
          connection.pendingTimedOut(grant)
        )
          return await settleTimeout("operation_timeout");
        if (!session) transport?.close();
        if (session && !session.browser.isConnected()) return ended();
        if (error instanceof BrowserUploadError)
          return {
            ok: false,
            status: 400,
            code: "invalid_request",
            error: error.message,
          };
        const syntax = params.selector
          ? selectorSyntaxFailure(error)
          : undefined;
        if (syntax) return syntax;
        const net =
          params.action === "goto" && error instanceof Error
            ? /\bnet::ERR_[A-Z0-9_]+/.exec(error.message.split("\n", 1)[0])
            : null;
        if (net)
          return failure("action_failed", `The page did not load (${net[0]}).`);
        console.info(
          "[browser-extension] " +
            JSON.stringify({
              reason: "action_failed",
              action: params.action,
              errorName: error instanceof Error ? error.name : typeof error,
              errorClass: errorClass(error),
            }),
        );
        return failure("action_failed", "The Chrome browser action failed");
      }
    };
    // A failure keeps the dialogs that its action opened.
    const withDialogs = (result: BrowserResult): BrowserResult =>
      !result.ok && policy?.dialogs.records.length
        ? {
            ...result,
            dialogs: policy.dialogs.records.map((record) => ({ ...record })),
          }
        : result;
    try {
      const result = await respond();
      // A clean action that left the office page stays ok, even when
      // Playwright's own commands on the office document were refused.
      if (
        connection.officeGated(grant) ||
        (!result.ok && connection.officeRefusals(grant) > refusals)
      )
        return officeRefused();
      return withDialogs(result);
    } finally {
      stopGateWatch();
      watched?.removeEventListener("abort", onEnd);
      clearTimeout(timer);
      // A dialog that opens after the response gets no accept and no record.
      if (policy && policy.session.dialogs === policy.dialogs)
        policy.session.dialogs = undefined;
    }
  }
}
