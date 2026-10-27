import { createHash } from "node:crypto";
import manifest from "../browser-extension/manifest.json";
import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_REATTACH_MS,
  validGrantDuration,
  validGrantExpiry,
  validGrantScope,
  type BrowserGrantScope,
  type BrowserGrantDuration,
  fields,
  pageCommandAllowed,
  type BridgePeer,
  type Fields,
  type BrowserDisplay,
} from "../shared/browser-extension-protocol";
import {
  OFFICE_MARKER_HEADER,
  OfficeOrigins,
  httpOrigin,
  officePageRefused,
} from "./browser-office-gate";

const COMMAND_TIMED_OUT = "Browser command timed out";

export const browserCredentialHash = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex");

// The agent-facing target of an offer. The extension picks a new assignment id
// for each offer and keeps it when it resumes one, so a resumed offer keeps its
// target across connections and office restarts, and a new offer gets a new one.
const offerHandle = (credentialHash: string, assignment: string): string => {
  const hex = createHash("sha256")
    .update(credentialHash + ":" + assignment)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// What an extension sends back to resume an offer: the deadline and the pinned
// origin that the office answered at the first offer.
type Resume = { expiresAt: number | null; offerOrigin: string };

// How long a timed-out command or action may still fence its grant before
// the office retires the grant's CDP client and drops its pending commands.
export const FENCE_CEILING_MS = 30_000;

type Pending = {
  assignment: string;
  resolve(value: Fields): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  settled(): void;
  timedOut: boolean;
  // For the logs: the CDP method (or the bridge method) and its session.
  method: string;
  session: "main" | "popup" | "child";
};
interface GrantClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const grantClock: GrantClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
// Chrome can leave a capture of a background tab unanswered while no other tab
// draws, and a second capture of the same tab releases it (Chrome 151 under
// Xvfb, task c04479de). Each pending capture gets such kicks. The delay before
// kick n (from 0) is captureKickDelay(n), because a kick costs a full capture.
const CAPTURE_KICK_MS = 300;
export const captureKickDelay = (kicks: number): number =>
  CAPTURE_KICK_MS * 2 ** kicks;
type Assignment = {
  durationMinutes: BrowserGrantDuration;
  expiresAt: number | null;
  cancelExpiry?: () => void;
  id: string;
  scope: BrowserGrantScope;
  handle: string;
  session: string;
  browserSession: string;
  peer: BridgePeer;
  // Clients retired so far; work of a retired client sends nothing new.
  retirements: number;
  target?: Fields;
  children: Map<string, ChildFrame>;
  popups: Map<string, Fields>;
  leafTargetId?: string;
  // The office gate (browser-office-gate.ts). The offer origin is pinned at the
  // offer. Pages are keyed by CDP session: the tab's own, or a popup's.
  offerOrigin?: string;
  pages: Map<string, { url?: string; gated: boolean }>;
  childPages: Map<string, string>;
  officeRefusals: number;
  creating: boolean;
  connected: boolean;
  announced: boolean;
  // Sessions whose Target.setAutoAttach the current client got a result for.
  autoAttached: Set<string>;
  // Open JavaScript dialogs by page or frame session. One that no client
  // answered blocks every command on its page.
  dialogs: Map<string, { type: string; message: string }>;
  // Dismissals sent as the current client connected, until the session reads
  // them.
  dismissed: Promise<{ type: string; message: string } | undefined>[];
  // The script contexts the current client got for the tab's main frame.
  world: ScriptWorld;
  closed: boolean;
  recovery?: {
    done: Promise<void>;
    finish(): void;
    timer: ReturnType<typeof setTimeout>;
  };
};

// An iframe session. parent is the session its attach came on. Chrome holds a
// new frame until a client resumes it, and announces a frame only once per
// debugger session, so the bridge resumes a frame no client will resume and
// announces each frame to each client, as Chrome does: only once the client
// has turned on auto-attach for the parent.
type ChildFrame = {
  targetInfo: Fields;
  parent: string;
  waiting: boolean;
  deliveredTo?: BridgePeer;
};

// Playwright reads a title in its own isolated world, and it ignores a
// failed Page.createIsolatedWorld: then the read waits with no command in
// flight. Context ids and the world name stay out of every log.
type ScriptWorld = {
  isolated: "none" | "ok" | "error";
  name?: string;
  utility?: number;
  main?: number;
};

type BrowserTab = {
  target: string;
  scope: BrowserGrantScope;
  browser: string;
  title: string;
  url: string;
  officePageRefused?: true;
};

// No HTTP listener or production route is registered here. The caller supplies
// a browser-only hash lookup and live member/agent authorization on every use.
// A member can pair several browsers; each credential has at most one live
// connection, and an agent sees the offers of all of them as one set.
export class BrowserExtensionBridge {
  private live = new Map<string, ExtensionConnection>();
  readonly offices: OfficeOrigins;
  constructor(
    private readonly access: {
      memberForCredentialHash(hash: string): string | undefined;
      browserName?(hash: string): string;
      mayUse(memberId: string, agentId: string): boolean;
      memberDisplay?(member: string): BrowserDisplay;
      agentDisplay?(agent: string): BrowserDisplay;
      agents?(member: string): string[];
      officeOrigins?(): string[];
    },
    private clock: GrantClock = grantClock,
  ) {
    this.offices = new OfficeOrigins(() => access.officeOrigins?.() ?? []);
  }

  connect(credential: string, peer: BridgePeer): ExtensionConnection {
    const hash = browserCredentialHash(credential);
    const member = this.access.memberForCredentialHash(hash);
    if (!member || this.live.has(hash))
      throw new Error("Browser connection refused");
    const connection = new ExtensionConnection(
      member,
      peer,
      (agent) =>
        this.access.memberForCredentialHash(hash) === member &&
        this.access.mayUse(member, agent),
      () => {
        if (this.live.get(hash) === connection) this.live.delete(hash);
      },
      this.access.memberDisplay
        ? () => this.access.memberDisplay!(member)
        : undefined,
      this.access.agentDisplay
        ? (agent) => this.access.agentDisplay!(agent)
        : undefined,
      () => this.access.agents?.(member) ?? [],
      this.clock,
      () => this.access.memberForCredentialHash(hash) === member,
      hash,
      // One individual offer per agent across all of the member's browsers,
      // including offers that are still attaching.
      (agent) => this.connections(member).some((c) => c.holdsAgent(agent)),
      this.offices,
    );
    this.live.set(hash, connection);
    try {
      peer.send({
        kind: "ready",
        version: BROWSER_EXTENSION_PROTOCOL,
        debuggerRecovery: true,
        // The extension sends its ON offers again after a connection loss.
        offerResume: true,
        // The office's extension package, so an older extension can say so.
        package: manifest.version,
        generation: connection.generation,
      });
      connection.sendMetadata();
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  connections(memberId: string): ExtensionConnection[] {
    return [...this.live.values()].filter((c) => c.memberId === memberId);
  }

  forCredentialHash(hash: string): ExtensionConnection | undefined {
    return this.live.get(hash);
  }

  targets(memberId: string, agent: string): BrowserTab[] {
    return this.offers(memberId, agent).map(({ tab }) => tab);
  }

  private offers(
    memberId: string,
    agent: string,
  ): { connection: ExtensionConnection; tab: BrowserTab }[] {
    return this.connections(memberId).flatMap((connection) =>
      connection.targets(agent).map((t) => ({
        connection,
        tab: {
          target: t.target,
          scope: t.scope,
          browser: this.access.browserName?.(connection.credentialHash) ?? "",
          title: t.title,
          url: t.url,
          ...(t.officePageRefused ? { officePageRefused: true as const } : {}),
        },
      })),
    );
  }

  // The individual offer first, then a sole All offer, across all browsers.
  resolve(
    memberId: string,
    agent: string,
    target?: string,
  ):
    | {
        connection: ExtensionConnection;
        grant: string;
        target: string;
        offerOrigin: string | undefined;
      }
    | undefined {
    const offers = this.offers(memberId, agent);
    const chosen =
      target !== undefined
        ? offers.find((o) => o.tab.target === target)
        : (offers.find((o) => o.tab.scope.kind === "agent") ??
          (offers.length === 1 ? offers[0] : undefined));
    if (!chosen) return undefined;
    const grant = chosen.connection.offered(agent, chosen.tab.target);
    return grant
      ? {
          connection: chosen.connection,
          grant,
          target: chosen.tab.target,
          offerOrigin: chosen.connection.offerOrigin(grant),
        }
      : undefined;
  }

  ambiguous(memberId: string, agent: string): boolean {
    const offers = this.offers(memberId, agent);
    return (
      !offers.some((o) => o.tab.scope.kind === "agent") && offers.length > 1
    );
  }
}

export class ExtensionConnection {
  readonly generation = crypto.randomUUID();
  private active = true;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private assignments = new Map<string, Assignment>();
  private gateListeners = new Map<string, Set<() => void>>();
  // leaveOffice waits, keyed by the page session they navigate.
  private leaves = new Set<{
    a: Assignment;
    key: string;
    commit(loaderId: string, url: string): void;
    end(error: Error): void;
  }>();
  constructor(
    readonly memberId: string,
    private peer: BridgePeer,
    private authorize: (agentId: string) => boolean,
    private onClose: () => void,
    private memberDisplay?: () => BrowserDisplay,
    private agentDisplay?: (agent: string) => BrowserDisplay,
    private agents: () => string[] = () => [],
    private clock: GrantClock = grantClock,
    private ownerValid: () => boolean = () => true,
    readonly credentialHash = "",
    private agentTaken: (agentId: string) => boolean = (agentId) =>
      this.holdsAgent(agentId),
    readonly offices: OfficeOrigins = new OfficeOrigins(() => []),
  ) {
    // A new office origin can refuse a page that committed before it was known.
    this.stopLearning = offices.onLearn(() => {
      for (const a of this.assignments.values())
        for (const [key, page] of a.pages)
          if (page.url !== undefined && this.officeRefused(a, page.url))
            this.closeGate(a, key);
    });
  }
  private stopLearning: () => void;

  /** The origin of the page the member offered, pinned at the offer. */
  offerOrigin(grant: string): string | undefined {
    return this.assignments.get(grant)?.offerOrigin;
  }

  /** Commands the office gate refused on this grant so far. */
  officeRefusals(grant: string): number {
    return this.assignments.get(grant)?.officeRefusals ?? 0;
  }

  /** True while the gate of the grant's leaf page is closed. */
  officeGated(grant: string): boolean {
    const a = this.assignments.get(grant);
    return a ? (a.pages.get(this.leaf(a))?.gated ?? false) : false;
  }

  /** Calls listener after each gate close on the grant; returns the
   * unsubscribe. */
  onGateClose(grant: string, listener: () => void): () => void {
    let listeners = this.gateListeners.get(grant);
    if (!listeners) this.gateListeners.set(grant, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.gateListeners.get(grant) === listeners)
        this.gateListeners.delete(grant);
    };
  }

  // The page key of the grant's leaf: a popup's session, or the tab's own.
  private leaf(a: Assignment): string {
    return (
      [...a.popups].find(([, t]) => t.targetId === a.leafTargetId)?.[0] ??
      a.session
    );
  }

  private officeRefused(a: Assignment, url: string): boolean {
    return officePageRefused(url, a.offerOrigin, this.offices.all());
  }

  // Closing stops the page load. The stop is outside this.pending and the
  // action fence, as a capture kick is; receive() drops its late result.
  private closeGate(a: Assignment, key: string): void {
    const page = a.pages.get(key);
    if (!page || page.gated) return;
    page.gated = true;
    this.unfenced(a, "Page.stopLoading", key);
    for (const listener of [...(this.gateListeners.get(a.id) ?? [])])
      listener();
  }

  // A frame that waits for a client no client will resume stays blank, on the
  // member's screen as in every read. Like a stop, outside the action fence.
  private resumeChild(a: Assignment, key: string): void {
    const child = a.children.get(key);
    if (!child?.waiting) return;
    child.waiting = false;
    this.unfenced(a, "Runtime.runIfWaitingForDebugger", key);
  }

  private unfenced(a: Assignment, method: string, key: string): void {
    if (!this.active || a.closed || a.recovery) return;
    try {
      this.peer.send({
        kind: "command",
        generation: this.generation,
        id: ++this.sequence,
        assignment: a.id,
        method: "cdp",
        params: {
          method,
          params: {},
          ...(key === a.session ? {} : { sessionId: key }),
        },
      });
    } catch {
      this.close();
    }
  }

  // The frames under a session the client now auto-attaches that it has not
  // seen: earlier frames, and attaches held until now.
  private announceChildren(a: Assignment, parent: string): void {
    a.autoAttached.add(parent);
    for (const [sessionId, child] of a.children) {
      if (child.parent !== parent || child.deliveredTo === a.peer) continue;
      child.deliveredTo = a.peer;
      a.peer.send({
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...child.targetInfo, attached: true },
          waitingForDebugger: child.waiting,
        },
        sessionId: parent,
      });
    }
  }

  // Events of a page session close or open its gate. An iframe session (key
  // undefined) never does: Chrome refuses to frame an office.
  private officeEvent(
    a: Assignment,
    method: string,
    params: Fields,
    key: string | undefined,
  ): void {
    if (method === "Network.responseReceived") {
      const response = params.response as Fields | undefined;
      const headers = response?.headers;
      if (
        typeof response?.url === "string" &&
        headers &&
        typeof headers === "object" &&
        Object.keys(headers).some(
          (name) => name.toLowerCase() === OFFICE_MARKER_HEADER,
        )
      )
        this.offices.learn(response.url);
    }
    if (key === undefined) return;
    const page = a.pages.get(key);
    if (!page) return;
    const targetId =
      key === a.session ? a.target?.targetId : a.popups.get(key)?.targetId;
    const mainDocument =
      params.type === "Document" && params.frameId === targetId;
    if (method === "Network.requestWillBeSent" && mainDocument) {
      const url = (params.request as Fields | undefined)?.url;
      if (typeof url === "string" && this.officeRefused(a, url))
        this.closeGate(a, key);
    } else if (method === "Network.responseReceived" && mainDocument) {
      const url = (params.response as Fields | undefined)?.url;
      if (typeof url === "string" && this.officeRefused(a, url))
        this.closeGate(a, key);
    } else if (method === "Page.frameNavigated") {
      const frame = params.frame as Fields | undefined;
      if (!frame || frame.parentId !== undefined) return;
      if (typeof frame.url !== "string") return;
      page.url = frame.url;
      if (this.officeRefused(a, frame.url)) this.closeGate(a, key);
      else page.gated = false;
      if (typeof frame.loaderId === "string")
        for (const leave of [...this.leaves])
          if (leave.a === a && leave.key === key)
            leave.commit(frame.loaderId, frame.url);
    }
  }

  // While a page's gate is closed, its commands and its iframes' are refused,
  // except a stop and a navigation away. A navigation to a refused page is
  // refused with the gate open too.
  private officeCommand(
    a: Assignment,
    method: string,
    params: Fields,
    sessionId: string,
  ): void {
    const key =
      sessionId === a.session || a.popups.has(sessionId)
        ? sessionId
        : (a.childPages.get(sessionId) ?? a.session);
    const url =
      method === "Page.navigate" && typeof params.url === "string"
        ? params.url
        : undefined;
    const toRefused = url === undefined || this.officeRefused(a, url);
    // Away from a gated page means another http(s) page: a javascript: or
    // data: URL would run in or replace the office document.
    const allowed = a.pages.get(key)?.gated
      ? method === "Page.stopLoading" ||
        (url !== undefined && httpOrigin(url) !== undefined && !toRefused)
      : method !== "Page.navigate" || !toRefused;
    if (allowed) return;
    a.officeRefusals++;
    throw new Error("Office page refused");
  }

  holdsAgent(agentId: string): boolean {
    return [...this.assignments.values()].some(
      (a) => a.scope.kind === "agent" && a.scope.agentId === agentId,
    );
  }

  assign(
    agentId: string,
    peer: BridgePeer,
    retainGrant = false,
    target?: string,
  ): { receive(message: unknown): Promise<void>; close(): void } {
    const id = this.offered(agentId, target);
    const assignment = id ? this.assignments.get(id) : undefined;
    if (
      !this.active ||
      !this.authorize(agentId) ||
      !assignment?.target ||
      assignment.connected ||
      assignment.recovery ||
      this.pendingCount(assignment.id)
    )
      throw new Error(
        "Offer a tab with Allow agent control in the Chrome extension popup",
      );
    this.check(assignment);
    assignment.peer = peer;
    assignment.connected = true;
    assignment.announced = false;
    assignment.autoAttached = new Set();
    assignment.world = { isolated: "none" };
    this.dismissDialogs(assignment);
    return {
      receive: (message) =>
        assignment.peer === peer && assignment.connected
          ? this.dispatch(assignment, message, agentId, peer)
          : Promise.resolve(),
      close: () => {
        if (assignment.peer !== peer) return;
        if (!retainGrant) {
          this.release(assignment);
          return;
        }
        assignment.connected = false;
        assignment.peer = { send() {}, close() {} };
        for (const key of assignment.children.keys())
          this.resumeChild(assignment, key);
      },
    };
  }

  /** Retires the grant's CDP client and drops its pending commands; the
   * grant, its offer and its deadline stay. A late result of a dropped
   * command reaches nobody, but the command can still run in Chrome. */
  retireClient(grant: string, cause: string): void {
    const a = this.assignments.get(grant);
    if (!a || a.closed) return;
    const dropped = [...this.pending].filter(([, p]) => p.assignment === grant);
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          reason: "client_retired",
          generation: this.generation,
          assignment: grant,
          cause,
          pending: dropped.map(([, p]) => ({
            method: p.method,
            session: p.session,
          })),
          isolatedWorld: a.world.isolated,
          utilityContext: a.world.utility !== undefined,
          mainContext: a.world.main !== undefined,
        }),
    );
    for (const [id, pending] of dropped) {
      clearTimeout(pending.timer);
      pending.settled();
      pending.reject(
        new Error("Browser client retired; pending outcomes may be unknown"),
      );
      this.pending.delete(id);
    }
    // The debugger stays attached, so the frames stay; the next client
    // resumes them (as at a retained close).
    const peer = a.peer;
    a.peer = { send() {}, close() {} };
    a.connected = false;
    a.retirements++;
    for (const key of a.children.keys()) this.resumeChild(a, key);
    peer.close();
  }

  /** The dialogs dismissed as the grant's current client connected, each
   * undefined when Chrome had none open by then. Read once. */
  takeDismissedDialogs(
    grant: string,
  ): Promise<{ type: string; message: string } | undefined>[] {
    const a = this.assignments.get(grant);
    if (!a) return [];
    const dismissed = a.dismissed;
    a.dismissed = [];
    return dismissed;
  }

  // A dialog still open as a client connects opened with no client to answer
  // it, or its client retired first. Only the debugger session that saw it
  // open can answer it, and the extension keeps that one session per tab.
  // Every type is dismissed: no agent action caused a beforeunload here, and
  // accepting it would navigate the member's tab away. Sent before any
  // command of the new client.
  private dismissDialogs(a: Assignment): void {
    a.dismissed = [];
    for (const [key, dialog] of a.dialogs) {
      a.dialogs.delete(key);
      let answer: Promise<Fields>;
      try {
        answer = this.request(a, "cdp", {
          method: "Page.handleJavaScriptDialog",
          params: { accept: false },
          ...(key === a.session ? {} : { sessionId: key }),
        });
      } catch {
        return;
      }
      a.dismissed.push(
        answer.then(
          () => dialog,
          () => undefined,
        ),
      );
    }
  }

  // Dialogs and the main frame's script contexts, from the page's own events.
  private pageEvent(
    a: Assignment,
    method: string,
    params: Fields,
    key: string,
  ): void {
    if (method === "Page.javascriptDialogOpening") {
      a.dialogs.set(key, {
        type: typeof params.type === "string" ? params.type : "alert",
        message: typeof params.message === "string" ? params.message : "",
      });
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      a.dialogs.delete(key);
      return;
    }
    if (key !== a.session) return;
    const world = a.world;
    if (method === "Runtime.executionContextsCleared") {
      world.main = undefined;
      world.utility = undefined;
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const id = params.executionContextId;
      if (id === world.main) world.main = undefined;
      if (id === world.utility) world.utility = undefined;
      return;
    }
    if (method !== "Runtime.executionContextCreated") return;
    const context = params.context as Fields | undefined;
    const aux = context?.auxData as Fields | undefined;
    if (typeof context?.id !== "number" || aux?.frameId !== a.target?.targetId)
      return;
    if (aux?.isDefault === true) world.main = context.id;
    else if (world.name !== undefined && context.name === world.name)
      world.utility = context.id;
  }

  isRecovering(grant: string): boolean {
    return !!this.assignments.get(grant)?.recovery;
  }

  async waitForRecovery(grant: string, maxMs: number): Promise<boolean> {
    const a = this.assignments.get(grant);
    if (!a) return false;
    if (a.recovery) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        a.recovery.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return !a.closed && !a.recovery;
  }

  private accessible(a: Assignment, agent: string): boolean {
    return (
      this.active &&
      this.ownerValid() &&
      this.authorize(agent) &&
      (a.scope.kind === "all" || a.scope.agentId === agent)
    );
  }

  targets(agent: string): {
    target: string;
    scope: BrowserGrantScope;
    title: string;
    url: string;
    officePageRefused?: true;
  }[] {
    const result = [];
    for (const a of this.assignments.values()) {
      if (this.expired(a)) {
        this.release(a);
        continue;
      }
      if (!a.target || !this.accessible(a, agent)) continue;
      const key = this.leaf(a);
      const info = (key === a.session ? a.target : a.popups.get(key)) ?? {};
      const page = a.pages.get(key);
      // Nothing read from a refused office page. Chrome's title belongs to
      // the URL it reported at the offer or the attach, so it goes once the
      // page commits elsewhere.
      if (page?.gated) {
        result.push({
          target: a.handle,
          scope: a.scope,
          title: "",
          url: "",
          officePageRefused: true as const,
        });
        continue;
      }
      const url =
        page?.url ?? (typeof info.url === "string" ? info.url : undefined);
      result.push({
        target: a.handle,
        scope: a.scope,
        title:
          typeof info.title === "string" && url === info.url ? info.title : "",
        url: url ?? "",
      });
    }
    return result;
  }

  offered(agentId: string, target?: string): string | undefined {
    const available = this.targets(agentId);
    const chosen =
      target !== undefined
        ? available.find((a) => a.target === target)
        : (available.find((a) => a.scope.kind === "agent") ??
          (available.length === 1 ? available[0] : undefined));
    return chosen
      ? [...this.assignments.values()].find((a) => a.handle === chosen.target)
          ?.id
      : undefined;
  }

  ambiguous(agent: string): boolean {
    const available = this.targets(agent);
    return (
      !available.some((a) => a.scope.kind === "agent") && available.length > 1
    );
  }

  revoke(agentId: string, target?: string): void {
    const id = this.offered(agentId, target);
    const a = id ? this.assignments.get(id) : undefined;
    if (a) this.release(a);
  }

  private authorized(a: Assignment): boolean {
    return (
      this.ownerValid() &&
      (a.scope.kind === "all" || this.authorize(a.scope.agentId))
    );
  }

  // A resume with both fields, a pinned http(s) origin, and a deadline that
  // its duration allows from now; null for any other resume.
  private resumeOf(
    durationMinutes: BrowserGrantDuration,
    expiresAt: unknown,
    offerOrigin: unknown,
  ): Resume | null {
    if (
      typeof offerOrigin !== "string" ||
      httpOrigin(offerOrigin) !== offerOrigin ||
      !validGrantExpiry(durationMinutes, expiresAt)
    )
      return null;
    const now = this.clock.now();
    if (
      expiresAt !== null &&
      (expiresAt <= now || expiresAt > now + durationMinutes * 60_000)
    )
      return null;
    return { expiresAt, offerOrigin };
  }

  private async offer(
    id: string,
    scope: BrowserGrantScope,
    durationMinutes: BrowserGrantDuration,
    resume?: Resume | null,
  ): Promise<void> {
    if (
      resume === null ||
      !this.ownerValid() ||
      (scope.kind === "agent" && !this.authorize(scope.agentId)) ||
      this.assignments.has(id) ||
      (scope.kind === "agent" && this.agentTaken(scope.agentId))
    ) {
      this.peer.send({
        kind: "offered",
        generation: this.generation,
        assignment: id,
        error: true,
      });
      return;
    }
    const a: Assignment = {
      durationMinutes,
      expiresAt: null,
      id,
      scope,
      handle: offerHandle(this.credentialHash, id),
      session: crypto.randomUUID(),
      browserSession: crypto.randomUUID(),
      peer: { send() {}, close() {} },
      retirements: 0,
      children: new Map(),
      popups: new Map(),
      pages: new Map(),
      childPages: new Map(),
      officeRefusals: 0,
      creating: true,
      connected: false,
      announced: false,
      autoAttached: new Set(),
      dialogs: new Map(),
      dismissed: [],
      world: { isolated: "none" },
      closed: false,
    };
    this.assignments.set(id, a);
    try {
      const result = await this.request(a, "attach", {});
      this.check(a);
      const target = fields(result.targetInfo);
      if (
        target.type !== "page" ||
        typeof target.targetId !== "string" ||
        typeof target.url !== "string" ||
        !/^https?:\/\//.test(target.url) ||
        this.knownTarget(target.targetId)
      )
        throw new Error("Invalid offered target");
      a.target = target;
      // A resumed offer keeps its first pin: a tab that moved onto an office
      // page while the office was away starts behind the gate.
      a.offerOrigin = resume ? resume.offerOrigin : httpOrigin(target.url);
      a.pages.set(a.session, {
        url: target.url,
        gated: this.officeRefused(a, target.url),
      });
      a.creating = false;
      a.expiresAt = resume
        ? resume.expiresAt
        : durationMinutes === 0
          ? null
          : this.clock.now() + durationMinutes * 60_000;
      this.check(a);
      if (a.expiresAt !== null)
        a.cancelExpiry = this.clock.schedule(() => {
          if (this.assignments.get(id) === a) this.release(a);
        }, a.expiresAt - this.clock.now());
      this.peer.send({
        kind: "offered",
        generation: this.generation,
        assignment: id,
        scope,
        durationMinutes,
        expiresAt: a.expiresAt,
        offerOrigin: a.offerOrigin,
      });
      this.sendMetadata();
    } catch {
      this.release(a);
      if (this.active)
        this.peer.send({
          kind: "offered",
          generation: this.generation,
          assignment: id,
          error: true,
        });
    }
  }

  revalidate(): void {
    for (const a of this.assignments.values())
      if (!this.authorized(a) || this.expired(a)) this.release(a);
    this.sendMetadata();
  }

  sendMetadata(): void {
    if (!this.active || !this.memberDisplay || !this.agentDisplay) return;
    this.peer.send({
      kind: "metadata",
      generation: this.generation,
      member: this.memberDisplay(),
      agents: this.agents()
        .filter((agent) => this.authorize(agent))
        .map((agent) => this.agentDisplay!(agent)),
      assignments: [...this.assignments.values()]
        .filter((a) => a.target && this.authorized(a))
        .map((a) => ({
          id: a.id,
          scope: a.scope,
          ...(a.scope.kind === "agent"
            ? { agent: this.agentDisplay!(a.scope.agentId) }
            : {}),
          durationMinutes: a.durationMinutes,
          expiresAt: a.expiresAt,
        })),
    });
  }

  private expired(a: Assignment): boolean {
    return a.expiresAt !== null && this.clock.now() >= a.expiresAt;
  }

  private check(a: Assignment): void {
    if (
      !this.active ||
      a.closed ||
      this.expired(a) ||
      this.assignments.get(a.id) !== a ||
      !this.authorized(a)
    ) {
      this.release(a);
      throw new Error("Browser control ended; pending outcomes may be unknown");
    }
  }

  async stopLoading(grant: string): Promise<void> {
    const a = this.assignments.get(grant);
    if (!a) throw new Error("Browser control ended");
    this.check(a);
    const popup = [...a.popups].find(
      ([, target]) => target.targetId === a.leafTargetId,
    );
    await this.request(a, "cdp", {
      method: "Page.stopLoading",
      params: {},
      sessionId: popup?.[0],
    });
  }

  /** Navigates the grant's leaf away from a refused office page to url, an
   * open http(s) page. Resolves at the first main-frame commit of this
   * navigation to an open URL; rejects at a refused commit, a failed
   * navigation, the leaf's end, or deadline (a performance.now() time). */
  async leaveOffice(
    grant: string,
    url: string,
    deadline: number,
  ): Promise<void> {
    const a = this.assignments.get(grant);
    if (!a) throw new Error("Browser control ended");
    this.check(a);
    // request() skips officeCommand: its rule for a gated page applies here.
    if (httpOrigin(url) === undefined || this.officeRefused(a, url))
      throw new Error("Office page refused");
    const key = this.leaf(a);
    const done = Promise.withResolvers<void>();
    // Commits from the send on: the answer and the commit come in any order.
    const commits = new Map<string, string>();
    let loaderId: string | undefined;
    const settle = (committed: string) => {
      if (this.officeRefused(a, committed))
        done.reject(new Error("Office page refused"));
      else done.resolve();
    };
    const leave = {
      a,
      key,
      commit: (id: string, committed: string) => {
        commits.set(id, committed);
        if (id === loaderId) settle(committed);
      },
      end: (error: Error) => done.reject(error),
    };
    this.leaves.add(leave);
    const timer = setTimeout(
      () => {
        const error = new Error("The navigation did not commit in time");
        // The session settles it as an action timeout.
        error.name = "TimeoutError";
        done.reject(error);
      },
      Math.max(0, deadline - performance.now()),
    );
    try {
      this.request(a, "cdp", {
        method: "Page.navigate",
        params: { url },
        ...(key === a.session ? {} : { sessionId: key }),
      })
        .then((result) => {
          if (typeof result.errorText === "string" && result.errorText)
            throw new Error(`The navigation failed: ${result.errorText}`);
          if (result.isDownload === true)
            throw new Error("The navigation started a download");
          if (typeof result.loaderId !== "string")
            throw new Error("The navigation committed no new document");
          loaderId = result.loaderId;
          const committed = commits.get(loaderId);
          if (committed !== undefined) settle(committed);
        })
        .catch(done.reject);
      await done.promise;
    } finally {
      clearTimeout(timer);
      this.leaves.delete(leave);
    }
  }

  // Rejects the leaveOffice waits on a page that went away (all its pages
  // when key is undefined).
  private endLeaves(a: Assignment, key?: string): void {
    for (const leave of [...this.leaves])
      if (leave.a === a && (key === undefined || leave.key === key))
        leave.end(new Error("The page closed"));
  }

  pendingCount(grant: string): number {
    return [...this.pending.values()].filter((p) => p.assignment === grant)
      .length;
  }

  pendingTimedOut(grant: string): boolean {
    return [...this.pending.values()].some(
      (p) => p.assignment === grant && p.timedOut,
    );
  }

  async drain(grant: string): Promise<void> {
    while (this.pendingCount(grant))
      await Promise.all(
        [...this.pending.values()]
          .filter((p) => p.assignment === grant)
          .map((p) => p.done),
      );
  }

  private request(
    a: Assignment,
    method: string,
    params: Fields,
    sent?: (id: number) => void,
  ): Promise<Fields> {
    this.check(a);
    if (a.recovery)
      return Promise.reject(new Error("Debugger recovery in progress"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let settled!: () => void;
      const done = new Promise<void>((r) => {
        settled = r;
      });
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (method === "attach") {
          this.release(a);
          return;
        }
        // A timeout is not evidence of socket loss. Retain this entry until the
        // real response, ownership loss or the ceiling, so the next action
        // cannot overtake it. After the ceiling the client retires.
        pending.timedOut = true;
        console.info(
          "[browser-extension] " +
            JSON.stringify({
              reason: "command_timed_out",
              generation: this.generation,
              assignment: a.id,
              method: pending.method,
              session: pending.session,
            }),
        );
        this.clock.schedule(() => {
          if (this.pending.get(id) === pending)
            this.retireClient(a.id, "command_unanswered");
        }, FENCE_CEILING_MS);
        reject(new Error(COMMAND_TIMED_OUT));
      }, 30_000);
      const sessionId = method === "cdp" ? params.sessionId : undefined;
      this.pending.set(id, {
        assignment: a.id,
        resolve,
        reject,
        timer,
        done,
        settled,
        timedOut: false,
        method:
          method === "cdp" && typeof params.method === "string"
            ? params.method
            : method,
        session:
          typeof sessionId !== "string" || sessionId === a.session
            ? "main"
            : a.popups.has(sessionId)
              ? "popup"
              : "child",
      });
      sent?.(id);
      try {
        this.peer.send({
          kind: "command",
          generation: this.generation,
          id,
          assignment: a.id,
          method,
          params,
        });
      } catch {
        this.close();
      }
    });
  }

  private knownTarget(targetId: string): boolean {
    return [...this.assignments.values()].some(
      (a) =>
        a.target?.targetId === targetId ||
        [...a.popups.values()].some((t) => t.targetId === targetId) ||
        [...a.children.values()].some(
          (child) => child.targetInfo.targetId === targetId,
        ),
    );
  }

  receive(message: unknown): void {
    if (!this.active) return;
    try {
      const msg = fields(message);
      if (msg.generation !== this.generation) return;
      if (msg.kind === "offer") {
        if (
          typeof msg.assignment !== "string" ||
          !/^[a-f0-9-]{36}$/.test(msg.assignment) ||
          !validGrantScope(msg.scope) ||
          !validGrantDuration(msg.durationMinutes)
        )
          throw new Error("Invalid offer");
        // A refused resume is answered, never closed: a close would make the
        // extension reconnect and send the same resume again.
        const resume =
          "expiresAt" in msg || "offerOrigin" in msg
            ? this.resumeOf(msg.durationMinutes, msg.expiresAt, msg.offerOrigin)
            : undefined;
        void this.offer(msg.assignment, msg.scope, msg.durationMinutes, resume);
        return;
      }
      if (msg.kind === "agents") {
        this.revalidate();
        return;
      }
      if (msg.kind === "result" && typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        const owner = this.assignments.get(pending.assignment);
        if (!owner) return;
        if (!this.authorized(owner) || this.expired(owner)) {
          this.release(owner);
          return;
        }
        this.check(owner);
        const result = msg.error ? undefined : fields(msg.result);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.settled();
        if (pending.timedOut) return;
        if (msg.error) pending.reject(new Error("Browser command failed"));
        else pending.resolve(result!);
        return;
      }
      if (msg.kind !== "event" || typeof msg.assignment !== "string")
        throw new Error("Invalid event");
      const a = this.assignments.get(msg.assignment);
      if (!a) return;
      if (!this.authorized(a) || this.expired(a)) {
        this.release(a);
        return;
      }
      this.check(a);
      if (msg.method === "recovering") {
        if (a.recovery) {
          this.release(a);
          return;
        }
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        a.recovery = {
          done,
          finish,
          timer: setTimeout(() => this.release(a), BROWSER_REATTACH_MS),
        };
        // Retire only this CDP client. Its close cannot revoke the retained
        // grant, and late results cannot enter the next client session.
        const peer = a.peer;
        a.peer = { send() {}, close() {} };
        a.connected = false;
        a.children.clear();
        a.childPages.clear();
        // The reattached debugger is a new session, which cannot answer a
        // dialog the old one saw.
        a.dialogs.clear();
        for (const [id, pending] of this.pending) {
          if (pending.assignment !== a.id) continue;
          clearTimeout(pending.timer);
          pending.settled();
          pending.reject(new Error("Chrome debugger detached"));
          this.pending.delete(id);
        }
        peer.close();
        return;
      }
      if (msg.method === "recovered") {
        if (!a.recovery) {
          this.release(a);
          return;
        }
        clearTimeout(a.recovery.timer);
        a.recovery.finish();
        a.recovery = undefined;
        return;
      }
      if (msg.method === "detached") {
        this.release(a);
        return;
      }
      if (a.recovery || !a.target || typeof msg.method !== "string") return;
      if (msg.method === "popup") {
        const params = fields(msg.params);
        const target = fields(params.targetInfo);
        const openerId = a.leafTargetId ?? a.target.targetId;
        if (
          target.type !== "page" ||
          typeof target.targetId !== "string" ||
          target.openerId !== openerId ||
          this.knownTarget(target.targetId) ||
          typeof params.sessionId !== "string" ||
          a.popups.size >= 8 ||
          [...this.assignments.values()].some(
            (owner) =>
              owner.popups.has(params.sessionId as string) ||
              owner.children.has(params.sessionId as string) ||
              owner.session === params.sessionId ||
              owner.browserSession === params.sessionId,
          )
        )
          throw new Error("Invalid popup");
        a.popups.set(params.sessionId, target);
        a.leafTargetId = target.targetId;
        a.pages.set(params.sessionId, {
          url: typeof target.url === "string" ? target.url : undefined,
          gated: false,
        });
        if (typeof target.url === "string" && this.officeRefused(a, target.url))
          this.closeGate(a, params.sessionId);
        a.peer.send({
          method: "Target.attachedToTarget",
          params: {
            sessionId: params.sessionId,
            targetInfo: { ...target, attached: true },
            waitingForDebugger: false,
          },
        });
        return;
      }
      if (msg.method === "popupDetached") {
        const params = fields(msg.params);
        if (typeof params.sessionId !== "string") return;
        const popup = a.popups.get(params.sessionId);
        if (!popup) return;
        a.popups.delete(params.sessionId);
        a.pages.delete(params.sessionId);
        a.dialogs.delete(params.sessionId);
        this.endLeaves(a, params.sessionId);
        for (const [child, page] of a.childPages)
          if (page === params.sessionId) a.childPages.delete(child);
        if (a.leafTargetId === popup.targetId)
          a.leafTargetId = popup.openerId as string;
        a.peer.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: params.sessionId, targetId: popup.targetId },
        });
        return;
      }

      const child =
        typeof msg.sessionId === "string" ? msg.sessionId : undefined;
      if (child && !a.children.has(child) && !a.popups.has(child)) return;
      const params = fields(msg.params);
      this.pageEvent(a, msg.method, params, child ?? a.session);
      // The page this session belongs to: the tab, a popup, or, for an
      // iframe session, the page that holds it.
      const page =
        child === undefined
          ? a.session
          : a.popups.has(child)
            ? child
            : (a.childPages.get(child) ?? a.session);
      this.officeEvent(
        a,
        msg.method,
        params,
        child === undefined || a.popups.has(child) ? page : undefined,
      );
      if (msg.method === "Target.attachedToTarget") {
        const info = fields(params.targetInfo);
        if (
          info.type !== "iframe" ||
          typeof info.targetId !== "string" ||
          typeof params.sessionId !== "string" ||
          this.knownTarget(info.targetId) ||
          [...this.assignments.values()].some(
            (owner) =>
              owner.children.has(params.sessionId as string) ||
              owner.popups.has(params.sessionId as string) ||
              owner.session === params.sessionId ||
              owner.browserSession === params.sessionId,
          )
        )
          throw new Error("Invalid child target");
        const parent = child ?? a.session;
        const frame: ChildFrame = {
          targetInfo: info,
          parent,
          waiting: params.waitingForDebugger === true,
        };
        a.children.set(params.sessionId, frame);
        a.childPages.set(params.sessionId, page);
        // Held until the client auto-attaches the parent; with no client,
        // nobody else resumes the frame.
        if (!a.connected || !a.autoAttached.has(parent)) {
          if (!a.connected) this.resumeChild(a, params.sessionId);
          return;
        }
        frame.deliveredTo = a.peer;
      } else if (msg.method === "Target.detachedFromTarget") {
        if (typeof params.sessionId !== "string") return;
        const frame = a.children.get(params.sessionId);
        if (!frame) return;
        a.children.delete(params.sessionId);
        a.childPages.delete(params.sessionId);
        a.dialogs.delete(params.sessionId);
        if (frame.deliveredTo !== a.peer) return;
      } else if (msg.method.startsWith("Target.")) return;
      a.peer.send({
        method: msg.method,
        params,
        sessionId: child || a.session,
      });
    } catch {
      this.close();
    }
  }

  private async dispatch(
    a: Assignment,
    message: unknown,
    actor: string,
    peer: BridgePeer,
  ): Promise<void> {
    let msg: Fields;
    try {
      msg = fields(message);
    } catch {
      this.release(a);
      return;
    }
    const { id, method, sessionId } = msg;
    if (!Number.isSafeInteger(id) || typeof method !== "string") {
      this.release(a);
      return;
    }
    try {
      this.check(a);
      if (a.peer !== peer || !this.accessible(a, actor))
        throw new Error("Browser control ended");
      const result = await this.command(
        a,
        method,
        fields(msg.params ?? {}),
        sessionId,
      );
      this.check(a);
      if (!this.accessible(a, actor)) throw new Error("Browser control ended");
      if (a.peer === peer) peer.send({ id, sessionId, result });
    } catch {
      if (this.active && !a.closed && a.peer === peer)
        peer.send({
          id,
          sessionId,
          error: { code: -32000, message: "Browser command refused or failed" },
        });
    }
  }

  private async command(
    a: Assignment,
    method: string,
    params: Fields,
    sessionId: unknown,
  ): Promise<Fields> {
    // A public newBrowserCDPSession remains a view of this assignment only.
    if (sessionId === a.browserSession) sessionId = undefined;
    if (sessionId === undefined) {
      switch (method) {
        case "Target.attachToBrowserTarget":
          return { sessionId: a.browserSession };
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: "Chrome/Extension",
            userAgent: "Chrome/Extension",
            revision: "",
          };
        case "Target.setAutoAttach":
          if (a.target && !a.announced) {
            a.announced = true;
            a.peer.send({
              method: "Target.attachedToTarget",
              params: {
                sessionId: a.session,
                targetInfo: { ...a.target, attached: true },
                waitingForDebugger: false,
              },
            });
            for (const [sessionId, target] of a.popups)
              a.peer.send({
                method: "Target.attachedToTarget",
                params: {
                  sessionId,
                  targetInfo: { ...target, attached: true },
                  waitingForDebugger: false,
                },
              });
          }
          return {};
        case "Target.getTargets":
          return {
            targetInfos: a.target ? [a.target, ...a.popups.values()] : [],
          };
        case "Target.getTargetInfo":
          if (
            params.targetId !== undefined &&
            params.targetId !== a.target?.targetId
          )
            throw new Error("Unknown target");
          return a.target ? { targetInfo: a.target } : {};
        default:
          throw new Error("Unsupported browser command");
      }
    }
    if (
      typeof sessionId !== "string" ||
      !a.target ||
      (sessionId !== a.session &&
        !a.children.has(sessionId) &&
        !a.popups.has(sessionId))
    )
      throw new Error("Unknown session");
    if (method === "Target.getTargetInfo") {
      if (
        params.targetId !== undefined &&
        params.targetId !==
          (a.popups.get(sessionId)?.targetId ?? a.target.targetId)
      )
        throw new Error("Unknown target");
      return { targetInfo: a.popups.get(sessionId) ?? a.target };
    }
    if (!pageCommandAllowed(method, params))
      throw new Error("Unsupported page command");
    this.officeCommand(a, method, params, sessionId);
    const target = sessionId === a.session ? undefined : sessionId;
    if (method === "Runtime.runIfWaitingForDebugger") {
      const child = a.children.get(sessionId);
      if (child) child.waiting = false;
    }
    if (
      method === "Page.createIsolatedWorld" &&
      sessionId === a.session &&
      params.frameId === a.target.targetId
    ) {
      const world = a.world;
      if (typeof params.worldName === "string") world.name = params.worldName;
      try {
        const result = await this.request(a, "cdp", {
          method,
          params,
          sessionId: target,
        });
        world.isolated = "ok";
        return result;
      } catch (error) {
        world.isolated = "error";
        throw error;
      }
    }
    if (method === "Target.setAutoAttach") {
      const peer = a.peer;
      const result = await this.request(a, "cdp", {
        method,
        params,
        sessionId: target,
      });
      // In the same step as the result, so no attach falls in between.
      if (a.peer === peer && a.connected) this.announceChildren(a, sessionId);
      return result;
    }
    if (method === "Page.getFrameTree" && !a.children.has(sessionId)) {
      // A new client's first look at a page that may have committed while no
      // client watched.
      const result = await this.request(a, "cdp", {
        method,
        params,
        sessionId: target,
      });
      const tree = result.frameTree as Fields | undefined;
      const url = (tree?.frame as Fields | undefined)?.url;
      const page = a.pages.get(sessionId);
      if (page && typeof url === "string" && !a.closed) {
        page.url = url;
        if (this.officeRefused(a, url)) this.closeGate(a, sessionId);
      }
      return result;
    }
    if (method !== "Page.captureScreenshot")
      return this.request(a, "cdp", { method, params, sessionId: target });
    if (params.captureBeyondViewport === true)
      return this.fencedCapture(a, params, target);
    let capture: number | undefined;
    const result = this.request(
      a,
      "cdp",
      { method, params, sessionId: target },
      (id) => {
        capture = id;
      },
    );
    if (capture !== undefined) {
      const stop = this.kickCapture(a, capture, params, target);
      result.then(stop, stop);
    }
    return result;
  }

  // A kick copies the capture's parameters: Chrome answers the stuck capture
  // with the kick's image, so a 1x1 kick made the screenshot a 1x1 image.
  // A viewport capture's kick is the one command outside this.pending and the
  // action fence: it only reads, and a kick that gets no answer must not hold
  // the next action. receive() drops its late result, because its id is not
  // pending.
  private kickCapture(
    a: Assignment,
    capture: number,
    params: Fields,
    sessionId: unknown,
  ): () => void {
    let cancel = () => {};
    let kicks = 0;
    const kick = () => {
      const pending = this.pending.get(capture);
      if (!pending || pending.timedOut) return;
      try {
        this.check(a);
      } catch {
        return;
      }
      if (!a.recovery) {
        try {
          this.peer.send({
            kind: "command",
            generation: this.generation,
            id: ++this.sequence,
            assignment: a.id,
            method: "cdp",
            params: { method: "Page.captureScreenshot", params, sessionId },
          });
        } catch {
          this.close();
          return;
        }
      }
      cancel = this.clock.schedule(kick, captureKickDelay(++kicks));
    };
    cancel = this.clock.schedule(kick, captureKickDelay(0));
    return () => cancel();
  }

  // A full-page kick copies the capture's parameters as above, but it is
  // fenced: captureBeyondViewport restores the viewport when it finishes, so
  // a late kick could reset it in the middle of the next action. The kicks are
  // ordinary commands, and the capture is answered only after it and all its
  // kicks settle. Kicks continue while any of them is unanswered, because a
  // kick sent as the capture finishes can stick too, and the next kick frees
  // it. Each kick still ends at its own 30 s command timeout, and the doubled
  // delay outgrows that timeout, so at most 7 kicks go out, all by about 38 s.
  // If the capture is still unanswered, the ceiling retires the client at
  // about 60 s, and the chain stops: a retired client sends no kick. Kicks after the action
  // deadline are intended: they stay inside the fence, and they can free the
  // retained capture so that the fence drains sooner. The capture's own
  // failure wins; a failed kick is ignored, but a kick that times out after a
  // good capture makes the action time out, as any stuck command does.
  private async fencedCapture(
    a: Assignment,
    params: Fields,
    sessionId: unknown,
  ): Promise<Fields> {
    const command = { method: "Page.captureScreenshot", params, sessionId };
    const retirements = a.retirements;
    let open = 1;
    const settle = (sent: Promise<Fields>) =>
      sent.then(
        (result) => {
          open--;
          return { result };
        },
        (error: unknown) => {
          open--;
          return { error };
        },
      );
    const capture = settle(this.request(a, "cdp", command));
    const kicks: ReturnType<typeof settle>[] = [];
    let cancel = () => {};
    const kick = () => {
      if (open === 0 || a.retirements !== retirements) return;
      let sent: Promise<Fields>;
      try {
        sent = this.request(a, "cdp", command);
      } catch {
        return;
      }
      open++;
      kicks.push(settle(sent));
      cancel = this.clock.schedule(kick, captureKickDelay(kicks.length));
    };
    cancel = this.clock.schedule(kick, captureKickDelay(0));
    const outcome = await capture;
    let kicked: Awaited<ReturnType<typeof settle>>[] = [];
    while (kicked.length < kicks.length) kicked = await Promise.all([...kicks]);
    cancel();
    if ("error" in outcome) throw outcome.error;
    const timedOut = kicked.find(
      (k) =>
        "error" in k &&
        k.error instanceof Error &&
        k.error.message === COMMAND_TIMED_OUT,
    );
    if (timedOut && "error" in timedOut) throw timedOut.error;
    return outcome.result;
  }

  private release(a: Assignment): void {
    if (a.closed) return;
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          reason: "grant_released",
          generation: this.generation,
          assignment: a.id,
          controlSession: a.session,
          pending: this.pendingCount(a.id),
        }),
    );
    a.closed = true;
    this.endLeaves(a);
    if (a.recovery) {
      clearTimeout(a.recovery.timer);
      a.recovery.finish();
      a.recovery = undefined;
    }
    a.cancelExpiry?.();
    this.assignments.delete(a.id);
    for (const [id, pending] of this.pending) {
      if (pending.assignment !== a.id) continue;
      clearTimeout(pending.timer);
      pending.settled();
      pending.reject(
        new Error("Browser control ended; pending outcomes may be unknown"),
      );
      this.pending.delete(id);
    }
    if (this.active) {
      try {
        this.peer.send({
          kind: "command",
          generation: this.generation,
          id: ++this.sequence,
          assignment: a.id,
          method: "detach",
          params: {},
        });
      } catch {}
    }
    a.peer.close();
    this.sendMetadata();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.settled();
      pending.reject(
        new Error("Browser disconnected; pending outcomes may be unknown"),
      );
    }
    this.pending.clear();
    for (const a of this.assignments.values()) this.release(a);
    this.stopLearning();
    this.onClose();
    this.peer.close();
  }
}
