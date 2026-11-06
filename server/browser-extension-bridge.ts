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
  SCREENCAST_KICK_PARAMS,
  type BridgePeer,
  type Fields,
  type BrowserDisplay,
  EXTENSION_MAX_BYTES,
  httpOrigin,
  trimOversizedEvent,
  BROWSER_ATTACH_FAILURES,
  BROWSER_DETACH_CAUSES,
  type BrowserAttachFailure,
  type AgentTabsScope,
  type BrowserAccess,
  validBrowserAccess,
  validAgentTabsScope,
  validExtensionPackage,
  shareableUrl,
  type ShareAgent,
} from "../shared/browser-extension-protocol";
import { formatSharedPage } from "../shared/browser-share";
export { EXTENSION_MAX_BYTES };
import {
  OFFICE_MARKER_HEADER,
  OfficeOrigins,
  officeAppSignIn,
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
// origin that the office answered at the first offer. A tab that an agent
// opened has neither: it never expires and has no pin.
type Resume = { expiresAt: number | null; offerOrigin?: string };

// The offers an action without a target chooses from: the agent's own tabs
// (the tabs it opened, and an individual offer from an extension older than
// 0.6.0), else the shared offers (all, office, shared) of its manager's
// browsers, else the shared offers of other members. The one rule for the
// bridge and for each connection.
function routingTier<T>(
  offers: T[],
  scope: (offer: T) => BrowserGrantScope,
  fromManager: (offer: T) => boolean,
): T[] {
  const own = offers.filter((o) => {
    const kind = scope(o).kind;
    return kind === "agent" || kind === "opened";
  });
  if (own.length) return own;
  const managers = offers.filter(fromManager);
  return managers.length ? managers : offers;
}

// An opened tab starts on about:blank; any other page must be http(s).
const openedPageAllowed = (url: string): boolean =>
  url === "about:blank" || /^https?:\/\//.test(url);

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
// Chrome can leave a capture of a hidden tab unanswered while no other tab
// draws (Chrome 151 under Xvfb, task c04479de). A screencast on the tab makes
// Chrome draw it, and the capture then answers with its own image. A second
// capture frees it too, but two captures of one tab in flight can leave the
// tab frozen or empty in the member's window (task f6dc01e6), so a kick is
// never a capture. A capture still unanswered after CAPTURE_KICK_MS gets one.
export const CAPTURE_KICK_MS = 300;
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
  // The agent of the current client, from its assign.
  actor?: string;
  // Clients retired so far; work of a retired client sends nothing new.
  retirements: number;
  // Debugger reattaches so far (recovery). A reattach ends a capture kick's
  // screencast with the old debugger session.
  reattaches: number;
  target?: Fields;
  // The tab's main frame id. After Chrome activates a prerendered page in the
  // tab, it is not the tab's target id, and Playwright, which finds the main
  // frame by the page's target id, never sets the page up
  // (microsoft/playwright#41397). The client knows the tab by this id.
  pageId?: string;
  children: Map<string, ChildFrame>;
  popups: Map<string, Fields>;
  leafTargetId?: string;
  // The office gate (browser-office-gate.ts). The offer origin is pinned at the
  // offer. Pages are keyed by CDP session: the tab's own, or a popup's.
  offerOrigin?: string;
  // refusals counts the page's gate closes, so a reopen can tell that a
  // later refusal came after the stop it answers.
  pages: Map<string, { url?: string; gated: boolean; refusals: number }>;
  childPages: Map<string, string>;
  officeRefusals: number;
  // Commands whose answer was too large to relay (receiveOversized).
  answersTooLarge: number;
  state: GrantState;
  // Sessions whose Target.setAutoAttach the current client got a result for.
  autoAttached: Set<string>;
  // Open JavaScript dialogs by page or frame session. One that is open blocks
  // every command on its page.
  dialogs: Map<string, { type: string; message: string }>;
  // The script contexts the current client got for the tab's main frame.
  world: ScriptWorld;
};

// The grant's phase. Every change goes through enter(), which allows only
// these moves and ignores any other:
//   offer done          creating -> offered
//   assign              offered -> attached
//   retained close      attached -> offered
//   retireClient        attached -> offered
//   "recovering" event  creating, offered, attached -> recovering
//                       (from recovering: release, recovery_unexpected)
//   "recovered" event   recovering -> offered (otherwise: release)
//   release             any -> released; released is terminal
// Leaving attached drops the action fence with its ceiling and resets the
// client peer; leaving recovering clears its timer and resolves done.
type GrantState =
  | { kind: "creating" }
  | { kind: "offered" }
  | {
      kind: "attached";
      // The client's announce of the tab: in flight, then done.
      announcing?: Promise<void>;
      announced: boolean;
      fence?: { cancel(): void };
    }
  | {
      kind: "recovering";
      done: Promise<void>;
      finish(): void;
      timer: ReturnType<typeof setTimeout>;
    }
  | { kind: "released" };
type GrantKind = GrantState["kind"];
const LIVE: readonly GrantKind[] = [
  "creating",
  "offered",
  "attached",
  "recovering",
];
const noPeer = (): BridgePeer => ({ send() {}, close() {} });

// A timed-out action's work in flight, from ExtensionConnection.fence().
export type ActionFence = { held(): boolean; lift(): void };

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
  // The member whose browser it is.
  member: string;
  title: string;
  url: string;
  officePageRefused?: true;
};

// No HTTP listener or production route is registered here. The caller supplies
// a browser-only hash lookup and live member/agent authorization on every use.
// A member can pair several browsers; each credential has at most one live
// connection, and an agent sees the offers of all of them as one set. An
// agent also sees the "office" offers of other members who can reach it.
export class BrowserExtensionBridge {
  private live = new Map<string, ExtensionConnection>();
  readonly offices: OfficeOrigins;
  constructor(
    private readonly access: {
      memberForCredentialHash(hash: string): string | undefined;
      browserName?(hash: string): string;
      // The browser's id in the store, for agentTabBrowsers.
      browserId?(hash: string): string;
      mayUse(memberId: string, agentId: string): boolean;
      mayReach?(memberId: string, agentId: string): boolean;
      // The member who manages the agent, or undefined for an unknown agent.
      managerOf?(agentId: string): string | undefined;
      memberDisplay?(member: string): BrowserDisplay;
      agentDisplay?(agent: string): BrowserDisplay;
      agents?(member: string): string[];
      officeOrigins?(): string[];
      // The extension's store listing, sent in ready when there is one.
      storeUrl?: string | null;
      // The name of the agent's room, for the share picker.
      agentRoom?(agent: string): string;
      // Delivers a shared page to the agent as the member's message.
      share?(
        member: string,
        agentId: string,
        text: string,
      ): Promise<{ ok: true } | { ok: false; code: string }>;
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
      (agent) =>
        this.access.memberForCredentialHash(hash) === member &&
        !!this.access.mayReach?.(member, agent),
      (agent) => this.access.managerOf?.(agent),
      this.access.memberDisplay
        ? (other) => this.access.memberDisplay!(other)
        : undefined,
      this.access.share
        ? {
            room: (agent) => this.access.agentRoom?.(agent) ?? "",
            deliver: (agent, text) => this.access.share!(member, agent, text),
          }
        : undefined,
    );
    this.live.set(hash, connection);
    try {
      peer.send({
        kind: "ready",
        version: BROWSER_EXTENSION_PROTOCOL,
        debuggerRecovery: true,
        // The extension sends its ON offers again after a connection loss.
        offerResume: true,
        // The office takes offers to every agent the member can reach.
        officeScope: true,
        // Members can let agents open their own tabs (task 73a9fb57).
        agentTabs: true,
        // The extension sends {kind:"access"} and offers "shared" tabs.
        access: true,
        // The extension sends {kind:"files"} and takes {kind:"reload"}.
        reload: true,
        // The extension sends {kind:"share"} (task 68da3968).
        ...(this.access.share ? { share: true } : {}),
        // The office's extension package, so an older extension can say so.
        package: manifest.version,
        // An unpacked extension links the store listing.
        ...(this.access.storeUrl ? { storeUrl: this.access.storeUrl } : {}),
        generation: connection.generation,
      });
      connection.sendMetadata();
    } catch (error) {
      connection.close("send_failed");
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

  // manager: the agent's manager, whose browsers come first.
  targets(manager: string | undefined, agent: string): BrowserTab[] {
    return this.offers(manager, agent).map(({ tab }) => tab);
  }

  // Every browser's offers the agent can use: another member's browser
  // yields only its "office" offers, since the others need the manager.
  private offers(
    manager: string | undefined,
    agent: string,
  ): { connection: ExtensionConnection; tab: BrowserTab }[] {
    const live = [...this.live.values()];
    return [
      ...live.filter((c) => c.memberId === manager),
      ...live.filter((c) => c.memberId !== manager),
    ].flatMap((connection) =>
      connection.targets(agent).map((t) => ({
        connection,
        tab: {
          target: t.target,
          scope: t.scope,
          browser: this.access.browserName?.(connection.credentialHash) ?? "",
          member: this.access.memberDisplay?.(connection.memberId).name ?? "",
          title: t.title,
          url: t.url,
          ...(t.officePageRefused ? { officePageRefused: true as const } : {}),
        },
      })),
    );
  }

  // Without a target: the agent's own tab, else a sole offer from
  // its manager's browsers, else a sole offer of another member.
  private choose(
    manager: string | undefined,
    agent: string,
  ): {
    offers: { connection: ExtensionConnection; tab: BrowserTab }[];
    chosen?: { connection: ExtensionConnection; tab: BrowserTab };
  } {
    const tier = routingTier(
      this.offers(manager, agent),
      (o) => o.tab.scope,
      (o) => o.connection.memberId === manager,
    );
    return { offers: tier, chosen: tier.length === 1 ? tier[0] : undefined };
  }

  resolve(
    manager: string | undefined,
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
    const chosen =
      target !== undefined
        ? this.offers(manager, agent).find((o) => o.tab.target === target)
        : this.choose(manager, agent).chosen;
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

  ambiguous(manager: string | undefined, agent: string): boolean {
    return this.choose(manager, agent).offers.length > 1;
  }

  /** The connected browsers where the agent may open a tab: the manager's
   * first, then other members' browsers with agent tabs for All agents. */
  agentTabBrowsers(
    manager: string | undefined,
    agent: string,
  ): AgentTabBrowser[] {
    return this.openers(manager, agent).map(({ entry }) => entry);
  }

  /** Whether a connected browser of the manager lets the agent open a tab,
   * so open without a browser named uses it or asks for one. */
  mayOpen(manager: string | undefined, agent: string): boolean {
    return this.openers(manager, agent).some(
      (o) => o.connection.memberId === manager,
    );
  }

  private openers(
    manager: string | undefined,
    agent: string,
  ): {
    connection: ExtensionConnection;
    via: AgentTabsScope;
    entry: AgentTabBrowser;
  }[] {
    const live = [...this.live.values()];
    return [
      ...live.filter((c) => c.memberId === manager),
      ...live.filter((c) => c.memberId !== manager),
    ].flatMap((connection) => {
      const via = connection.openVia(agent);
      return via
        ? [
            {
              connection,
              via,
              entry: {
                id: this.access.browserId?.(connection.credentialHash) ?? "",
                browser:
                  this.access.browserName?.(connection.credentialHash) ?? "",
                member:
                  this.access.memberDisplay?.(connection.memberId).name ?? "",
              },
            },
          ]
        : [];
    });
  }

  /** Opens a tab for the agent in a browser of its manager, or in browser
   * (an id or a name from agentTabBrowsers). The tab shows about:blank; the
   * caller navigates it. */
  async open(
    manager: string | undefined,
    agent: string,
    browser?: string,
  ): Promise<OpenResult> {
    const openers = this.openers(manager, agent);
    const candidates =
      browser === undefined
        ? openers.filter((o) => o.connection.memberId === manager)
        : openers.filter(
            (o) => o.entry.id === browser || o.entry.browser === browser,
          );
    if (candidates.length > 1)
      return {
        ok: false,
        code: "browser_target_required",
        browsers: candidates.map((o) => o.entry),
      };
    const chosen = candidates[0];
    if (!chosen) {
      if (browser !== undefined) return { ok: false, code: "invalid_request" };
      return {
        ok: false,
        code:
          manager !== undefined && this.connections(manager).length
            ? "agent_tabs_off"
            : "browser_offline",
      };
    }
    const opened = await chosen.connection.openTab(
      agent,
      chosen.via,
      manager === undefined
        ? undefined
        : this.access.memberDisplay?.(manager).name,
    );
    return "target" in opened
      ? {
          ok: true,
          connection: chosen.connection,
          target: opened.target,
          browser: chosen.entry.browser,
          member: chosen.entry.member,
        }
      : { ok: false, code: opened.code };
  }
}

export type AgentTabBrowser = { id: string; browser: string; member: string };
export type OpenResult =
  | {
      ok: true;
      connection: ExtensionConnection;
      target: string;
      browser: string;
      member: string;
    }
  | {
      ok: false;
      code:
        | "agent_tabs_off"
        | "browser_offline"
        | "browser_target_required"
        | "invalid_request"
        | "action_failed";
      // The candidates, for browser_target_required.
      browsers?: AgentTabBrowser[];
    };

function listen(
  map: Map<string, Set<() => void>>,
  grant: string,
  listener: () => void,
): () => void {
  let listeners = map.get(grant);
  if (!listeners) map.set(grant, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && map.get(grant) === listeners) map.delete(grant);
  };
}

// Why a grant ended, in its grant_released line (task 694e958e).
type ReleaseCause =
  | "agent_tabs_changed"
  | "attach_timeout"
  | "bad_client_message"
  | "check_failed"
  | "client_closed"
  | "connection_closed"
  | "expired"
  | "extension_detached"
  | "message_expired"
  | "message_unauthorized"
  | "offer_failed"
  | "receive_error"
  | "recovery_timeout"
  | "recovery_unexpected"
  | "revalidate_expired"
  | "revalidate_unauthorized"
  | "revoked"
  | "too_large";

// A command the extension answered with a failure. An attach failure carries
// the extension's reason when it is one from the list.
class CommandFailedError extends Error {
  readonly attachReason?: BrowserAttachFailure;
  constructor(reason: unknown) {
    super("Browser command failed");
    if (BROWSER_ATTACH_FAILURES.some((known) => known === reason))
      this.attachReason = reason as BrowserAttachFailure;
  }
}

// The extension's cause in a "detached" event, when it is one from the list.
function extensionCause(params: unknown): Fields {
  const cause =
    params && typeof params === "object" ? (params as Fields).cause : undefined;
  return BROWSER_DETACH_CAUSES.some((known) => known === cause)
    ? { extensionCause: cause }
    : {};
}

// The routing fields of an extension message, for a log line: never its
// params or result, which can carry page content.
function envelope(msg: Fields): Fields {
  return {
    ...(typeof msg.kind === "string" ? { kind: msg.kind } : {}),
    ...(typeof msg.id === "number" ? { id: msg.id } : {}),
    ...(typeof msg.method === "string" ? { method: msg.method } : {}),
    ...(typeof msg.assignment === "string"
      ? { assignment: msg.assignment }
      : {}),
  };
}

export class ExtensionConnection {
  readonly generation = crypto.randomUUID();
  // The version of the extension files on disk, from the last files report.
  files?: string;
  // The extension's package from its hello; null when it carried none.
  extensionPackage?: string | null;
  // Its hello said it is a store install.
  storeInstall = false;
  private active = true;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  // Started capture kicks not yet answered, to the grant id: their answers
  // reach no client, and a refused one is logged (kickCapture).
  private kicks = new Map<number, string>();
  private assignments = new Map<string, Assignment>();
  private gateListeners = new Map<string, Set<() => void>>();
  private tooLargeListeners = new Map<string, Set<() => void>>();
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
    // Every agent the member can reach: the audience of an "office" offer.
    private reach: (agentId: string) => boolean = () => false,
    private managerOf: (agentId: string) => string | undefined = () =>
      undefined,
    private otherMemberDisplay?: (member: string) => BrowserDisplay,
    // The office takes shares: the agent's room name, and the delivery of
    // the message as the member's.
    private shares?: {
      room(agent: string): string;
      deliver(
        agent: string,
        text: string,
      ): Promise<{ ok: true } | { ok: false; code: string }>;
    },
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
  // Until the extension says, only the member's own agents use the browser.
  private browserAccess: BrowserAccess = {
    agents: "mine",
    members: [],
    openTabs: false,
  };

  // How agent may open a tab here, or undefined: "all" when the member
  // manages the agent, "office" when the access admits it otherwise. via
  // only names the tab's manager in the popup; the access decides.
  openVia(agent: string): AgentTabsScope | undefined {
    if (!this.active || !this.browserAccess.openTabs || !this.admits(agent))
      return;
    return this.authorize(agent) ? "all" : "office";
  }

  /** Opens an about:blank tab for agent in this browser. Resolves with its
   * target, or with why it was not opened; a failed open leaves no grant. */
  async openTab(
    agent: string,
    via: AgentTabsScope,
    managerName?: string,
  ): Promise<
    { target: string } | { code: "agent_tabs_off" | "action_failed" }
  > {
    const scope: BrowserGrantScope = { kind: "opened", agentId: agent, via };
    if (this.openVia(agent) !== via) return { code: "agent_tabs_off" };
    const a = this.newAssignment(crypto.randomUUID(), scope, 0);
    this.assignments.set(a.id, a);
    const failure = await this.establish(a, "open", {
      agentId: agent,
      agentName: this.agentDisplay?.(agent).name ?? agent,
      scope,
      ...(via === "office" && managerName ? { managerName } : {}),
    });
    if (!failure) return { target: a.handle };
    return {
      code:
        failure instanceof CommandFailedError &&
        failure.attachReason === "agent_tabs_off"
          ? "agent_tabs_off"
          : "action_failed",
    };
  }

  // The member changed the access: tabs agents opened that it no longer
  // admits end, and so do the live clients of agents it no longer admits.
  private setAccess(access: BrowserAccess): void {
    this.browserAccess = access;
    for (const a of [...this.assignments.values()])
      if (a.scope.kind === "opened" && !this.authorized(a))
        this.release(a, "agent_tabs_changed");
      else this.cutActor(a, "access_changed");
    this.sendMetadata();
  }

  // An extension older than access sends only its agent tabs setting.
  private setAgentTabs(scope: AgentTabsScope | null): void {
    this.setAccess({
      agents:
        scope === null
          ? this.browserAccess.agents
          : scope === "office"
            ? "office"
            : "mine",
      members: this.browserAccess.members,
      openTabs: scope !== null,
    });
  }

  // A grant's live client whose agent may no longer use it is cut; the grant
  // stays for the agents that still may.
  private cutActor(a: Assignment, cause: string): void {
    if (
      a.state.kind === "attached" &&
      a.actor !== undefined &&
      !this.accessible(a, a.actor)
    )
      this.retireClient(a.id, cause);
  }

  /** The member's access setting, as the extension last said. */
  get access(): BrowserAccess {
    return this.browserAccess;
  }

  /** Whose agents may open tabs in this browser: "all" for the member's own
   * agents, "members" also the picked members', "office" every agent they
   * reach; null when agent tabs are off or the extension never said. */
  get agentTabs(): "all" | "members" | "office" | null {
    const { agents, openTabs } = this.browserAccess;
    if (!openTabs) return null;
    return agents === "mine" ? "all" : agents;
  }

  /** Asks the extension to reload, so Chrome loads the files on disk. */
  reload(): void {
    this.peer.send({ kind: "reload", generation: this.generation });
  }

  /** The origin of the page the member offered, pinned at the offer. */
  offerOrigin(grant: string): string | undefined {
    return this.assignments.get(grant)?.offerOrigin;
  }

  /** Commands the office gate refused on this grant so far. */
  officeRefusals(grant: string): number {
    return this.assignments.get(grant)?.officeRefusals ?? 0;
  }

  /** Commands on this grant whose answer was too large to relay so far. */
  answersTooLarge(grant: string): number {
    return this.assignments.get(grant)?.answersTooLarge ?? 0;
  }

  /** True while the gate of the grant's leaf page is closed. */
  officeGated(grant: string): boolean {
    const a = this.assignments.get(grant);
    return a ? (a.pages.get(this.leaf(a))?.gated ?? false) : false;
  }

  /** Calls listener after each gate close on the grant; returns the
   * unsubscribe. */
  onGateClose(grant: string, listener: () => void): () => void {
    return listen(this.gateListeners, grant, listener);
  }

  /** Calls listener when a command of the grant gets an answer too large to
   * relay; returns the unsubscribe. */
  onAnswerTooLarge(grant: string, listener: () => void): () => void {
    return listen(this.tooLargeListeners, grant, listener);
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

  // Closing stops the page load, also on a page already closed. A stop can
  // leave the tab on its last page with no new commit, so when the stop
  // answers, the gate reopens if the page the tab shows is not refused and
  // no refusal came after this stop. A failed read keeps it closed.
  private closeGate(a: Assignment, key: string): void {
    const page = a.pages.get(key);
    if (!page) return;
    const refusals = ++page.refusals;
    const opened = !page.gated;
    page.gated = true;
    const sessionId = key === a.session ? {} : { sessionId: key };
    const shown = () =>
      this.request(a, "cdp", {
        method: "Page.getNavigationHistory",
        params: {},
        ...sessionId,
      }).then((history) => {
        const entries = history.entries;
        const index = history.currentIndex;
        const entry: unknown =
          Array.isArray(entries) && typeof index === "number"
            ? entries[index]
            : undefined;
        const url =
          entry && typeof entry === "object"
            ? (entry as Fields).url
            : undefined;
        if (
          a.pages.get(key) !== page ||
          page.refusals !== refusals ||
          !page.gated ||
          typeof url !== "string" ||
          httpOrigin(url) === undefined ||
          this.officeRefused(a, url)
        )
          return;
        page.url = url;
        page.gated = false;
      });
    if (this.active && this.reachable(a))
      try {
        this.request(a, "cdp", {
          method: "Page.stopLoading",
          params: {},
          ...sessionId,
        })
          .then(shown)
          .catch(() => {});
      } catch {
        // check() failed: the grant has ended.
      }
    if (opened)
      for (const listener of [...(this.gateListeners.get(a.id) ?? [])])
        listener();
  }

  // A frame that waits for a client no client will resume stays blank, on the
  // member's screen as in every read. Like a capture kick, outside the action
  // fence.
  private resumeChild(a: Assignment, key: string): void {
    const child = a.children.get(key);
    if (!child?.waiting) return;
    child.waiting = false;
    this.unfenced(a, "Runtime.runIfWaitingForDebugger", key);
  }

  private unfenced(a: Assignment, method: string, key: string): void {
    if (!this.active || !this.reachable(a)) return;
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
      // The socket is gone: its close ends the connection.
      this.sendFailed(a, method);
    }
  }

  private pageId(a: Assignment): string | undefined {
    return a.pageId ?? (a.target?.targetId as string | undefined);
  }

  // A target as the client knows it: the tab by its main frame id, and a
  // popup the tab opened with that id as its opener.
  private clientTarget(a: Assignment, info: Fields): Fields {
    if (info === a.target) return { ...info, targetId: this.pageId(a) };
    if (a.target && info.openerId === a.target.targetId)
      return { ...info, openerId: this.pageId(a) };
    return info;
  }

  private announcePage(a: Assignment, sessionId: string, info: Fields): void {
    a.peer.send({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { ...this.clientTarget(a, info), attached: true },
        waitingForDebugger: false,
      },
    });
  }

  // The client's first look: the tab under its main frame id, then its
  // popups. The frame tree is the bridge's own command, outside the office
  // gate; a failed one keeps the id known so far.
  private async announceTab(a: Assignment): Promise<void> {
    const peer = a.peer;
    try {
      const result = await this.request(a, "cdp", {
        method: "Page.getFrameTree",
        params: {},
      });
      const id = fields(fields(result.frameTree).frame).id;
      if (typeof id === "string") a.pageId = id;
    } catch {}
    const state = a.state;
    if (a.peer !== peer || state.kind !== "attached" || !a.target) return;
    state.announced = true;
    this.announcePage(a, a.session, a.target);
    for (const [sessionId, target] of a.popups)
      this.announcePage(a, sessionId, target);
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
      key === a.session ? this.pageId(a) : a.popups.get(key)?.targetId;
    const mainDocument =
      params.type === "Document" && params.frameId === targetId;
    if (method === "Network.requestWillBeSent" && mainDocument) {
      // An app's sign-in hop through an office passes; the page that hop
      // answers with closes the gate at its response.
      const url = (params.request as Fields | undefined)?.url;
      if (
        typeof url === "string" &&
        this.officeRefused(a, url) &&
        !officeAppSignIn(url, this.offices.all())
      )
        this.closeGate(a, key);
    } else if (method === "Network.responseReceived" && mainDocument) {
      const url = (params.response as Fields | undefined)?.url;
      if (typeof url === "string" && this.officeRefused(a, url))
        this.closeGate(a, key);
    } else if (method === "Page.frameNavigated") {
      const frame = params.frame as Fields | undefined;
      if (!frame || frame.parentId !== undefined) return;
      if (key === a.session && typeof frame.id === "string")
        a.pageId = frame.id;
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
      !assignment?.target ||
      !this.accessible(assignment, agentId) ||
      assignment.state.kind !== "offered" ||
      this.pendingCount(assignment.id)
    )
      throw new Error(
        "Offer a tab with Allow agent control in the Chrome extension popup",
      );
    this.check(assignment);
    this.enter(assignment, ["offered"], { kind: "attached", announced: false });
    assignment.peer = peer;
    assignment.actor = agentId;
    assignment.autoAttached = new Set();
    assignment.world = { isolated: "none" };
    return {
      receive: (message) =>
        assignment.peer === peer && assignment.state.kind === "attached"
          ? this.dispatch(assignment, message, agentId, peer)
          : Promise.resolve(),
      close: () => {
        if (assignment.peer !== peer) return;
        if (!retainGrant) {
          this.release(assignment, "client_closed");
          return;
        }
        this.enter(assignment, ["attached"], { kind: "offered" });
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
    if (!a || a.state.kind === "released") return;
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
          mainFrameMoved: this.pageId(a) !== a.target?.targetId,
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
    this.enter(a, ["attached"], { kind: "offered" });
    a.retirements++;
    for (const key of a.children.keys()) this.resumeChild(a, key);
    peer.close();
  }

  /** The JavaScript dialogs open on the grant's pages and frames. Each one
   * blocks its page until the member or an action's client answers it. */
  openDialogs(grant: string): { type: string; message: string }[] {
    const a = this.assignments.get(grant);
    return a ? [...a.dialogs.values()].map((dialog) => ({ ...dialog })) : [];
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
    if (typeof context?.id !== "number" || aux?.frameId !== this.pageId(a))
      return;
    if (aux?.isDefault === true) world.main = context.id;
    else if (world.name !== undefined && context.name === world.name)
      world.utility = context.id;
  }

  /** Fences the grant's attached client while a timed-out action's work
   * settles. The fence ends at lift(), at ceilingMs (then onCeiling runs),
   * or when the client leaves (close, retire, recovery, release). */
  fence(grant: string, ceilingMs: number, onCeiling: () => void): ActionFence {
    const a = this.assignments.get(grant);
    const state = a?.state;
    if (!a || state?.kind !== "attached")
      return { held: () => false, lift() {} };
    state.fence?.cancel();
    const fence = { cancel() {} };
    const held = () => a.state === state && state.fence === fence;
    fence.cancel = this.clock.schedule(() => {
      if (!held()) return;
      state.fence = undefined;
      try {
        onCeiling();
      } catch (error) {
        console.error(
          "[browser-extension] " +
            JSON.stringify({
              reason: "fence_ceiling_failed",
              generation: this.generation,
              assignment: grant,
              error: error instanceof Error ? error.name : typeof error,
            }),
        );
      }
    }, ceilingMs);
    state.fence = fence;
    return {
      held,
      lift() {
        if (!held()) return;
        fence.cancel();
        state.fence = undefined;
      },
    };
  }

  fenced(grant: string): boolean {
    const state = this.assignments.get(grant)?.state;
    return state?.kind === "attached" && state.fence !== undefined;
  }

  isRecovering(grant: string): boolean {
    return this.assignments.get(grant)?.state.kind === "recovering";
  }

  async waitForRecovery(grant: string, maxMs: number): Promise<boolean> {
    const a = this.assignments.get(grant);
    if (!a) return false;
    if (a.state.kind === "recovering") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        a.state.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.reachable(a);
  }

  // Not released and not between debuggers.
  private reachable(a: Assignment): boolean {
    return a.state.kind !== "released" && a.state.kind !== "recovering";
  }

  // The only writer of a.state: it moves only from the kinds listed (the
  // table above GrantState) and says whether it moved.
  private enter(
    a: Assignment,
    from: readonly GrantKind[],
    next: GrantState,
  ): boolean {
    const prior = a.state;
    if (!from.includes(prior.kind)) return false;
    a.state = next;
    if (prior.kind === "attached") {
      prior.fence?.cancel();
      a.peer = noPeer();
    }
    if (prior.kind === "recovering") {
      clearTimeout(prior.timer);
      prior.finish();
    }
    return true;
  }

  private accessible(a: Assignment, agent: string): boolean {
    return (
      this.active &&
      this.ownerValid() &&
      (a.scope.kind === "office"
        ? this.reach(agent)
        : a.scope.kind === "shared"
          ? this.admits(agent)
          : a.scope.kind === "opened"
            ? a.scope.agentId === agent && this.authorized(a)
            : this.authorize(agent) &&
              (a.scope.kind === "all" || a.scope.agentId === agent))
    );
  }

  // The browser's access admits the agent: the member manages it, or reaches
  // it and the setting covers its manager.
  admits(agent: string): boolean {
    if (!this.ownerValid()) return false;
    if (this.authorize(agent)) return true;
    const { agents, members } = this.browserAccess;
    if (agents === "mine" || !this.reach(agent)) return false;
    if (agents === "office") return true;
    const manager = this.managerOf(agent);
    return manager !== undefined && members.includes(manager);
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
        this.release(a, "expired");
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
    const tier = routingTier(
      available,
      (a) => a.scope,
      () => true,
    );
    const chosen =
      target !== undefined
        ? available.find((a) => a.target === target)
        : tier.length === 1
          ? tier[0]
          : undefined;
    return chosen
      ? [...this.assignments.values()].find((a) => a.handle === chosen.target)
          ?.id
      : undefined;
  }

  ambiguous(agent: string): boolean {
    return (
      routingTier(
        this.targets(agent),
        (a) => a.scope,
        () => true,
      ).length > 1
    );
  }

  revoke(agentId: string, target?: string): void {
    const id = this.offered(agentId, target);
    const a = id ? this.assignments.get(id) : undefined;
    if (a) this.release(a, "revoked");
  }

  private authorized(a: Assignment): boolean {
    return this.scopeAuthorized(a.scope);
  }

  private scopeAuthorized(scope: BrowserGrantScope): boolean {
    if (!this.ownerValid()) return false;
    if (scope.kind === "agent") return this.authorize(scope.agentId);
    if (scope.kind !== "opened") return true;
    // An opened tab needs agent tabs on and the agent in the access.
    return this.browserAccess.openTabs && this.admits(scope.agentId);
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

  // An opened tab comes back only as a resume: no deadline and no pin.
  private openedResume(
    durationMinutes: BrowserGrantDuration,
    msg: Fields,
  ): Resume | null {
    return "expiresAt" in msg &&
      msg.expiresAt === null &&
      !("offerOrigin" in msg) &&
      durationMinutes === 0
      ? { expiresAt: null }
      : null;
  }

  private newAssignment(
    id: string,
    scope: BrowserGrantScope,
    durationMinutes: BrowserGrantDuration,
  ): Assignment {
    return {
      durationMinutes,
      expiresAt: null,
      id,
      scope,
      handle: offerHandle(this.credentialHash, id),
      session: crypto.randomUUID(),
      browserSession: crypto.randomUUID(),
      peer: noPeer(),
      retirements: 0,
      reattaches: 0,
      children: new Map(),
      popups: new Map(),
      pages: new Map(),
      childPages: new Map(),
      officeRefusals: 0,
      answersTooLarge: 0,
      state: { kind: "creating" },
      autoAttached: new Set(),
      dialogs: new Map(),
      world: { isolated: "none" },
    };
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
      // An opened tab comes back only as a resume (openedResume), and only
      // while the setting covers it.
      (scope.kind === "opened" && !this.scopeAuthorized(scope)) ||
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
    const a = this.newAssignment(id, scope, durationMinutes);
    this.assignments.set(id, a);
    await this.establish(a, "attach", {}, resume);
  }

  // Attaches a new grant through the extension's attach (a member's offer or
  // its resume) or open (a tab an agent opens), then answers offered. A
  // failure releases the grant and returns the error.
  private async establish(
    a: Assignment,
    method: "attach" | "open",
    params: Fields,
    resume?: Resume,
  ): Promise<CommandFailedError | Error | undefined> {
    const { id, scope, durationMinutes } = a;
    const opened = scope.kind === "opened";
    // Where the offer failed, for the log.
    let stage: "attach" | "target" | "start" = "attach";
    try {
      const result = await this.request(a, method, params);
      stage = "target";
      this.check(a);
      const target = fields(result.targetInfo);
      if (
        target.type !== "page" ||
        typeof target.targetId !== "string" ||
        typeof target.url !== "string" ||
        !(opened
          ? openedPageAllowed(target.url)
          : /^https?:\/\//.test(target.url)) ||
        this.knownTarget(target.targetId)
      )
        throw new Error("Invalid offered target");
      a.target = target;
      stage = "start";
      // A resumed offer keeps its first pin: a tab that moved onto an office
      // page while the office was away starts behind the gate. An opened tab
      // has no pin, so every office page is behind the gate.
      a.offerOrigin = opened
        ? undefined
        : resume
          ? resume.offerOrigin
          : httpOrigin(target.url);
      a.pages.set(a.session, {
        url: target.url,
        gated: this.officeRefused(a, target.url),
        refusals: 0,
      });
      this.enter(a, ["creating"], { kind: "offered" });
      a.expiresAt = resume
        ? resume.expiresAt
        : durationMinutes === 0
          ? null
          : this.clock.now() + durationMinutes * 60_000;
      this.check(a);
      if (a.expiresAt !== null)
        a.cancelExpiry = this.clock.schedule(() => {
          if (this.assignments.get(id) === a) this.release(a, "expired");
        }, a.expiresAt - this.clock.now());
      this.peer.send({
        kind: "offered",
        generation: this.generation,
        assignment: id,
        scope,
        durationMinutes,
        expiresAt: a.expiresAt,
        ...(a.offerOrigin === undefined ? {} : { offerOrigin: a.offerOrigin }),
      });
      console.info(
        "[browser-extension] " +
          JSON.stringify({
            reason: "grant_started",
            generation: this.generation,
            assignment: id,
            controlSession: a.session,
            resumed: resume !== undefined,
            ...(opened ? { opened: true } : {}),
          }),
      );
      this.sendMetadata();
      return undefined;
    } catch (error) {
      this.release(a, "offer_failed", {
        stage,
        ...(error instanceof CommandFailedError && error.attachReason
          ? { attachReason: error.attachReason }
          : {}),
      });
      if (this.active)
        this.peer.send({
          kind: "offered",
          generation: this.generation,
          assignment: id,
          error: true,
        });
      return error instanceof Error ? error : new Error("Open failed");
    }
  }

  revalidate(): void {
    for (const a of [...this.assignments.values()])
      if (!this.authorized(a)) this.release(a, "revalidate_unauthorized");
      else if (this.expired(a)) this.release(a, "revalidate_expired");
      else this.cutActor(a, "revalidate_unauthorized");
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
      members: this.pickable(),
      ...(this.shares ? { shareAgents: this.shareAgents() } : {}),
      assignments: [...this.assignments.values()]
        .filter((a) => a.target && this.authorized(a))
        .map((a) => ({
          id: a.id,
          scope: a.scope,
          ...(a.scope.kind === "agent" || a.scope.kind === "opened"
            ? { agent: this.agentDisplay!(a.scope.agentId) }
            : {}),
          durationMinutes: a.durationMinutes,
          expiresAt: a.expiresAt,
        })),
    });
  }

  // The agents the member can share a page with: every agent they reach, by
  // room name, then agent name.
  private shareAgents(): ShareAgent[] {
    return this.agents()
      .filter((agent) => this.reach(agent))
      .map((agent) => ({
        ...this.agentDisplay!(agent),
        room: this.shares!.room(agent),
      }))
      .sort(
        (a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name),
      );
  }

  // Delivers a shared page to an agent the member reaches, and answers the
  // extension. The agent gets the message only, never the tab.
  private async share(msg: Fields): Promise<void> {
    const id = msg.id as string;
    let error: string | undefined;
    const url = shareableUrl(msg.url);
    if (
      typeof msg.agentId !== "string" ||
      url === undefined ||
      typeof msg.title !== "string" ||
      (msg.selection !== undefined && typeof msg.selection !== "string")
    )
      error = "invalid_share";
    else if (!this.reach(msg.agentId)) error = "agent_unavailable";
    else
      try {
        const result = await this.shares!.deliver(
          msg.agentId,
          formatSharedPage({
            url,
            title: msg.title,
            ...(msg.selection === undefined
              ? {}
              : { selection: msg.selection }),
          }),
        );
        if (!result.ok) error = result.code;
      } catch {
        error = "share_failed";
      }
    if (!this.active) return;
    try {
      this.peer.send({
        kind: "shareResult",
        generation: this.generation,
        id,
        ...(error === undefined ? {} : { error }),
      });
    } catch {
      // The connection ends on its own; the popup's deadline answers.
    }
  }

  // The members the member may pick: those who manage an agent the member
  // reaches, and every member already picked.
  private pickable(): BrowserDisplay[] {
    const ids = new Set<string>();
    for (const agent of this.agents()) {
      const manager = this.managerOf(agent);
      if (
        manager !== undefined &&
        manager !== this.memberId &&
        this.reach(agent)
      )
        ids.add(manager);
    }
    for (const member of this.browserAccess.members)
      if (member !== this.memberId) ids.add(member);
    const display =
      this.otherMemberDisplay ?? ((id: string) => ({ id, name: id }));
    return [...ids].map(display).sort((a, b) => a.name.localeCompare(b.name));
  }

  private expired(a: Assignment): boolean {
    return a.expiresAt !== null && this.clock.now() >= a.expiresAt;
  }

  // Why a grant cannot take a message from the extension.
  private refusal(a: Assignment): ReleaseCause {
    return this.authorized(a) ? "message_expired" : "message_unauthorized";
  }

  private check(a: Assignment): void {
    if (
      !this.active ||
      a.state.kind === "released" ||
      this.expired(a) ||
      this.assignments.get(a.id) !== a ||
      !this.authorized(a)
    ) {
      this.release(a, "check_failed");
      throw new Error("Browser control ended; pending outcomes may be unknown");
    }
  }

  // Mutes or unmutes every page of the grant; resolves to the state the
  // extension set.
  async mute(grant: string, muted: boolean): Promise<boolean> {
    const a = this.assignments.get(grant);
    if (!a) throw new Error("Browser control ended");
    const result = await this.request(a, "mute", { muted });
    return result.muted === true;
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
    if (a.state.kind === "recovering")
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
        if (method === "attach" || method === "open") {
          this.release(a, "attach_timeout");
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
        method: this.pendingMethod(method, params),
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
        // Only this command fails. A socket that is gone ends the connection
        // through its close.
        this.pending.delete(id);
        clearTimeout(timer);
        settled();
        this.sendFailed(a, this.pendingMethod(method, params));
        reject(new Error("Browser command was not sent"));
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

  /** A parsed extension message over EXTENSION_MAX_BYTES: fails only the
   * command it answers (task f63edd81). An event goes on trimmed, or ends
   * only its grant (task a42c729b). */
  receiveOversized(
    message: unknown,
    bytes: number,
    source?: "extension",
  ): void {
    if (!this.active) return;
    let msg: Fields;
    try {
      msg = fields(message);
    } catch {
      this.close("too_large", { bytes });
      return;
    }
    if (msg.generation !== this.generation) return;
    const event = msg.kind === "event" && typeof msg.assignment === "string";
    let trimmed: Fields | undefined;
    try {
      if (event) trimmed = trimOversizedEvent(msg);
    } catch {
      // A value too deep to walk ends only its grant, below.
    }
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          reason: "too_large",
          generation: this.generation,
          ...envelope(msg),
          bytes,
          ...(source ? { source } : {}),
          ...(event ? { action: trimmed ? "trimmed" : "ended" } : {}),
        }),
    );
    if (msg.kind === "result" && typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.settled();
      const owner = this.assignments.get(pending.assignment);
      if (owner) owner.answersTooLarge++;
      if (!pending.timedOut)
        pending.reject(new Error("Browser answer too large to relay"));
      // After the answer: a listener that throws cannot leave the command
      // unanswered, and it ends nothing.
      if (owner)
        for (const listener of [
          ...(this.tooLargeListeners.get(owner.id) ?? []),
        ])
          try {
            listener();
          } catch (error) {
            console.info(
              "[browser-extension] " +
                JSON.stringify({
                  reason: "listener_failed",
                  generation: this.generation,
                  assignment: owner.id,
                  errorName: error instanceof Error ? error.name : typeof error,
                }),
            );
          }
      return;
    }
    if (event) {
      if (trimmed) return this.receive(trimmed);
      const a = this.assignments.get(msg.assignment as string);
      if (a) this.fault(a, "too_large");
      return;
    }
    this.close("too_large", { bytes, ...envelope(msg) });
  }

  receive(message: unknown): void {
    if (!this.active) return;
    // The grant the message belongs to, once known. A fault after that ends
    // only this grant; one before it ends the connection.
    let owned: Assignment | undefined;
    let msg: Fields | undefined;
    try {
      msg = fields(message);
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
          msg.scope.kind === "opened"
            ? this.openedResume(msg.durationMinutes, msg)
            : "expiresAt" in msg || "offerOrigin" in msg
              ? this.resumeOf(
                  msg.durationMinutes,
                  msg.expiresAt,
                  msg.offerOrigin,
                )
              : undefined;
        void this.offer(msg.assignment, msg.scope, msg.durationMinutes, resume);
        return;
      }
      if (msg.kind === "agents") {
        this.revalidate();
        return;
      }
      if (msg.kind === "agentTabs") {
        if (!validAgentTabsScope(msg.scope))
          throw new Error("Invalid agent tabs setting");
        this.setAgentTabs(msg.scope);
        return;
      }
      if (msg.kind === "access") {
        if (!validBrowserAccess(msg.access))
          throw new Error("Invalid access setting");
        this.setAccess(msg.access);
        return;
      }
      if (msg.kind === "share") {
        // A share with no id cannot be answered; the popup's deadline does.
        if (
          this.shares &&
          typeof msg.id === "string" &&
          /^[\w-]{1,64}$/.test(msg.id)
        )
          void this.share(msg);
        return;
      }
      if (msg.kind === "files") {
        if (!validExtensionPackage(msg.package))
          throw new Error("Invalid files package");
        this.files = msg.package;
        return;
      }
      if (msg.kind === "result" && typeof msg.id === "number") {
        const kick = this.kicks.get(msg.id);
        if (kick !== undefined) {
          this.kicks.delete(msg.id);
          // An extension before 0.7.2 refuses the kick.
          if (msg.error)
            console.info(
              "[browser-extension] " +
                JSON.stringify({
                  reason: "capture_kick_failed",
                  generation: this.generation,
                  assignment: kick,
                }),
            );
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        const owner = this.assignments.get(pending.assignment);
        if (!owner) return;
        owned = owner;
        if (!this.authorized(owner) || this.expired(owner)) {
          this.release(owner, this.refusal(owner));
          return;
        }
        this.check(owner);
        // An answer the extension did not send because it was over the cap.
        if (
          msg.error &&
          Number.isSafeInteger(msg.tooLarge) &&
          (msg.tooLarge as number) > EXTENSION_MAX_BYTES
        ) {
          this.receiveOversized(msg, msg.tooLarge as number, "extension");
          return;
        }
        const result = msg.error ? undefined : fields(msg.result);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.settled();
        if (pending.timedOut) return;
        if (msg.error) pending.reject(new CommandFailedError(msg.reason));
        else pending.resolve(result!);
        return;
      }
      if (msg.kind !== "event" || typeof msg.assignment !== "string")
        throw new Error("Invalid event");
      const a = this.assignments.get(msg.assignment);
      if (!a) return;
      owned = a;
      if (!this.authorized(a) || this.expired(a)) {
        this.release(a, this.refusal(a));
        return;
      }
      this.check(a);
      if (msg.method === "recovering") {
        if (a.state.kind === "recovering") {
          this.release(a, "recovery_unexpected");
          return;
        }
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        a.reattaches++;
        // Retire only this CDP client. Its close cannot revoke the retained
        // grant, and late results cannot enter the next client session.
        const peer = a.peer;
        this.enter(a, ["creating", "offered", "attached"], {
          kind: "recovering",
          done,
          finish,
          timer: setTimeout(
            () => this.release(a, "recovery_timeout"),
            BROWSER_REATTACH_MS,
          ),
        });
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
        if (!this.enter(a, ["recovering"], { kind: "offered" }))
          this.release(a, "recovery_unexpected");
        return;
      }
      if (msg.method === "detached") {
        this.release(a, "extension_detached", extensionCause(msg.params));
        return;
      }
      if (
        a.state.kind === "recovering" ||
        !a.target ||
        typeof msg.method !== "string"
      )
        return;
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
          refusals: 0,
        });
        if (typeof target.url === "string" && this.officeRefused(a, target.url))
          this.closeGate(a, params.sessionId);
        // Until the client knows the tab, the announce sends the popup after
        // it.
        if (a.state.kind === "attached" && a.state.announced)
          this.announcePage(a, params.sessionId, target);
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
        this.deliver(a, {
          method: "Target.detachedFromTarget",
          params: { sessionId: params.sessionId, targetId: popup.targetId },
        });
        return;
      }

      // Every screencast is a capture kick's, which no client asked for.
      if (
        msg.method === "Page.screencastFrame" ||
        msg.method === "Page.screencastVisibilityChanged"
      )
        return;
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
        const attached = a.state.kind === "attached";
        if (!attached || !a.autoAttached.has(parent)) {
          if (!attached) this.resumeChild(a, params.sessionId);
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
      this.deliver(a, {
        method: msg.method,
        params,
        sessionId: child || a.session,
      });
    } catch (error) {
      const detail = {
        ...(msg ? envelope(msg) : {}),
        errorName: error instanceof Error ? error.name : typeof error,
      };
      if (!owned) this.close("receive_error", detail);
      else if (owned.state.kind !== "released")
        this.fault(owned, "receive_error", detail);
    }
  }

  // Hands an event to the grant's agent client. A client that throws on it
  // retires; the grant and the connection stay.
  private deliver(a: Assignment, message: Fields): void {
    try {
      a.peer.send(message);
    } catch {
      this.retireClient(a.id, "client_error");
    }
  }

  // Ends one grant after a fault in its own messages. If that fails too, the
  // connection ends.
  private fault(a: Assignment, cause: ReleaseCause, detail: Fields = {}): void {
    try {
      this.release(a, cause, detail);
    } catch {
      this.close(cause, detail);
    }
  }

  private sendFailed(a: Assignment, method: string): void {
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          reason: "send_failed",
          generation: this.generation,
          assignment: a.id,
          method,
        }),
    );
  }

  private pendingMethod(method: string, params: Fields): string {
    return method === "cdp" && typeof params.method === "string"
      ? params.method
      : method;
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
      this.release(a, "bad_client_message");
      return;
    }
    const { id, method, sessionId } = msg;
    if (!Number.isSafeInteger(id) || typeof method !== "string") {
      this.release(a, "bad_client_message");
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
      // A refusal can come before the first await, inside the client's own
      // send: its callback for this id exists only once that send returns.
      queueMicrotask(() => {
        if (this.active && a.state.kind !== "released" && a.peer === peer)
          try {
            peer.send({
              id,
              sessionId,
              error: {
                code: -32000,
                message: "Browser command refused or failed",
              },
            });
          } catch {}
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
          // Chrome answers after its attach events, so the result waits for
          // the announce.
          if (a.target && a.state.kind === "attached" && !a.state.announced)
            await (a.state.announcing ??= this.announceTab(a));
          return {};
        case "Target.getTargets":
          return {
            targetInfos: a.target
              ? [a.target, ...a.popups.values()].map((info) =>
                  this.clientTarget(a, info),
                )
              : [],
          };
        case "Target.getTargetInfo":
          if (
            params.targetId !== undefined &&
            params.targetId !== this.pageId(a)
          )
            throw new Error("Unknown target");
          return a.target ? { targetInfo: this.clientTarget(a, a.target) } : {};
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
      const info = a.popups.get(sessionId) ?? a.target;
      if (
        params.targetId !== undefined &&
        params.targetId !== this.clientTarget(a, info).targetId
      )
        throw new Error("Unknown target");
      return { targetInfo: this.clientTarget(a, info) };
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
      params.frameId === this.pageId(a)
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
    // Chrome's Closed event and this result reach the bridge on separate
    // channels: an answered dialog leaves the list before the client goes on.
    // The page's next dialog can open before the result, and stays listed.
    if (method === "Page.handleJavaScriptDialog") {
      const answered = a.dialogs.get(sessionId);
      const result = await this.request(a, "cdp", {
        method,
        params,
        sessionId: target,
      });
      if (a.dialogs.get(sessionId) === answered) a.dialogs.delete(sessionId);
      return result;
    }
    if (method === "Target.setAutoAttach") {
      const peer = a.peer;
      const result = await this.request(a, "cdp", {
        method,
        params,
        sessionId: target,
      });
      // In the same step as the result, so no attach falls in between.
      if (a.peer === peer && a.state.kind === "attached")
        this.announceChildren(a, sessionId);
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
      if (page && typeof url === "string" && a.state.kind !== "released") {
        page.url = url;
        if (this.officeRefused(a, url)) this.closeGate(a, sessionId);
      }
      return result;
    }
    if (method !== "Page.captureScreenshot")
      return this.request(a, "cdp", { method, params, sessionId: target });
    let capture: number | undefined;
    const result = this.request(
      a,
      "cdp",
      { method, params, sessionId: target },
      (id) => {
        capture = id;
      },
    );
    // Playwright captures on the page's session; the extension refuses a
    // kick on a frame session.
    if (capture !== undefined && !a.children.has(sessionId))
      this.kickCapture(
        a,
        capture,
        target,
        params.captureBeyondViewport === true,
      );
    return result;
  }

  // The kick is one screencast start on the capture's session and, once the
  // capture settles (its answer, a drop or the client's retirement, not the
  // client's timeout: Chrome still runs it), one stop. Both are outside
  // this.pending and the action fence, because a kick only makes Chrome draw
  // the tab, and a kick that gets no answer must not hold the next action.
  private kickCapture(
    a: Assignment,
    capture: number,
    sessionId: string | undefined,
    fullPage: boolean,
  ): void {
    const pending = this.pending.get(capture);
    if (!pending) return;
    let started: number | undefined;
    const cancel = this.clock.schedule(() => {
      if (this.pending.get(capture) !== pending) return;
      try {
        this.check(a);
      } catch {
        return;
      }
      if (a.state.kind === "recovering") return;
      const id = this.sendKick(
        a,
        "Page.startScreencast",
        { ...SCREENCAST_KICK_PARAMS },
        sessionId,
      );
      if (id === undefined) return;
      started = a.reattaches;
      this.kicks.set(id, a.id);
      console.info(
        "[browser-extension] " +
          JSON.stringify({
            reason: "capture_kicked",
            generation: this.generation,
            assignment: a.id,
            session: sessionId === undefined ? "main" : "popup",
            fullPage,
          }),
      );
    }, CAPTURE_KICK_MS);
    void pending.done.then(() => {
      cancel();
      // A reattach, a release or a closed popup already ended the screencast.
      if (
        started !== a.reattaches ||
        !this.active ||
        !this.reachable(a) ||
        (sessionId !== undefined && !a.popups.has(sessionId))
      )
        return;
      this.sendKick(a, "Page.stopScreencast", {}, sessionId);
    });
  }

  private sendKick(
    a: Assignment,
    method: string,
    params: Fields,
    sessionId: string | undefined,
  ): number | undefined {
    const id = ++this.sequence;
    try {
      this.peer.send({
        kind: "command",
        generation: this.generation,
        id,
        assignment: a.id,
        method: "cdp",
        params: { method, params, sessionId },
      });
    } catch {
      this.sendFailed(a, method);
      return undefined;
    }
    return id;
  }

  private release(
    a: Assignment,
    cause: ReleaseCause,
    detail: Fields = {},
  ): void {
    if (a.state.kind === "released") return;
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          ...detail,
          reason: "grant_released",
          generation: this.generation,
          assignment: a.id,
          controlSession: a.session,
          pending: this.pendingCount(a.id),
          cause,
        }),
    );
    const peer = a.peer;
    this.enter(a, LIVE, { kind: "released" });
    this.endLeaves(a);
    a.cancelExpiry?.();
    this.assignments.delete(a.id);
    for (const [id, owner] of this.kicks)
      if (owner === a.id) this.kicks.delete(id);
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
          // Only the agent's own close closes a tab it opened.
          params: { close: cause === "revoked" },
        });
      } catch {}
    }
    peer.close();
    this.sendMetadata();
  }

  /** Ends the connection and every grant on it. cause and detail go to the
   * log line; detail never carries page content. */
  close(cause = "closed", detail: Fields = {}): void {
    if (!this.active) return;
    this.active = false;
    console.info(
      "[browser-extension] " +
        JSON.stringify({
          ...detail,
          reason: "connection_ended",
          generation: this.generation,
          cause,
        }),
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.settled();
      pending.reject(
        new Error("Browser disconnected; pending outcomes may be unknown"),
      );
    }
    this.pending.clear();
    for (const a of this.assignments.values())
      this.release(a, "connection_closed");
    this.stopLearning();
    this.onClose();
    this.peer.close();
  }
}
